// Generate subtitles for the video that is currently playing.
//
// Two workers and two stages, an hour of audio at a time:
//
//   1. the decode worker reads a span out of the container, downmixes it to
//      mono and resamples it to 16 kHz, and hands the whole span over in one
//      transfer
//   2. the ASR worker runs the acoustic model over every chunk of that span,
//      then decodes sixteen chunks at a time into words
//
// It used to interleave the two, with the decoder throttled to stay 45 s ahead
// of the recogniser, which meant every 21 ms packet of audio crossed a worker
// boundary twice -- around 340,000 messages an hour, for audio nothing
// downstream wanted in pieces that small.
//
// Every stage reports a named phase and a fraction. That is not decoration:
// the acoustic model and the decode differ by more than an order of magnitude
// in speed, and a run that says nothing for a minute is indistinguishable from
// a hung one.
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
import { createAudioWorkerChannel } from "../player/AudioWorkerClient";
import { AsrWord } from "./asr";
import { AsrJob, startAsrJob, unloadSpeechModel } from "./AsrWorkerClient";
import { SPEECH_MODEL } from "./models";
import { deleteGeneration, loadGeneration, SavedGeneration, saveTranscript, saveTranslation } from "./subtitleCache";
import { createTranslator, unloadTranslators } from "./translate";

// How much of the file to decode into memory before transcribing it.
//
// One hour of 16 kHz mono f32 is 230 MB. A film is one span or two; a
// ten-hour recording is ten spans rather than a 2.3 GB allocation the browser
// would refuse, and each span's memory is freed before the next is decoded.
const SPAN_SEC = 3600;

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

// "1:02:03" / "4:05", for naming which hour of a long file is being worked on.
function formatClock(sec: number): string {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

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

    // Seconds of wall clock left, from the rate the run has actually achieved
    // so far. Undefined until there is enough of a run to divide by -- a
    // number made up from two data points is worse than no number.
    etaSec: number | undefined;

    translating: boolean;
    // 0..1 through the transcript while translating, and the matching ETA.
    translateProgress: number | undefined;
    translateEtaSec: number | undefined;
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
        etaSec: undefined,
        translating: false,
        translateProgress: undefined,
        translateEtaSec: undefined,
        error: undefined,
        mode: "stream",
    };
}

// "4m 12s" / "1h 05m" / "38s". Rounded coarsely on purpose: this is an
// extrapolation from a rate that changes, so second-precision on a one-hour
// estimate would be claiming an accuracy it does not have.
export function formatEta(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
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
    private asr: AsrJob | undefined;
    // Which part of a long file is being worked on, appended to whatever the
    // worker calls the phase it is in.
    private spanLabel = "";
    // Settles the span currently in the recogniser.
    private spanDone: (() => void) | undefined;
    private spanFailed: ((e: Error) => void) | undefined;
    private pendingWords: AsrWord[] = [];
    private stopped = false;
    private runToken = 0;
    // Clock for the ETA, started at the FIRST transcribed audio rather than at
    // start(): the first run of a session spends minutes downloading a 456 MB
    // model, and folding that into the rate would predict a transcription speed
    // this machine never had.
    private rateStartMs = 0;
    private rateStartSec = 0;

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
        this.rateStartMs = 0;
        this.rateStartSec = 0;

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
            await this.runStages(opts, fromSec, token);
        } catch (e: any) {
            this.fail(e, token);
        }
    }

    // Decode, then transcribe. One hour at a time, one stage at a time.
    //
    // The old shape ran both at once and throttled the decoder to stay 45 s
    // ahead of the recogniser, which meant every ~21 ms packet crossed a worker
    // boundary twice -- roughly 340,000 messages an hour -- for audio nothing
    // downstream wanted in pieces that small. Now a span is decoded whole and
    // handed over in one transfer.
    //
    // An hour of 16 kHz mono f32 is 230 MB, which a browser will allocate
    // without complaint. Ten hours in one buffer is 2.3 GB, which it will not,
    // so a long file becomes several spans -- and a span that finishes is a
    // span whose memory is released before the next one is decoded.
    private async runStages(
        opts: { key: string; blob: Blob; durationSec: number },
        fromSec: number, token: number,
    ): Promise<void> {
        const endSec = opts.durationSec > 0 ? opts.durationSec : Infinity;
        const totalSec = Math.max(0, endSec - fromSec);
        let spanStart = fromSec;

        this.asr = startAsrJob(subtitleGenWebGpu.get(), {
            onWords: (words, processedToSec) => {
                if (this.stopped || token !== this.runToken) return;
                runInAction(() => {
                    genState.processedToSec = Math.max(genState.processedToSec, processedToSec);
                    genState.etaSec = this.estimateEta("all");
                });
                this.onWords(words, token);
            },
            onSpanDone: () => {
                const done = this.spanDone;
                this.spanDone = undefined;
                this.spanFailed = undefined;
                done?.();
            },
            onProgress: (message, fraction) => runInAction(() => {
                if (token !== this.runToken) return;
                // The worker names its own phase; the span label says which
                // hour of a long file that phase is working on.
                genState.message = `${message}${this.spanLabel}`;
                genState.progress = fraction;
            }),
            onError: err => {
                const failed = this.spanFailed;
                this.spanDone = undefined;
                this.spanFailed = undefined;
                if (failed) failed(err); else this.fail(err, token);
            },
        });

        while (spanStart < endSec) {
            if (this.stopped || token !== this.runToken) return;
            const spanEnd = Math.min(endSec, spanStart + SPAN_SEC);
            const spanLabel = totalSec > SPAN_SEC
                ? ` (${formatClock(spanStart)}-${formatClock(Math.min(spanEnd, endSec))})`
                : "";
            this.spanLabel = spanLabel;

            // Said before the work starts, not on its first progress tick:
            // opening a container and finding its audio track takes a moment
            // on a large file, and that moment should not look like nothing.
            runInAction(() => {
                if (token !== this.runToken) return;
                genState.phase = "running";
                genState.message = `Reading audio${spanLabel}`;
                genState.progress = 0;
            });

            // Stage one: audio out of the container, decoded and flattened to
            // one 16 kHz channel.
            const decoded = await this.channel.decodeRange({
                blob: opts.blob,
                fromSec: spanStart,
                toSec: spanEnd,
                onProgress: fraction => runInAction(() => {
                    if (token !== this.runToken) return;
                    genState.phase = "running";
                    genState.message = `Reading audio${spanLabel}`;
                    // A file of unknown duration has no whole-file fraction to
                    // report, so fall back to progress through this span.
                    genState.progress = clamp01(
                        Number.isFinite(totalSec) && totalSec > 0
                            ? (spanStart - fromSec + fraction * (spanEnd - spanStart)) / totalSec
                            : fraction);
                }),
            });
            if (this.stopped || token !== this.runToken) return;
            if (!decoded.pcm.length) break;      // ran off the end of the audio

            // Stage two: the recogniser, over the whole span at once. It
            // reports its own phases and fractions from here on -- the
            // acoustic model and the decode take very different times, and a
            // run that says nothing for a minute looks identical to a hung one.
            runInAction(() => {
                genState.message = `Transcribing${spanLabel}`;
                genState.progress = 0;
            });
            await this.transcribeSpan(decoded.pcm, spanStart, token);
            if (this.stopped || token !== this.runToken) return;

            // Compared BEFORE spanStart moves: a span that came back shorter
            // than the one asked for means the audio ended inside it.
            const asked = spanEnd - spanStart;
            spanStart += decoded.seconds;
            if (decoded.seconds <= 0 || decoded.seconds < asked - 1) break;
        }

        if (this.stopped || token !== this.runToken) return;
        this.emitCues(true, token);
        runInAction(() => {
            genState.phase = "done";
            genState.message = "Reached end of audio";
            genState.progress = undefined;
            genState.processedToSec = Math.max(genState.processedToSec, genState.durationSec);
            genState.complete = genState.fromSec <= 2 && genState.transcript.length > 0;
        });
        await this.persist(opts.key, token);
        // Nothing else here needs the GPU now.
        this.releaseModels();
    }

    // Resolves when the worker has finished the span it was given.
    private transcribeSpan(pcm: Float32Array, startSec: number, token: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const job = this.asr;
            if (!job) return resolve();
            this.spanDone = resolve;
            this.spanFailed = reject;
            void token;
            job.transcribe(pcm, startSec);
        });
    }

    // How long the rest of the file will take, at the rate this run has managed
    // so far. Only meaningful for "all": a streaming run is rate-limited to the
    // playhead on purpose, so its "remaining time" is however long the film is.
    private estimateEta(mode: "stream" | "all"): number | undefined {
        if (mode !== "all" || !genState.durationSec) return undefined;
        const now = Date.now();
        if (!this.rateStartMs) {
            this.rateStartMs = now;
            this.rateStartSec = genState.processedToSec;
            return undefined;
        }
        const elapsed = (now - this.rateStartMs) / 1000;
        const done = genState.processedToSec - this.rateStartSec;
        // Two data points and three seconds is not a rate. Wait for enough of a
        // run that the number means something.
        if (elapsed < 5 || done < 5) return undefined;
        const remaining = Math.max(0, genState.durationSec - genState.processedToSec);
        return remaining * (elapsed / done);
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

    // Hand the GPU back.
    //
    // Both models live behind module-level caches that were never cleared, so
    // a tab that generated subtitles once held the speech model's 650 MB -- and
    // a translation model's several GB -- until it was closed. Nothing reclaims
    // an onnxruntime session's GPU buffers when the last reference drops; the
    // session has to be released.
    private releaseModels(): void {
        unloadSpeechModel();
        void unloadTranslators().catch((e: unknown) =>
            console.warn("[subtitleGen] could not unload the language model:", e));
    }

    stop(): void {
        this.stopped = true;
        this.runToken++;
        const failed = this.spanFailed;
        this.spanDone = undefined;
        this.spanFailed = undefined;
        failed?.(new Error("stopped"));
        this.asr?.stop();
        this.asr = undefined;
        this.pendingWords = [];
        // Stopping is as much an end of the run as finishing is, and the reason
        // to free the weights is the same.
        this.releaseModels();
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
        genState.translateEtaSec = undefined;
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
    // ISO code, English name, and what the language calls itself. The last two
    // are what the model is actually told; an empty target is refused rather
    // than guessed at.
    targetLanguage: string;
    targetLanguageName: string;
    targetEndonym: string;
    modelKey: SubtitleGenModel;
}): Promise<void> {
    if (genState.key !== opts.key || !genState.transcript.length) return;
    if (!opts.targetLanguage.trim()) {
        runInAction(() => {
            genState.error = "Pick a language to translate into first.";
            genState.message = "No translation language set";
        });
        return;
    }
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
        const translator = await createTranslator({
            modelKey: opts.modelKey,
            targetLanguage: opts.targetLanguage,
            targetLanguageName: opts.targetLanguageName,
            targetEndonym: opts.targetEndonym,
            sourceCues: source,
            onProgress: (msg, fraction) => runInAction(() => {
                if (token !== translateToken) return;
                genState.message = msg;
                genState.progress = fraction;
            }),
        });
        if (token !== translateToken) return;
        runInAction(() => { genState.progress = undefined; });

        console.log(`[translate] starting loop with ${source.length} cue(s) via ${translator.label}`);
        const rateStartMs = Date.now();
        const out: SubtitleCue[] = [];
        for (let i = 0; i < source.length; i++) {
            if (token !== translateToken) return;
            out.push({ ...source[i], text: await translator.translate(source[i].text) });
            const elapsed = (Date.now() - rateStartMs) / 1000;
            const left = source.length - (i + 1);
            // Publish as we go: a two-hour film is thousands of LLM calls, and
            // watching the lines arrive is the difference between "working" and
            // "hung".
            runInAction(() => {
                if (token !== translateToken) return;
                genState.translation = [...out];
                genState.translateProgress = (i + 1) / source.length;
                genState.translateEtaSec = elapsed > 5 ? (elapsed / (i + 1)) * left : undefined;
                genState.message = `Translating: ${translator.label}`;
            });
        }
        if (token !== translateToken) return;

        console.log(`[translate] loop done: ${out.length} cue(s) produced`);
        runInAction(() => {
            genState.translating = false;
            genState.translateProgress = undefined;
            genState.translateEtaSec = undefined;
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
            genState.translateEtaSec = undefined;
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
