// Audio plumbing shared by the ASR worker and its client: the word shape that
// comes out, and the three transforms that turn decoder output into something
// Parakeet will accept.
//
// The decoder hands us f32-planar PCM at whatever rate the file uses, in
// ~21 ms packets. Parakeet wants one mono channel at exactly 16 kHz, in chunks
// of a few seconds. So: downmix, resample, chunk -- in that order, and the
// resampler has to be stateful because the packets are a continuous stream.

import { SPEECH_SAMPLE_RATE } from "./models";

export interface AsrWord {
    word: string;
    // Media seconds, already rebased -- directly usable as cue times.
    start: number;
    end: number;
}

// Decoded audio arrives as f32-planar, often 5.1. The model wants one channel;
// a plain average across channels is the right call here (unlike playback,
// where AudioPlayback.ts does a weighted downmix to preserve stereo image)
// because speech sits in the centre channel and we only care about
// intelligibility.
export function downmixToMono(planar: Float32Array, channels: number, frames: number): Float32Array {
    if (channels === 1) return planar.subarray(0, frames);
    const out = new Float32Array(frames);
    for (let c = 0; c < channels; c++) {
        const base = c * frames;
        for (let i = 0; i < frames; i++) out[i] += planar[base + i];
    }
    const scale = 1 / channels;
    for (let i = 0; i < frames; i++) out[i] *= scale;
    return out;
}

// --- resampling ------------------------------------------------------------

// Windowed-sinc, not linear interpolation. Going 48 kHz -> 16 kHz is decimation
// by 3, and decimating without a low-pass folds everything above 8 kHz back
// down into the speech band as aliasing -- which the acoustic model then hears
// as texture that was never in the audio. A sinc kernel band-limits and
// interpolates in one pass.
const TAPS = 32;                 // 16 either side of the read position
const HALF = TAPS / 2;
const PHASES = 128;              // sub-sample positions in the precomputed table

// Table of windowed-sinc coefficients: [phase][tap]. Built once per (rate,
// cutoff) pair, because a movie is one sample rate from end to end.
const kernelCache = new Map<string, Float32Array>();

function buildKernel(cutoff: number): Float32Array {
    // Blackman window over the whole TAPS-wide support, evaluated at each of
    // PHASES fractional offsets.
    const k = new Float32Array(PHASES * TAPS);
    for (let p = 0; p < PHASES; p++) {
        const frac = p / PHASES;
        let sum = 0;
        for (let t = 0; t < TAPS; t++) {
            // Distance from the (fractional) read position to this tap.
            const x = t - HALF + 1 - frac;
            const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
            const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * (t + frac)) / TAPS)
                + 0.08 * Math.cos((4 * Math.PI * (t + frac)) / TAPS);
            const v = cutoff * sinc * w;
            k[p * TAPS + t] = v;
            sum += v;
        }
        // Normalise per phase so a DC input comes out at unity gain rather than
        // wobbling by a fraction of a dB as the phase walks.
        const g = sum === 0 ? 1 : 1 / sum;
        for (let t = 0; t < TAPS; t++) k[p * TAPS + t] *= g;
    }
    return k;
}

// Feed it packets, get 16 kHz back. State (the tail of the last packet plus a
// fractional read position) carries across calls, so packet seams are not
// discontinuities.
export class Resampler {
    private kernel: Float32Array;
    private step: number;             // source samples advanced per output sample
    private buf = new Float32Array(0);
    // Read position in `buf`, in source samples. Starts past the kernel's left
    // half so the first output has real history rather than zeros.
    private pos = HALF;
    private passthrough: boolean;

    constructor(private srcRate: number) {
        this.step = srcRate / SPEECH_SAMPLE_RATE;
        this.passthrough = srcRate === SPEECH_SAMPLE_RATE;
        // Cutoff is the lower of the two Nyquists, expressed against the source
        // rate. Downsampling needs the anti-alias filter; upsampling only needs
        // interpolation, so the cutoff stays at source Nyquist.
        const cutoff = Math.min(1, SPEECH_SAMPLE_RATE / srcRate);
        const key = `${cutoff.toFixed(6)}`;
        let k = kernelCache.get(key);
        if (!k) { k = buildKernel(cutoff); kernelCache.set(key, k); }
        this.kernel = k;
    }

    push(mono: Float32Array): Float32Array {
        if (this.passthrough) return mono.slice();
        if (!mono.length) return new Float32Array(0);

        const merged = new Float32Array(this.buf.length + mono.length);
        merged.set(this.buf, 0);
        merged.set(mono, this.buf.length);
        this.buf = merged;

        // We can emit while the kernel's right half still lands inside the
        // buffer; anything past that waits for the next packet.
        const limit = this.buf.length - HALF;
        const count = Math.max(0, Math.ceil((limit - this.pos) / this.step));
        const out = new Float32Array(count);
        const kern = this.kernel;
        let pos = this.pos;
        for (let i = 0; i < count; i++) {
            const base = Math.floor(pos);
            const p = Math.min(PHASES - 1, ((pos - base) * PHASES) | 0) * TAPS;
            let acc = 0;
            for (let t = 0; t < TAPS; t++) acc += this.buf[base - HALF + 1 + t] * kern[p + t];
            out[i] = acc;
            pos += this.step;
        }

        // Drop everything the kernel can no longer reach back to.
        const keepFrom = Math.max(0, Math.floor(pos) - HALF);
        this.buf = this.buf.slice(keepFrom);
        this.pos = pos - keepFrom;
        return out;
    }

    // Pads with silence so the samples still inside the kernel's reach come
    // out. Call once, at end of stream.
    flush(): Float32Array {
        if (this.passthrough) return new Float32Array(0);
        return this.push(new Float32Array(TAPS));
    }
}

// --- chunking --------------------------------------------------------------

// Conformer self-attention is quadratic in sequence length, so one pass over a
// whole film is not slow, it is impossible. Splitting is also FASTER than a
// single pass at any length worth transcribing: measured here, 66 s in one
// piece took 4.1 s while the same audio in three chunks took 3.4 s, and 308 s
// in one piece took 39 s.
//
// Same shape as fastvoice's streaming loop (RMS over short frames, cut after a
// sustained quiet run), but offline: we can see the whole buffer, so a cut
// lands in the MIDDLE of a silent run rather than at its leading edge.
const FRAME_SEC = 0.16;           // fastvoice SECONDS_PER_CHUNK
const SILENCE_RMS = 0.005;        // fastvoice SILENCE_THRESHOLD
// Shorter than fastvoice's 2.0: film dialogue rarely pauses that long, and we
// only need a seam, not an end-of-utterance decision.
const SILENCE_GAP_SEC = 0.6;
const MAX_CHUNK_SEC = 25;
const MIN_CHUNK_SEC = 5;

export interface AudioChunk {
    pcm: Float32Array;
    // Offset within the buffer handed to chunkAudio, in seconds.
    offsetSec: number;
}

export function chunkAudio(pcm: Float32Array, rate: number): AudioChunk[] {
    const frame = Math.round(FRAME_SEC * rate);
    const nFrames = Math.ceil(pcm.length / frame);
    const rms = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
        let sum = 0;
        const a = f * frame, b = Math.min(pcm.length, a + frame);
        for (let i = a; i < b; i++) sum += pcm[i] * pcm[i];
        rms[f] = Math.sqrt(sum / Math.max(1, b - a));
    }
    const gapFrames = Math.max(1, Math.round(SILENCE_GAP_SEC / FRAME_SEC));
    const minFrames = Math.round(MIN_CHUNK_SEC / FRAME_SEC);
    const maxFrames = Math.round(MAX_CHUNK_SEC / FRAME_SEC);

    const cuts: number[] = [];
    let start = 0, run = 0;
    for (let f = 0; f < nFrames; f++) {
        run = rms[f] < SILENCE_RMS ? run + 1 : 0;
        const len = f - start + 1;
        if (run >= gapFrames && len >= minFrames) {
            // Middle of the silent run: both sides keep a little padding, so a
            // word never lands hard against a boundary.
            const cut = f - Math.floor(run / 2);
            cuts.push(cut); start = cut; run = 0;
        } else if (len >= maxFrames) {
            // No usable silence -- cut at the quietest frame in the back half,
            // which is the least-bad seam available.
            let q = start + Math.floor(len / 2), qv = Infinity;
            for (let g = start + Math.floor(len / 2); g <= f; g++) if (rms[g] < qv) { qv = rms[g]; q = g; }
            cuts.push(q); start = q; run = 0;
        }
    }

    const bounds = [0, ...cuts.map(c => c * frame), pcm.length];
    const out: AudioChunk[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
        if (bounds[i + 1] - bounds[i] < rate * 0.2) continue;   // drop slivers
        out.push({ pcm: pcm.subarray(bounds[i], bounds[i + 1]), offsetSec: bounds[i] / rate });
    }
    return out;
}
