process.chdir(process.argv[2] || ".");

import { transcripts } from "../web/appState";
import { decodeTranscript, groupTranscriptLines } from "../web/transcript/transcriptFormat";

const WORDS_PER_MINUTE_BUCKET_MS = 5 * 60 * 1000;

function clock(ms: number): string {
    let total = Math.floor(ms / 1000);
    let h = Math.floor(total / 3600);
    let m = Math.floor((total % 3600) / 60);
    let s = total % 60;
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function main(): Promise<void> {
    let key = process.argv[3];
    let maxLines = Number(process.argv[4] ?? 0);
    let versions = await transcripts.getColumn("transcriptVersion");
    if (!key) {
        for (let { key: fileKey, value } of versions) {
            let [words, error, noAudio, audioSeconds, extractionMs, model] = await Promise.all([
                transcripts.getSingleField(fileKey, "transcriptWordCount"),
                transcripts.getSingleField(fileKey, "transcriptError"),
                transcripts.getSingleField(fileKey, "transcriptNoAudio"),
                transcripts.getSingleField(fileKey, "transcriptAudioSeconds"),
                transcripts.getSingleField(fileKey, "transcriptExtractionMs"),
                transcripts.getSingleField(fileKey, "transcriptModel"),
            ]);
            console.log(`${fileKey}: version ${value}, ${words} words, ${audioSeconds}s of audio, extraction ${extractionMs}ms, noAudio ${noAudio}, model ${model}, error ${JSON.stringify(error)}`);
        }
        return;
    }
    let bytes = await transcripts.getSingleField(key, "transcript");
    let decoded = decodeTranscript(bytes);
    if (!decoded) {
        console.log(`no decodable transcript for ${key} (${bytes?.byteLength ?? 0} bytes stored)`);
        return;
    }
    let buckets = new Map<number, number>();
    for (let startMs of decoded.startsMs) {
        let bucket = Math.floor(startMs / WORDS_PER_MINUTE_BUCKET_MS);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    console.log(`${key}: ${decoded.words.length} words in ${bytes?.byteLength} bytes; words per 5 minutes: ${[...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([bucket, count]) => `${clock(bucket * WORDS_PER_MINUTE_BUCKET_MS)}=${count}`).join(" ")}`);
    let lines = groupTranscriptLines(decoded);
    for (let line of maxLines > 0 ? lines.slice(0, maxLines) : lines) {
        console.log(`${clock(line.startMs)}  ${line.text}`);
    }
}

main().then(() => process.exit(0), err => {
    console.error((err as Error).stack ?? err);
    process.exit(1);
});
