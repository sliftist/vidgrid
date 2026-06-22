// Drop-in stand-in for mediabunny's AudioSampleSink for DTS (DCA) tracks, which
// mediabunny can demux but not decode. It pulls raw EncodedPackets and runs
// them through our pure-JS DTS Core decoder (./dts), wrapping the PCM in
// AudioSample objects so the existing AudioPlayback path consumes them
// unchanged. Exposes the same `samples(startSec)` async-iterator shape as
// AudioSampleSink, so VideoPlayer/TvHackAudio can use either interchangeably.
//
// DO NOT USE DYNAMIC IMPORTS — the concrete browser bundle is imported directly
// (the package's node build doesn't bundle), matching the rest of web/player/.
import {
    EncodedPacketSink,
    AudioSample,
    InputAudioTrack,
} from "mediabunny/dist/bundles/mediabunny.cjs";
import { DcaDecoder } from "./dts/dcacore";

// DTS Core sync word (big-endian 14-bit core stream). Other DTS variants use
// 0x1FFFE800 (14-bit LE), 0xFF1F00E8 / 0xE8001FFF (16-bit), but mediabunny's
// container packets carry the canonical 0x7FFE8001 core for the streams we
// target; we sniff this to confirm a null-codec audio track is really DTS.
const DTS_CORE_SYNC = 0x7ffe8001;

export function looksLikeDtsCore(data: Uint8Array): boolean {
    if (data.length < 4) return false;
    const w = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    return w === DTS_CORE_SYNC;
}

export class DtsAudioSink {
    private packetSink: EncodedPacketSink;

    constructor(track: InputAudioTrack) {
        this.packetSink = new EncodedPacketSink(track);
    }

    // Yields decoded AudioSamples starting at/after `startSec`. A fresh decoder
    // is created per call so that seeks (which re-invoke this) reset inter-frame
    // history — like ffmpeg's predictor reset; the first frame after a seek may
    // have a brief transient, then it converges.
    async *samples(startSec: number = 0): AsyncGenerator<AudioSample, void, unknown> {
        const dec = new DcaDecoder();
        const start = await this.packetSink.getPacket(Math.max(0, startSec));
        if (!start) return;
        // CRITICAL: a DTS core frame is exactly 512 samples = 10.667 ms, but MKV
        // quantizes packet timestamps to whole milliseconds, so pkt.timestamp
        // jitters 10/11/12 ms. AudioPlayback schedules each buffer at its
        // timestamp, so using the raw (jittery) timestamps makes consecutive
        // 512-sample buffers overlap/gap by up to ~0.3 ms every frame — an
        // audible buzz at the ~94 Hz frame rate. (AC-3 escapes this only because
        // its frame is exactly 32 ms.) Anchor at the first packet, then advance
        // by the EXACT decoded sample count so the buffers are perfectly
        // contiguous and the audio clock is sample-accurate.
        let baseTs: number | undefined;
        let emitted = 0; // samples emitted since the anchor
        for await (const pkt of this.packetSink.packets(start)) {
            let frame;
            try {
                frame = dec.decodeFrame(pkt.data);
            } catch (err) {
                // A bad/extension packet shouldn't kill the whole track — skip it.
                console.warn(`[dts] frame decode failed @${pkt.timestamp.toFixed(3)}s:`, (err as Error).message);
                continue;
            }
            const { pcm, channels, sampleRate, samples } = frame;
            if (baseTs === undefined) baseTs = pkt.timestamp;
            const timestamp = baseTs + emitted / sampleRate;
            emitted += samples;
            // Pack per-channel Float32Arrays into one planar (f32-planar) buffer:
            // [ch0 frames][ch1 frames]… which AudioPlayback reads via copyTo.
            const planar = new Float32Array(channels * samples);
            for (let c = 0; c < channels; c++) planar.set(pcm[c], c * samples);
            yield new AudioSample({
                data: planar,
                format: "f32-planar",
                numberOfChannels: channels,
                sampleRate,
                timestamp,
            });
        }
    }
}
