// Generate subtitles for the video that is currently playing.
//
// Shape of the thing: decode audio AHEAD of the playhead (the existing audio
// decode worker already runs as fast as the CPU allows -- it just parks against
// a pull ceiling, so we set that ceiling to playhead + RUN_AHEAD_SEC), push the
// PCM through vosk, group the resulting words into cues, and optionally
// translate each cue before publishing it.
//
// Running ahead rather than transcribing the whole file up front is what makes
// this usable: subtitles appear seconds after you press the button instead of
// after a full-file pass, and stopping playback stops the work.

import { observable, runInAction } from "mobx";
import { SubtitleCue } from "../player/subtitles";
import { SubtitleGenModel } from "../appState";
import { createAudioWorkerChannel, AudioWorkerJob, WorkerPcm } from "../player/AudioWorkerClient";
import { AsrWord, Transcriber, downmixToMono, loadVoskModel } from "./asr";
import { Translator } from "./translate";

// How far ahead of the playhead we try to stay. Big enough that a slow patch
// does not starve the overlay, small enough that we are not decoding the whole
// film into memory when the user watches two minutes and quits.
const RUN_AHEAD_SEC = 30;
// Silence longer than this ends a cue.
const CUE_GAP_SEC = 0.8;
// Cues also break on length, so a monologue does not become one 40-second cue.
const CUE_MAX_SEC = 6;
const CUE_MAX_CHARS = 84;

export type GenPhase = "idle" | "loading" | "running" | "done" | "error";

export interface GenState {
    phase: GenPhase;
    message: string;
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
    // Live in-progress line from vosk. Its only job is to prove the recogniser
    // is alive; it changes several times a second.
    partial: string;
    translating: boolean;
    error: string | undefined;
}

export const genState = observable<GenState>({
    phase: "idle",
    message: "",
    key: undefined,
    processedToSec: 0,
    playheadSec: 0,
    durationSec: 0,
    cues: [],
    transcript: [],
    partial: "",
    translating: false,
    error: undefined,
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
    // The PROMISE, not the transcriber: PCM messages arrive one per decoded
    // audio frame (~21ms of audio each), so hundreds land before the first
    // create() resolves. Memoising the resolved value instead lets every one of
    // them start its own recogniser, which exhausts the wasm heap and kills the
    // module -- after which nothing is transcribed and nothing says so.
    private transcriberPromise: Promise<Transcriber> | undefined;
    private translator: Translator | undefined;
    private pullTimer: ReturnType<typeof setInterval> | undefined;
    private pendingWords: AsrWord[] = [];
    // Audio has to reach the recogniser in decode order, so feeding is a chain
    // rather than a race between overlapping onSample handlers.
    private feedChain: Promise<void> = Promise.resolve();
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
    }): Promise<void> {
        this.stop();
        this.stopped = false;
        const token = ++this.runToken;

        runInAction(() => {
            genState.phase = "loading";
            genState.message = "Starting...";
            genState.key = opts.key;
            genState.processedToSec = opts.startSec;
            genState.playheadSec = opts.startSec;
            genState.durationSec = opts.durationSec;
            genState.cues = [];
            genState.transcript = [];
            genState.partial = "";
            genState.translating = false;
            genState.error = undefined;
        });

        // The speech model is English-only, so anything else needs the
        // translation stage. Skipping it when the user wants English is not an
        // optimisation detail -- it removes the slowest stage entirely.
        const needsTranslation = opts.targetLanguage !== "eng" && opts.targetLanguage !== "en";

        try {
            if (needsTranslation) {
                this.translator = await Translator.create(
                    opts.modelKey, opts.targetLanguageName,
                    msg => runInAction(() => { genState.message = msg; }));
            }
            if (this.stopped || token !== this.runToken) return;

            // Load the speech model BEFORE any audio is decoded. It is a 40 MB
            // download, and starting the decoder first means a queue of PCM
            // piles up behind it for no reason.
            runInAction(() => { genState.message = "Loading speech model..."; });
            await loadVoskModel(msg => runInAction(() => {
                if (token === this.runToken) genState.message = msg;
            }));
            if (this.stopped || token !== this.runToken) return;

            this.job = this.channel.startJob({
                blob: opts.blob,
                startSec: opts.startSec,
                initialUntilSec: opts.startSec + RUN_AHEAD_SEC,
                onSample: p => void this.onSample(p, opts, token),
                onEnded: () => runInAction(() => {
                    if (token !== this.runToken) return;
                    genState.phase = "done";
                    genState.message = "Reached end of audio";
                    genState.processedToSec = genState.durationSec;
                }),
                onError: err => this.fail(err, token),
            });

            // Keep raising the ceiling as the playhead advances.
            this.pullTimer = setInterval(() => {
                if (this.stopped || token !== this.runToken) return;
                const head = opts.getPlayheadSec();
                runInAction(() => { genState.playheadSec = head; });
                this.job?.pull(head + RUN_AHEAD_SEC);
            }, 500);
        } catch (e: any) {
            this.fail(e, token);
        }
    }

    private onSample(p: WorkerPcm, opts: {
        startSec: number;
        targetLanguage: string;
    }, token: number): void {
        if (this.stopped || token !== this.runToken) return;
        this.feedChain = this.feedChain.then(async () => {
            if (this.stopped || token !== this.runToken) return;

            if (!this.transcriberPromise) {
                // The sample rate isn't known until the first packet arrives,
                // which is why this can't happen in start(). Assigning the
                // promise before awaiting it is the whole point: every later
                // sample joins this one instead of starting its own.
                this.transcriberPromise = Transcriber.create({
                    sampleRate: p.sampleRate,
                    baseMediaSec: p.timestamp,
                    onWords: words => this.onWords(words, opts, token),
                    onPartial: text => runInAction(() => {
                        if (token === this.runToken) genState.partial = text;
                    }),
                    onError: message => this.fail(new Error(message), token),
                });
            }
            const transcriber = await this.transcriberPromise;
            if (this.stopped || token !== this.runToken) return;
            if (genState.phase === "loading") {
                runInAction(() => {
                    genState.phase = "running";
                    genState.message = "Transcribing";
                });
            }

            const mono = downmixToMono(p.planar, p.numberOfChannels, p.numberOfFrames);
            transcriber.accept(mono, p.sampleRate);
            // Advanced only now, after the audio genuinely reached the
            // recogniser -- this number is the feature's only honest progress
            // signal and must never report decoder progress instead.
            runInAction(() => {
                if (token !== this.runToken) return;
                genState.processedToSec = Math.max(genState.processedToSec, p.timestamp + p.duration);
            });
        }).catch(e => this.fail(e, token));
    }

    private onWords(words: AsrWord[], opts: { targetLanguage: string }, token: number): void {
        if (this.stopped || token !== this.runToken) return;
        this.pendingWords.push(...words);
        const cues = cuesFromWords(this.pendingWords);
        // Keep the last cue pending: more words may still extend it.
        const ready = cues.slice(0, Math.max(0, cues.length - 1));
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
        // The recogniser may still be mid-construction; disposing on settle
        // keeps a stopped run from leaking one into the wasm heap.
        const pending = this.transcriberPromise;
        this.transcriberPromise = undefined;
        void pending?.then(t => t.dispose(), () => { });
        this.feedChain = Promise.resolve();
        this.pendingWords = [];
        runInAction(() => { genState.partial = ""; });
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
