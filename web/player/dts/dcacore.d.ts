// Type surface for the pure-JS DTS Core decoder (./index.js -> ./dcacore.js).

/** One decoded DTS Core frame. PCM is canonical WAV/Web-Audio speaker order. */
export interface DcaFrame {
    /** Output sample rate in Hz. */
    sampleRate: number;
    /** Number of output channels (includes LFE when present). */
    channels: number;
    /** Speaker label per channel, e.g. ["FL","FR","FC","LFE","SL","SR"]. */
    layout: string[];
    /** Decoded samples per channel for this frame. */
    samples: number;
    /** Bytes consumed by this frame (advance the reader by this much). */
    frameSize: number;
    /** One Float32Array per channel, samples in [-1, 1]. */
    pcm: Float32Array[];
}

/**
 * Streaming DTS Core decoder. Inter-frame ADPCM/QMF/LFE history carries between
 * calls, so frames must be fed in order. Construct a fresh instance after a seek
 * (a new instance starts with zeroed history, like ffmpeg's predictor reset).
 */
export class DcaDecoder {
    constructor();
    /** Decode one core frame (must begin with the 0x7FFE8001 sync word). */
    decodeFrame(bytes: Uint8Array | ArrayBuffer): DcaFrame;
}

/** Batch-decode a buffer of concatenated core frames into per-channel PCM. */
export function decodeFile(bytes: Uint8Array | ArrayBuffer): {
    sampleRate: number;
    channels: number;
    layout: string[];
    pcm: Float32Array[];
};
