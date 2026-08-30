// Audio decode worker — demux + audio decode OFF the main thread.
//
// The mediabunny player engine decodes video AND audio on the tab's main
// thread. Audio scheduling (AudioContext) is Window-only so it must stay on
// main, but the expensive part — demux + AudioDecoder / AC-3 WASM / DTS JS
// decode — is fully worker-capable (WebCodecs AudioDecoder is exposed in
// dedicated workers; this repo already runs the whole mediabunny stack in
// metadataWorker). Moving it here makes the audio pipeline immune to
// main-thread load (heavy UI renders), which used to starve the audio
// scheduling pump until its clock stalled and video froze against it.
//
// Protocol (one active job at a time; a new "start" implicitly stops the old):
//   main → worker:
//     { type: "start", jobId, blob, startSec, untilMediaSec }
//     { type: "pull",  jobId, untilMediaSec }   // raise the decode ceiling
//     { type: "stop",  jobId }
//   worker → main:
//     { type: "sample", jobId, timestamp, duration, sampleRate,
//       numberOfChannels, numberOfFrames, planar /* transferred ArrayBuffer,
//       f32-planar: [ch0 frames][ch1 frames]... */ }
//     { type: "ended", jobId }
//     { type: "error", jobId, message, stack }
//
// Backpressure is the pull ceiling: we decode + post samples only up to
// `untilMediaSec` (the main thread sends its audio clock + buffer-ahead), then
// park until the ceiling rises. Pause freezes the main thread's audio clock,
// so the ceiling stops rising and we park automatically.

// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
import * as mediabunny from "mediabunny/dist/bundles/mediabunny.cjs";
import { Input, ALL_FORMATS, BlobSource, AudioSampleSink, EncodedPacketSink } from "mediabunny/dist/bundles/mediabunny.cjs";
import { DtsAudioSink, looksLikeDtsCore } from "./player/DtsAudioSink";
import { downmixToMono, Resampler } from "./subtitleGen/asr";
import { SPEECH_SAMPLE_RATE } from "./subtitleGen/models";

// The bundler executes this entry under Node to enumerate modules; the worker
// wiring must stay dormant there (same guard as metadataWorker).
declare const importScripts: ((...urls: string[]) => void) | undefined;

if (typeof importScripts === "function") {
    const post = (msg: unknown, transfer?: Transferable[]) => {
        if (transfer && transfer.length > 0) (self as any).postMessage(msg, transfer);
        else (self as any).postMessage(msg);
    };

    // AC-3/E-AC-3: same side-effect classic script the main thread loads via a
    // <script> tag (AudioCodecLoader), loaded here with importScripts. The
    // script reads globalThis.__mediabunny to register its custom decoder on
    // OUR module instance, and has no document/window dependencies (verified —
    // it even ships its own WorkerGlobalScope handling for the WASM load).
    let ac3Loaded = false;
    function ensureAc3(): void {
        if (ac3Loaded) return;
        (self as any).__mediabunny = mediabunny;
        importScripts!("./assets/mediabunny-ac3.js");
        if (!(self as any).__mediabunnyAc3) {
            throw new Error("mediabunny-ac3.js loaded but did not register (worker)");
        }
        ac3Loaded = true;
        console.log("[audioDecodeWorker] @mediabunny/ac3 loaded + registered");
    }

    interface Job {
        id: number;
        stopped: boolean;
        untilMediaSec: number;
        wake: (() => void) | undefined;
    }
    let current: Job | undefined;

    // Open the file and pick a decoder for its audio track. Shared by the
    // streaming player path and the bulk range decode below, because choosing
    // between AudioSampleSink, the AC-3 registration and the DTS sniff is the
    // same problem in both.
    async function openAudio(input: InstanceType<typeof Input>): Promise<
        { samples(startSec: number): AsyncIterable<any> } | undefined
    > {
        const track = await input.getPrimaryAudioTrack();
        if (!track) return undefined;
        const codec = await track.getCodec();
        if (codec === "ac3" || codec === "eac3") {
            ensureAc3();
            return new AudioSampleSink(track);
        }
        if (!codec) {
            const first = await new EncodedPacketSink(track).getFirstPacket();
            if (first && looksLikeDtsCore(first.data)) return new DtsAudioSink(track);
            return undefined;
        }
        return new AudioSampleSink(track);
    }

    // Decode one span of the file to exactly what the recogniser eats: mono,
    // 16 kHz, one Float32Array, transferred once.
    //
    // The streaming path below posts every decoded packet -- about 21 ms of
    // audio each, so ~170,000 messages per hour, and then the main thread
    // forwards every one of them to the ASR worker for ~340,000 in total. That
    // is most of what made transcription slow, and none of it bought anything:
    // nothing downstream wants audio in 21 ms pieces. Here the packets are
    // downmixed and resampled as they arrive and accumulated into one buffer,
    // which costs one message for the whole span.
    //
    // 16 kHz mono f32 is 64 KB per second: 230 MB per hour, which is why the
    // caller decodes an hour at a time rather than a whole film.
    async function runRangeJob(
        job: Job, blob: Blob, fromSec: number, toSec: number,
    ): Promise<void> {
        let input: InstanceType<typeof Input> | undefined;
        try {
            input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
            const sink = await openAudio(input);
            if (!sink || job.stopped) {
                if (!job.stopped) {
                    post({ type: "rangeDone", jobId: job.id, fromSec, pcm: new Float32Array(0).buffer,
                        sampleRate: SPEECH_SAMPLE_RATE, seconds: 0 }, []);
                }
                return;
            }

            const span = Math.max(0, toSec - fromSec);
            const parts: Float32Array[] = [];
            let total = 0;
            let resampler: Resampler | undefined;
            let lastReport = 0;
            let reachedSec = fromSec;

            for await (const sample of sink.samples(fromSec)) {
                if (job.stopped) { sample.close?.(); return; }
                if (sample.timestamp >= toSec) { sample.close?.(); break; }

                const ch = sample.numberOfChannels;
                const frames = sample.numberOfFrames;
                const planar = new Float32Array(ch * frames);
                for (let c = 0; c < ch; c++) {
                    sample.copyTo(planar.subarray(c * frames, (c + 1) * frames),
                        { planeIndex: c, format: "f32-planar" });
                }
                reachedSec = sample.timestamp + (sample.duration || 0);
                const rate = sample.sampleRate;
                sample.close?.();

                const mono = downmixToMono(planar, ch, frames);
                resampler ??= new Resampler(rate);
                const out = resampler.push(mono);
                if (out.length) { parts.push(out); total += out.length; }

                // Progress is reported off media time, not sample count: it is
                // the only number that maps to what the viewer is waiting for.
                const done = Math.min(1, span > 0 ? (reachedSec - fromSec) / span : 1);
                if (done - lastReport > 0.01) {
                    lastReport = done;
                    post({ type: "rangeProgress", jobId: job.id, fraction: done });
                }
            }

            if (resampler) {
                const tail = resampler.flush();
                if (tail.length) { parts.push(tail); total += tail.length; }
            }
            if (job.stopped) return;

            const pcm = new Float32Array(total);
            let at = 0;
            for (const p of parts) { pcm.set(p, at); at += p.length; }
            post({
                type: "rangeDone", jobId: job.id, fromSec, pcm: pcm.buffer,
                sampleRate: SPEECH_SAMPLE_RATE, seconds: total / SPEECH_SAMPLE_RATE,
            }, [pcm.buffer]);
        } catch (err) {
            if (!job.stopped) {
                const e = err as Error;
                post({ type: "error", jobId: job.id, message: e?.message ?? String(err), stack: e?.stack });
            }
        } finally {
            try { await input?.dispose(); } catch { /* ignore */ }
        }
    }

    async function runJob(job: Job, blob: Blob, startSec: number): Promise<void> {
        let input: InstanceType<typeof Input> | undefined;
        try {
            input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
            const track = await input.getPrimaryAudioTrack();
            if (!track || job.stopped) {
                if (!job.stopped) post({ type: "ended", jobId: job.id });
                return;
            }
            const codec = await track.getCodec();
            let sink: { samples(startSec: number): AsyncIterable<any> };
            if (codec === "ac3" || codec === "eac3") {
                ensureAc3();
                sink = new AudioSampleSink(track);
            } else if (!codec) {
                // mediabunny can't identify the codec — sniff for DTS core, the
                // one null-codec format we can decode (pure-JS decoder).
                const first = await new EncodedPacketSink(track).getFirstPacket();
                if (first && looksLikeDtsCore(first.data)) {
                    sink = new DtsAudioSink(track);
                } else {
                    post({ type: "ended", jobId: job.id });
                    return;
                }
            } else {
                sink = new AudioSampleSink(track);
            }

            for await (const sample of sink.samples(startSec)) {
                if (job.stopped) { sample.close?.(); return; }
                // Park until the pull ceiling covers this sample.
                while (!job.stopped && sample.timestamp > job.untilMediaSec) {
                    await new Promise<void>(res => { job.wake = res; });
                }
                if (job.stopped) { sample.close?.(); return; }
                const ch = sample.numberOfChannels;
                const frames = sample.numberOfFrames;
                const planar = new Float32Array(ch * frames);
                for (let c = 0; c < ch; c++) {
                    sample.copyTo(planar.subarray(c * frames, (c + 1) * frames), { planeIndex: c, format: "f32-planar" });
                }
                const msg = {
                    type: "sample", jobId: job.id,
                    timestamp: sample.timestamp, duration: sample.duration,
                    sampleRate: sample.sampleRate, numberOfChannels: ch, numberOfFrames: frames,
                    planar: planar.buffer,
                };
                sample.close?.();
                post(msg, [planar.buffer]);
            }
            if (!job.stopped) post({ type: "ended", jobId: job.id });
        } catch (err) {
            if (!job.stopped) {
                // Send the WORKER-side stack along — the client rethrows over
                // there, so without this every failure collapses into a
                // context-free message (e.g. mediabunny's "Assertion failed.").
                const e = err as Error;
                post({
                    type: "error", jobId: job.id,
                    message: e?.message ?? String(err),
                    stack: e?.stack,
                });
            }
        } finally {
            try { await input?.dispose(); } catch { /* ignore */ }
        }
    }

    self.addEventListener("message", (e: MessageEvent) => {
        const d = e.data as any;
        if (!d) return;
        if (d.type === "start") {
            if (current) { current.stopped = true; current.wake?.(); }
            const job: Job = {
                id: d.jobId as number,
                stopped: false,
                untilMediaSec: typeof d.untilMediaSec === "number" ? d.untilMediaSec : (d.startSec as number),
                wake: undefined,
            };
            current = job;
            void runJob(job, d.blob as Blob, d.startSec as number);
        } else if (d.type === "startRange") {
            if (current) { current.stopped = true; current.wake?.(); }
            const job: Job = {
                id: d.jobId as number, stopped: false,
                untilMediaSec: Infinity,   // no ceiling: the range IS the limit
                wake: undefined,
            };
            current = job;
            void runRangeJob(job, d.blob as Blob, d.fromSec as number, d.toSec as number);
        } else if (d.type === "pull") {
            if (current && current.id === d.jobId && typeof d.untilMediaSec === "number" && d.untilMediaSec > current.untilMediaSec) {
                current.untilMediaSec = d.untilMediaSec;
                const wake = current.wake;
                current.wake = undefined;
                wake?.();
            }
        } else if (d.type === "stop") {
            if (current && current.id === d.jobId) {
                current.stopped = true;
                const wake = current.wake;
                current = undefined;
                wake?.();
            }
        }
    });
    console.log("[audioDecodeWorker] ready");
}
