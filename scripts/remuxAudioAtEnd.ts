import fs from "fs";
import { ALL_FORMATS, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource, FilePathSource, FilePathTarget, Input, Mp4OutputFormat, Output } from "mediabunny";

const PROGRESS_LOG_INTERVAL_MS = 5000;

async function copyPackets(config: {
    label: string;
    sink: EncodedPacketSink;
    add: (packet: Parameters<EncodedVideoPacketSource["add"]>[0], isFirst: boolean) => Promise<void>;
    started: number;
}): Promise<void> {
    let count = 0;
    let bytes = 0;
    let lastLog = Date.now();
    for await (let packet of config.sink.packets()) {
        await config.add(packet, count === 0);
        count++;
        bytes += packet.data.byteLength;
        if (Date.now() - lastLog > PROGRESS_LOG_INTERVAL_MS) {
            lastLog = Date.now();
            console.log(`[remux] ${config.label}: ${count} packets, ${(bytes / 1e6).toFixed(1)} MB, at ${packet.timestamp.toFixed(1)}s of media, ${((Date.now() - config.started) / 1000).toFixed(1)}s elapsed`);
        }
    }
    console.log(`[remux] ${config.label}: wrote ${count} packets, ${(bytes / 1e6).toFixed(1)} MB, ${((Date.now() - config.started) / 1000).toFixed(1)}s elapsed`);
}

async function main(): Promise<void> {
    let [inputPath, outputPath] = process.argv.slice(2);
    if (!inputPath || !outputPath) {
        throw new Error("usage: yarn remux-audio-at-end <input video> <output .mp4>");
    }
    if (fs.existsSync(outputPath)) {
        throw new Error(`refusing to overwrite existing file ${outputPath}`);
    }
    let started = Date.now();
    let input = new Input({ source: new FilePathSource(inputPath), formats: ALL_FORMATS });
    let videoTrack = await input.getPrimaryVideoTrack();
    let audioTracks = await input.getAudioTracks();
    if (!videoTrack || !videoTrack.codec) {
        throw new Error(`no usable video track in ${inputPath}`);
    }
    let output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: new FilePathTarget(outputPath) });
    let videoSource = new EncodedVideoPacketSource(videoTrack.codec);
    output.addVideoTrack(videoSource, { languageCode: videoTrack.languageCode });
    let audioCopies: { track: typeof audioTracks[number]; source: EncodedAudioPacketSource }[] = [];
    for (let track of audioTracks) {
        if (!track.codec) {
            console.log(`[remux] not copying audio track ${track.id}: unknown codec`);
            continue;
        }
        let source = new EncodedAudioPacketSource(track.codec);
        output.addAudioTrack(source, { languageCode: track.languageCode });
        audioCopies.push({ track, source });
    }
    await output.start();

    let videoConfig = await videoTrack.getDecoderConfig();
    await copyPackets({
        label: `video ${videoTrack.codec}`,
        sink: new EncodedPacketSink(videoTrack),
        started,
        add: (packet, isFirst) => videoSource.add(packet, isFirst && videoConfig ? { decoderConfig: videoConfig } : undefined),
    });
    videoSource.close();
    for (let { track, source } of audioCopies) {
        let audioConfig = await track.getDecoderConfig();
        await copyPackets({
            label: `audio ${track.codec} track ${track.id}`,
            sink: new EncodedPacketSink(track),
            started,
            add: (packet, isFirst) => source.add(packet, isFirst && audioConfig ? { decoderConfig: audioConfig } : undefined),
        });
        source.close();
    }
    await output.finalize();
    console.log(`[remux] ${inputPath} (${(fs.statSync(inputPath).size / 1e6).toFixed(1)} MB) -> ${outputPath} (${(fs.statSync(outputPath).size / 1e6).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch(err => {
    console.error("[remux] failed:", (err as Error).stack ?? err);
    process.exit(1);
});
