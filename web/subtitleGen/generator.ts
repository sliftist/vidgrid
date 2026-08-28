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

import { observable, runInAction } from "mobx";
import { SubtitleCue } from "../player/subtitles";
import { SubtitleGenModel, subtitleGenWebGpu } from "../appState";
import { createAudioWorkerChannel, AudioWorkerJob } from "../player/AudioWorkerClient";
import { AsrWord } from "./asr";
import { AsrJob, startAsrJob } from "./AsrWorkerClient";
import { Translator } from "./translate";

// How far ahead of the playhead (stream) or the transcript (all) we let the
// decoder run. Comfortably more than the ASR worker's 20 s window, so there is
// always a full window waiting; small enough that we are not decoding a whole
// film into memory when the user watches two minutes and quits.
const RUN_AHEAD_SEC = 45;

// TRANSLATION IS OFF ON PURPOSE. The transcript is the half worth trusting
// right now, and mixing in a second unvalidated model makes it impossible to
// tell which half produced a bad line. Flip this back on once the ASR output
// has been judged good; every code path below still handles it.
const TRANSLATION_ENABLED = false;
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
    cues: SubtitleCue[];
    // What the speech model heard, before any translation. Kept separately so
    // the menu can show the raw transcript: if this is empty the ASR is broken,
    // and if it has text but `cues` doesn't, translation is.
    transcript: SubtitleCue[];
    translating: boolean;
    error: string | undefined;
    // Which way the current run was started. The readouts differ: streaming
    // cares about the lead over the playhead, "all" cares about how far through
    // the file it is.
    mode: "stream" | "all";
}

export const genState = observable<GenState>({
    phase: "idle",
    message: "",
    progress: undefined,
    key: undefined,
    processedToSec: 0,
    playheadSec: 0,
    durationSec: 0,
    cues: [],
    transcript: [],
    translating: false,
    error: undefined,
    mode: "stream",
});

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
    private translator: Translator | undefined;
    private pullTimer: ReturnType<typeof setInterval> | undefined;
    private pendingWords: AsrWord[] = [];
    // Serialises translation so cues stay in order and we never have two
    // generate() calls fighting over one model session.
    private translateChain: Promise<void> = Promise.resolve();
    private stopped = false;
    private runToken = 0;

    async start(opts: {
        key: string;
        blob: Blob;
        startSec: number;
        durationSec: number;
        targetLanguage: string;   // ISO code, e.g. "eng"
        targetLanguageName: string;
        modelKey: SubtitleGenModel;
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

        runInAction(() => {
            genState.phase = "loading";
            genState.message = "Starting...";
            genState.progress = undefined;
            genState.key = opts.key;
            genState.processedToSec = opts.mode === "all" ? 0 : opts.startSec;
            genState.playheadSec = opts.startSec;
            genState.mode = opts.mode;
            genState.durationSec = opts.durationSec;
            genState.cues = [];
            genState.transcript = [];
            genState.translating = false;
            genState.error = undefined;
        });

        // Translating means running a second model over every cue, which is by
        // far the slowest stage; skipping it when the transcript is already in
        // the wanted language is not an optimisation detail. Right now it is off
        // outright -- see TRANSLATION_ENABLED.
        const needsTranslation = TRANSLATION_ENABLED
            && opts.targetLanguage !== "eng" && opts.targetLanguage !== "en";

        try {
            if (needsTranslation) {
                this.translator = await Translator.create(
                    opts.modelKey, opts.targetLanguageName,
                    msg => runInAction(() => { genState.message = msg; }));
            }
            if (this.stopped || token !== this.runToken) return;

            // The ASR worker downloads the model on its first job; the audio
            // decoder starts at the same time and just parks against the
            // ceiling until there is somewhere for its PCM to go.
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
                    });
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
                startSec: opts.mode === "all" ? 0 : opts.startSec,
                initialUntilSec: (opts.mode === "all" ? 0 : opts.startSec) + RUN_AHEAD_SEC,
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
        // Recorded before translation, so the menu shows what was heard even
        // when the translation stage is slow or failing.
        runInAction(() => {
            if (token !== this.runToken) return;
            genState.transcript = [...genState.transcript, ...ready];
        });
        this.publish(ready, token);
    }

    private publish(cues: SubtitleCue[], token: number): void {
        const translator = this.translator;
        if (!translator) {
            runInAction(() => {
                if (token !== this.runToken) return;
                genState.cues = [...genState.cues, ...cues];
            });
            return;
        }
        // Chain so cues are translated and appended in order.
        this.translateChain = this.translateChain.then(async () => {
            if (this.stopped || token !== this.runToken) return;
            runInAction(() => { genState.translating = true; });
            const out: SubtitleCue[] = [];
            for (const c of cues) {
                if (this.stopped || token !== this.runToken) return;
                out.push({ ...c, text: await translator.translate(c.text) });
            }
            runInAction(() => {
                if (token !== this.runToken) return;
                genState.cues = [...genState.cues, ...out];
                genState.translating = false;
            });
        }).catch(e => {
            console.warn("[subtitleGen] translation chain failed:", e);
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
    runInAction(() => {
        if (genState.phase === "running" || genState.phase === "loading") {
            genState.phase = "idle";
            genState.message = "Stopped";
        }
    });
}
