// Generate subtitles for the video that is currently playing.
//
// Two workers and a ceiling between them. The audio decode worker runs as fast
// as the CPU allows but parks against a pull ceiling; the ASR worker
// (Parakeet) reports how far it has actually got. Setting the ceiling from
// those two numbers is the whole flow-control story: in "stream" mode it
// tracks the playhead, in "all" mode it tracks the transcript, and either way
// audio never piles up in memory faster than it is consumed.
//
// Running ahead rather than transcribing the whole file up front is what makes
// streaming usable: subtitles appear seconds after you press the button
// instead of after a full-file pass, and stopping playback stops the work.
//
// TRANSCRIPTION AND TRANSLATION ARE SEPARATE STEPS, on purpose. They used to
// be one: every cue went straight from the speech model into a second model
// before it could be shown, which made the first subtitle appear late, made
// every re-run pay for both models, and left no way to tell which of the two
// produced a bad line. Now transcribing saves its text (subtitleCache.ts) and
// translating reads it back -- so "translate this again, into something else"
// costs one LLM pass over stored text and never touches the audio.

import { observable, runInAction } from "mobx";
import { SubtitleCue } from "../player/subtitles";
import { SubtitleGenModel, subtitleGenWebGpu } from "../appState";
import { createAudioWorkerChannel, AudioWorkerJob } from "../player/AudioWorkerClient";
import { AsrWord } from "./asr";
import { AsrJob, startAsrJob } from "./AsrWorkerClient";
import { SPEECH_MODEL } from "./models";
import { deleteGeneration, loadGeneration, SavedGeneration, saveTranscript, saveTranslation } from "./subtitleCache";
import { Translator } from "./translate";

// How far ahead of the playhead (stream) or the transcript (all) we let the
// decoder run. Comfortably more than the ASR worker's 20 s window, so there is
// always a full window waiting; small enough that we are not decoding a whole
// film into memory when the user watches two minutes and quits.
const RUN_AHEAD_SEC = 45;

// Silence longer than this ends a cue.
const CUE_GAP_SEC = 0.8;
// Cues also break on length, so a monologue does not become one 40-second cue.
const CUE_MAX_SEC = 6;
const CUE_MAX_CHARS = 84;

export type GenPhase = "idle" | "loading" | "running" | "done" | "error";

export interface GenState {
    phase: GenPhase;
    message: string;
    // 0..1 while the model is downloading, undefined when there is nothing
    // meaningful to show. The speech model is a ~456 MB download, so a bare
    // "Loading..." with no bar reads as a hang for several minutes.
    progress: number | undefined;
    // Video this is for; lets the UI ignore state left over from another file.
    key: string | undefined;
    // Media time actually FED THROUGH the recogniser -- not merely decoded.
    // Those are very different numbers when something is broken, and conflating
    // them is how this shipped claiming "30s ahead" while transcribing nothing.
    processedToSec: number;
    playheadSec: number;
    durationSec: number;

    // The two texts, side by side and both kept. `transcript` is what the
    // speech model heard; `translation` is a second model's rendering of it.
    // Neither is derived from the other at display time -- translating again
    // rewrites `translation` and leaves `transcript` exactly as it was.
    transcript: SubtitleCue[];
    translation: SubtitleCue[];
    translatedLanguage: string | undefined;
    // Which of the two the player shows. See genCues().
    showing: "transcript" | "translation";

    // The transcript reaches both ends of the file. Streaming runs usually do
    // not, and translating the middle third of a film is not what anyone means
    // by "translate this".
    complete: boolean;
    // Span of the file the transcript covers, for the readout and for deciding
    // whether a new run is worth saving over an older, wider one.
    fromSec: number;

    // These cues have been ASKED for -- by generating, translating, or picking
    // them in the menu. Cues merely restored from disk start unpinned, so a
    // video that also has a real subtitle track keeps showing that track.
    pinned: boolean;

    translating: boolean;
    // 0..1 through the transcript while translating.
    translateProgress: number | undefined;
    error: string | undefined;
    // Which way the current run was started. The readouts differ: streaming
    // cares about the lead over the playhead, "all" cares about how far through
    // the file it is.
    mode: "stream" | "all";
}

function blankGenState(): GenState {
    return {
        phase: "idle",
        message: "",
        progress: undefined,
        key: undefined,
        processedToSec: 0,
        playheadSec: 0,
        durationSec: 0,
        transcript: [],
        translation: [],
        translatedLanguage: undefined,
        showing: "transcript",
        complete: false,
        fromSec: 0,
        pinned: false,
        translating: false,
        translateProgress: undefined,
        error: undefined,
        mode: "stream",
    };
}

export const genState = observable<GenState>(blankGenState());

// The cues the player should show for the generated track: the translation
// when there is one and it is selected, otherwise the raw transcript.
export function genCues(): SubtitleCue[] {
    if (genState.showing === "translation" && genState.translation.length) return genState.translation;
    return genState.transcript;
}

export function showGenerated(which: "transcript" | "translation"): void {
    runInAction(() => {
        genState.showing = which;
        genState.pinned = true;
    });
}

// Mark the generated cues as the ones the viewer wants on screen, ahead of any
// track the video ships with.
export function pinGenerated(): void {
    runInAction(() => { genState.pinned = true; });
}

function cuesFromWords(words: AsrWord[]): SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    let cur: AsrWord[] = [];
    const flush = () => {
        if (!cur.length) return;
        cues.push({
            startMs: Math.round(cur[0].start * 1000),
            endMs: Math.round(cur[cur.length - 1].end * 1000),
            text: cur.map(w => w.word).join(" "),
        });
        cur = [];
    };
    for (const w of words) {
        if (cur.length) {
            const gap = w.start - cur[cur.length - 1].end;
            const span = w.end - cur[0].start;
            const chars = cur.reduce((n, x) => n + x.word.length + 1, 0);
            if (gap > CUE_GAP_SEC || span > CUE_MAX_SEC || chars > CUE_MAX_CHARS) flush();
        }
        cur.push(w);
    }
    flush();
    return cues;
}

class SubtitleGenerator {
    private channel = createAudioWorkerChannel("subtitleGen");
    private job: AudioWorkerJob | undefined;
    private asr: AsrJob | undefined;
    private pullTimer: ReturnType<typeof setInterval> | undefined;
    private pendingWords: AsrWord[] = [];
    private stopped = false;
    private runToken = 0;

    async start(opts: {
        key: string;
        blob: Blob;
        startSec: number;
        durationSec: number;
        getPlayheadSec: () => number;
        // "stream" keeps ahead of the playhead and stops when you do. "all"
        // transcribes the whole file as fast as the machine manages, which is
        // what you want when the point is to get a transcript rather than to
        // watch something right now.
        mode: "stream" | "all";
    }): Promise<void> {
        this.stop();
        this.stopped = false;
        const token = ++this.runToken;
        const fromSec = opts.mode === "all" ? 0 : opts.startSec;

        runInAction(() => {
            Object.assign(genState, blankGenState(), {
                phase: "loading",
                message: "Starting...",
                key: opts.key,
                processedToSec: fromSec,
                playheadSec: opts.startSec,
                mode: opts.mode,
                durationSec: opts.durationSec,
                fromSec,
                // Asked for explicitly, so these win over whatever track the
                // video ships with.
                pinned: true,
            } satisfies Partial<GenState>);
        });

        try {
            this.asr = startAsrJob(subtitleGenWebGpu.get(), {
                onWords: (words, processedToSec) => {
                    if (this.stopped || token !== this.runToken) return;
                    runInAction(() => {
                        if (genState.phase === "loading") {
                            genState.phase = "running";
                            genState.message = "Transcribing";
                            genState.progress = undefined;
                        }
                        // Advanced only from the ASR worker's own report, after
                        // the audio genuinely reached the model. This number is
                        // the feature's only honest progress signal and must
                        // never report decoder progress instead.
                        genState.processedToSec = Math.max(genState.processedToSec, processedToSec);
                    });
                    this.onWords(words, token);
                },
                onDrained: processedToSec => {
                    if (this.stopped || token !== this.runToken) return;
                    this.emitCues(true, token);
                    runInAction(() => {
                        genState.phase = "done";
                        genState.message = "Reached end of audio";
                        genState.progress = undefined;
                        genState.processedToSec = Math.max(processedToSec, genState.durationSec);
                        genState.complete = genState.fromSec <= 2 && genState.transcript.length > 0;
                    });
                    void this.persist(opts.key, token);
                },
                onProgress: (message, fraction) => runInAction(() => {
                    if (token !== this.runToken) return;
                    genState.message = message;
                    genState.progress = fraction;
                }),
                onError: err => this.fail(err, token),
            });

            this.job = this.channel.startJob({
                blob: opts.blob,
                startSec: fromSec,
                initialUntilSec: fromSec + RUN_AHEAD_SEC,
                onSample: p => this.asr?.pcm(p),
                // Not "done" yet: the ASR worker still holds up to a window of
                // audio it has not transcribed. flush() drains it and answers
                // with onDrained.
                onEnded: () => {
                    if (token !== this.runToken) return;
                    this.asr?.flush();
                    runInAction(() => { genState.message = "Finishing last lines..."; });
                },
                onError: err => this.fail(err, token),
            });

            // Keep raising the ceiling. In "stream" mode it follows the
            // playhead; in "all" mode there is no playhead worth following, so
            // it follows the transcript -- which is also what stops a two-hour
            // film from being decoded into memory all at once.
            this.pullTimer = setInterval(() => {
                if (this.stopped || token !== this.runToken) return;
                const head = opts.getPlayheadSec();
                runInAction(() => { genState.playheadSec = head; });
                this.job?.pull(
                    (opts.mode === "all" ? genState.processedToSec : head) + RUN_AHEAD_SEC);
            }, 500);
        } catch (e: any) {
            this.fail(e, token);
        }
    }

    // Write the finished transcript to disk. Failing to save is worth saying
    // out loud but must not turn a good transcript into an error state -- the
    // cues are on screen either way.
    private async persist(key: string, token: number): Promise<void> {
        const cues = genState.transcript;
        if (!cues.length) return;
        try {
            const saved = await saveTranscript(key, {
                cues,
                model: SPEECH_MODEL.dir,
                fromSec: genState.fromSec,
                toSec: genState.processedToSec,
                durationSec: genState.durationSec,
            });
            if (token !== this.runToken) return;
            if (!saved) {
                console.log("[subtitleGen] kept the saved transcript: it covers more of the file than this run");
            }
        } catch (e) {
            console.warn("[subtitleGen] could not save the transcript:", e);
        }
    }

    private onWords(words: AsrWord[], token: number): void {
        if (this.stopped || token !== this.runToken) return;
        this.pendingWords.push(...words);
        this.emitCues(false, token);
    }

    // `final` releases the trailing cue too. Normally it is held back because
    // more words may still extend it; at end of audio nothing more is coming,
    // and holding it would silently drop the last line of the film.
    private emitCues(final: boolean, token: number): void {
        const cues = cuesFromWords(this.pendingWords);
        const ready = final ? cues : cues.slice(0, Math.max(0, cues.length - 1));
        if (!ready.length) return;
        const consumed = ready.reduce((n, c) => n + c.text.split(" ").length, 0);
        this.pendingWords = this.pendingWords.slice(consumed);
        runInAction(() => {
            if (token !== this.runToken) return;
            genState.transcript = [...genState.transcript, ...ready];
        });
    }

    private fail(err: Error, token: number): void {
        if (token !== this.runToken) return;
        console.error("[subtitleGen] failed:", err);
        this.stop();
        runInAction(() => {
            genState.phase = "error";
            genState.error = err.message || String(err);
            genState.message = "Failed";
        });
    }

    stop(): void {
        this.stopped = true;
        this.runToken++;
        if (this.pullTimer !== undefined) clearInterval(this.pullTimer);
        this.pullTimer = undefined;
        this.job?.stop();
        this.job = undefined;
        // The worker keeps its model loaded on purpose -- stopping a run only
        // abandons the job, so pressing Generate again is instant.
        this.asr?.stop();
        this.asr = undefined;
        this.pendingWords = [];
    }
}

export const subtitleGenerator = new SubtitleGenerator();

export function stopSubtitleGeneration(): void {
    subtitleGenerator.stop();
    stopTranslation();
    runInAction(() => {
        if (genState.phase === "running" || genState.phase === "loading") {
            genState.phase = "idle";
            genState.message = "Stopped";
        }
    });
}

// ---------------------------------------------------------------------------
// Translation, as its own step over an already-stored transcript.

let translateToken = 0;

export function stopTranslation(): void {
    translateToken++;
    runInAction(() => {
        genState.translating = false;
        genState.translateProgress = undefined;
    });
}

// Translate the whole transcript from scratch, into `targetLanguageName`.
//
// From scratch every time, deliberately: there is no partial-translation state
// to resume, target languages change, and a stale half-translation mixed with
// fresh lines is worse than either. The transcript itself is read from memory
// (or disk) and never regenerated.
export async function translateGeneratedSubtitles(opts: {
    key: string;
    targetLanguage: string;
    targetLanguageName: string;
    modelKey: SubtitleGenModel;
}): Promise<void> {
    if (genState.key !== opts.key || !genState.transcript.length) return;
    stopTranslation();
    const token = ++translateToken;
    const source = genState.transcript;

    runInAction(() => {
        genState.translating = true;
        // Stays undefined until the first line comes back: while the model is
        // still downloading, "0%" would claim translation had begun.
        genState.translateProgress = undefined;
        genState.translation = [];
        genState.translatedLanguage = opts.targetLanguage;
        genState.showing = "translation";
        genState.pinned = true;
        genState.error = undefined;
        genState.message = `Loading ${opts.targetLanguageName} translation model...`;
    });

    try {
        const translator = await Translator.create(
            opts.modelKey, opts.targetLanguageName,
            (msg, fraction) => runInAction(() => {
                if (token !== translateToken) return;
                genState.message = msg;
                genState.progress = fraction;
            }));
        if (token !== translateToken) return;
        runInAction(() => { genState.progress = undefined; });

        const out: SubtitleCue[] = [];
        for (let i = 0; i < source.length; i++) {
            if (token !== translateToken) return;
            out.push({ ...source[i], text: await translator.translate(source[i].text) });
            // Publish as we go: a two-hour film is thousands of LLM calls, and
            // watching the lines arrive is the difference between "working" and
            // "hung".
            runInAction(() => {
                if (token !== translateToken) return;
                genState.translation = [...out];
                genState.translateProgress = (i + 1) / source.length;
                genState.message = `Translating to ${opts.targetLanguageName}`;
            });
        }
        if (token !== translateToken) return;

        runInAction(() => {
            genState.translating = false;
            genState.translateProgress = undefined;
            genState.message = `Translated to ${opts.targetLanguageName}`;
        });
        try {
            await saveTranslation(opts.key, {
                cues: out,
                language: opts.targetLanguage,
                model: opts.modelKey,
            });
        } catch (e) {
            console.warn("[subtitleGen] could not save the translation:", e);
        }
    } catch (e: any) {
        if (token !== translateToken) return;
        console.error("[subtitleGen] translation failed:", e);
        runInAction(() => {
            genState.translating = false;
            genState.translateProgress = undefined;
            // The transcript is still good, so this is not a failure of the
            // whole feature -- fall back to showing what was heard.
            genState.showing = "transcript";
            genState.translatedLanguage = undefined;
            genState.error = e?.message ?? String(e);
            genState.message = "Translation failed";
        });
    }
}

// Restore whatever was saved for this video. Leaves `pinned` false: a restored
// transcript is an offer, not a takeover, so a video that also has a real
// subtitle track keeps showing that track until the viewer says otherwise.
//
// `stillWanted` is checked after the read: the caller has usually moved on to
// another video by the time a slow disk read lands, and restoring the old
// video's transcript over the new one's state is exactly the kind of stale
// write that makes the menu show a transcript for a film you left.
export async function loadSavedGeneration(key: string, stillWanted?: () => boolean): Promise<void> {
    // Never clobber a run that is happening right now for this same video.
    if (genState.key === key && (genState.phase === "running" || genState.phase === "loading")) return;
    let saved: SavedGeneration | undefined;
    try {
        saved = await loadGeneration(key);
    } catch (e) {
        console.warn("[subtitleGen] could not read the saved transcript:", e);
        return;
    }
    const got = saved;
    if (!got) return;
    if (stillWanted && !stillWanted()) return;
    if (genState.key === key && (genState.phase === "running" || genState.phase === "loading")) return;
    runInAction(() => {
        Object.assign(genState, blankGenState(), {
            phase: "done",
            message: "Saved transcript",
            key,
            processedToSec: got.toSec,
            durationSec: got.durationSec,
            transcript: got.transcript,
            translation: got.translation,
            translatedLanguage: got.translationLanguage,
            showing: got.translation.length ? "translation" : "transcript",
            complete: got.complete,
            fromSec: got.fromSec,
            mode: "all",
        } satisfies Partial<GenState>);
    });
}

// Throw away everything generated for this video, on disk and in memory.
export async function discardGeneratedSubtitles(key: string): Promise<void> {
    stopSubtitleGeneration();
    try {
        await deleteGeneration(key);
    } catch (e) {
        console.warn("[subtitleGen] could not delete the saved transcript:", e);
    }
    runInAction(() => {
        if (genState.key !== key) return;
        Object.assign(genState, blankGenState());
    });
}
