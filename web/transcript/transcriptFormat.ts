export const TRANSCRIPT_VERSION = 1;

const TRANSCRIPT_MAGIC = 0x31525456;
const HEADER_BYTES = 12;
const BYTES_PER_WORD_TIMES = 8;
const WORD_SEPARATOR = "\n";
const LINE_GAP_MS = 1200;
const LINE_MAX_MS = 12_000;
const LINE_MIN_MS_BEFORE_SENTENCE_BREAK = 2500;
const SENTENCE_END = /[.!?]["')\]]*$/;

export type TranscriptWords = {
    words: string[];
    startsMs: number[];
    endsMs: number[];
};

export type TranscriptLine = {
    startMs: number;
    endMs: number;
    text: string;
};

export function encodeTranscript(transcript: TranscriptWords): Uint8Array {
    let count = transcript.words.length;
    let text = new TextEncoder().encode(transcript.words.map(word => word.replaceAll(WORD_SEPARATOR, " ")).join(WORD_SEPARATOR));
    let out = new Uint8Array(HEADER_BYTES + count * BYTES_PER_WORD_TIMES + text.byteLength);
    let view = new DataView(out.buffer);
    view.setUint32(0, TRANSCRIPT_MAGIC, true);
    view.setUint32(4, count, true);
    view.setUint32(8, text.byteLength, true);
    let pos = HEADER_BYTES;
    for (let i = 0; i < count; i++) {
        view.setUint32(pos, Math.max(0, Math.round(transcript.startsMs[i])), true);
        pos += 4;
    }
    for (let i = 0; i < count; i++) {
        view.setUint32(pos, Math.max(0, Math.round(transcript.endsMs[i])), true);
        pos += 4;
    }
    out.set(text, pos);
    return out;
}

export function decodeTranscript(bytes: Uint8Array | undefined): TranscriptWords | undefined {
    if (!bytes || bytes.byteLength < HEADER_BYTES) return undefined;
    let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== TRANSCRIPT_MAGIC) return undefined;
    let count = view.getUint32(4, true);
    let textBytes = view.getUint32(8, true);
    let textStart = HEADER_BYTES + count * BYTES_PER_WORD_TIMES;
    if (bytes.byteLength < textStart + textBytes) return undefined;
    let startsMs: number[] = [];
    let endsMs: number[] = [];
    let pos = HEADER_BYTES;
    for (let i = 0; i < count; i++) {
        startsMs.push(view.getUint32(pos, true));
        pos += 4;
    }
    for (let i = 0; i < count; i++) {
        endsMs.push(view.getUint32(pos, true));
        pos += 4;
    }
    let text = new TextDecoder().decode(bytes.subarray(textStart, textStart + textBytes));
    let words = count === 0 ? [] : text.split(WORD_SEPARATOR);
    if (words.length !== count) return undefined;
    return { words, startsMs, endsMs };
}

export function groupTranscriptLines(transcript: TranscriptWords): TranscriptLine[] {
    let lines: TranscriptLine[] = [];
    let current: TranscriptLine | undefined;
    for (let i = 0; i < transcript.words.length; i++) {
        let word = transcript.words[i];
        let startMs = transcript.startsMs[i];
        let endMs = transcript.endsMs[i];
        if (current) {
            let gapMs = startMs - current.endMs;
            let lineMs = current.endMs - current.startMs;
            let sentenceEnded = SENTENCE_END.test(current.text);
            if (gapMs > LINE_GAP_MS || lineMs > LINE_MAX_MS || sentenceEnded && lineMs > LINE_MIN_MS_BEFORE_SENTENCE_BREAK) {
                lines.push(current);
                current = undefined;
            }
        }
        if (!current) {
            current = { startMs, endMs, text: word };
        } else {
            current.text += " " + word;
            current.endMs = Math.max(current.endMs, endMs);
        }
    }
    if (current) {
        lines.push(current);
    }
    return lines;
}
