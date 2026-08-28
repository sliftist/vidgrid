// Saved output of subtitle generation, so transcribing a film is paid once.
//
// TWO texts are kept, never one. The transcript is what the speech model heard;
// the translation is a SECOND model's rendering of that transcript. Keeping
// both is the whole point of this file: translating is a guess about a guess,
// so you want to redo it -- different target language, better model, or just
// because the last pass was bad -- and redoing it must never mean running the
// 456 MB speech model over two hours of audio again. "Translate" reads the
// stored transcript and writes a new translation BESIDE it; the transcript is
// never overwritten by a translation.
//
// Kept appState-free (it only needs BulkDatabase2 and the cue type) so nothing
// here drags the app's module graph into a worker.

import { BulkDatabase2 } from "sliftutils/storage/BulkDatabase2/BulkDatabase2";
import { SubtitleCue } from "../player/subtitles";

// Bump when a stored transcript stops meaning what it used to -- a different
// speech model, or changed cue segmentation. Old rows then read as stale
// instead of being silently mixed in with new ones.
export const TRANSCRIPT_VERSION = 1;

export interface GeneratedSubtitleRecord {
    key: string;                      // file key == relative path, same as `files`

    // --- Light columns. A "does this video have a transcript?" scan reads only
    // these, and column granularity IS the storage granularity, so the cue text
    // below must stay in its own columns or every such scan pays for it.
    transcriptVersion?: number;
    transcriptModel?: string;
    transcriptAt?: number;
    // The span of the file the transcript actually covers. Streaming generation
    // starts at the playhead and stops when you stop watching, so rows are very
    // often PARTIAL -- translating or trusting one without knowing that is how
    // you end up with a film subtitled only between 0:12 and 0:31.
    transcriptFromSec?: number;
    transcriptToSec?: number;
    durationSec?: number;
    cueCount?: number;

    translationLanguage?: string;
    translationModel?: string;
    translationAt?: number;

    // --- Heavy columns, read only when the cues are actually wanted.
    transcriptCues?: string;
    translationCues?: string;
}

export const generatedSubtitles =
    new BulkDatabase2<GeneratedSubtitleRecord>("vidgrid_gen_subtitles");

// Tuple form rather than {startMs, endMs, text} objects: for a two-hour film's
// worth of cues the repeated key names would be most of the bytes.
function encodeCues(cues: SubtitleCue[]): string {
    return JSON.stringify(cues.map(c => [c.startMs, c.endMs, c.text]));
}

function decodeCues(raw: string | undefined): SubtitleCue[] {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return [];
        return arr.map((c: any) => ({
            startMs: Number(c[0]) || 0,
            endMs: Number(c[1]) || 0,
            text: String(c[2] ?? ""),
        }));
    } catch {
        // A row we can't parse is a row we don't have. Regenerating is always
        // possible, so there is nothing to salvage and nothing to report.
        return [];
    }
}

export interface SavedGeneration {
    transcript: SubtitleCue[];
    translation: SubtitleCue[];
    translationLanguage: string | undefined;
    fromSec: number;
    toSec: number;
    durationSec: number;
    model: string;
    at: number;
    // Reaches both ends of the file, within a second. Only a complete
    // transcript is worth translating.
    complete: boolean;
}

// How close to the file's edges a transcript has to reach to count as covering
// it. A cue boundary and a container duration never agree exactly.
const EDGE_SLOP_SEC = 2;

function isComplete(fromSec: number, toSec: number, durationSec: number): boolean {
    if (!durationSec) return false;
    return fromSec <= EDGE_SLOP_SEC && toSec >= durationSec - EDGE_SLOP_SEC;
}

export async function loadGeneration(key: string): Promise<SavedGeneration | undefined> {
    const version = await generatedSubtitles.getSingleField(key, "transcriptVersion");
    if (version !== TRANSCRIPT_VERSION) return undefined;
    const transcript = decodeCues(await generatedSubtitles.getSingleField(key, "transcriptCues"));
    if (!transcript.length) return undefined;
    const fromSec = await generatedSubtitles.getSingleField(key, "transcriptFromSec") ?? 0;
    const toSec = await generatedSubtitles.getSingleField(key, "transcriptToSec") ?? 0;
    const durationSec = await generatedSubtitles.getSingleField(key, "durationSec") ?? 0;
    return {
        transcript,
        translation: decodeCues(await generatedSubtitles.getSingleField(key, "translationCues")),
        translationLanguage: await generatedSubtitles.getSingleField(key, "translationLanguage"),
        fromSec,
        toSec,
        durationSec,
        model: await generatedSubtitles.getSingleField(key, "transcriptModel") ?? "",
        at: await generatedSubtitles.getSingleField(key, "transcriptAt") ?? 0,
        complete: isComplete(fromSec, toSec, durationSec),
    };
}

// Save a finished run. A new transcript invalidates whatever translation was
// stored against the old one -- the lines no longer correspond -- so those
// columns are cleared rather than left to describe text that is gone.
//
// A run that covers LESS of the file than what is already saved is dropped.
// Otherwise pressing Generate at 1:30:00 to check one line would replace a
// whole film's transcript with twenty minutes of it.
export async function saveTranscript(key: string, gen: {
    cues: SubtitleCue[];
    model: string;
    fromSec: number;
    toSec: number;
    durationSec: number;
}): Promise<boolean> {
    if (!gen.cues.length) return false;
    const prevVersion = await generatedSubtitles.getSingleField(key, "transcriptVersion");
    if (prevVersion === TRANSCRIPT_VERSION) {
        const prevFrom = await generatedSubtitles.getSingleField(key, "transcriptFromSec") ?? 0;
        const prevTo = await generatedSubtitles.getSingleField(key, "transcriptToSec") ?? 0;
        const prevSpan = Math.max(0, prevTo - prevFrom);
        if (prevSpan > Math.max(0, gen.toSec - gen.fromSec)) return false;
    }
    await generatedSubtitles.write({
        key,
        transcriptVersion: TRANSCRIPT_VERSION,
        transcriptModel: gen.model,
        transcriptAt: Date.now(),
        transcriptFromSec: gen.fromSec,
        transcriptToSec: gen.toSec,
        durationSec: gen.durationSec,
        cueCount: gen.cues.length,
        transcriptCues: encodeCues(gen.cues),
        translationLanguage: undefined,
        translationModel: undefined,
        translationAt: undefined,
        translationCues: undefined,
    });
    return true;
}

export async function saveTranslation(key: string, tr: {
    cues: SubtitleCue[];
    language: string;
    model: string;
}): Promise<void> {
    await generatedSubtitles.write({
        key,
        translationLanguage: tr.language,
        translationModel: tr.model,
        translationAt: Date.now(),
        translationCues: encodeCues(tr.cues),
    });
}

export async function deleteGeneration(key: string): Promise<void> {
    await generatedSubtitles.delete(key);
}
