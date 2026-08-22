// Every subtitle a video offers, from every place one can hide: sidecar files
// beside it on disk, and tracks muxed into the container itself.
//
// Listing is deliberately separated from loading. Enumerating is cheap for all
// three sources (a folder listing; Matroska's Tracks element; an MP4 `moov`),
// while turning a track into cues is not -- an MKV needs a full cluster walk and
// an MP4 needs every subtitle sample read. So we list everything up front so the
// menu can show it, and pay the extraction cost only for what gets selected.

import { ensureFolder } from "../appState";
import { resolveFileHandle } from "../scan/folderTraversal";
import { extractMkvSubtitles, listMkvSubtitleTracks } from "./mkv";
import { extractMp4Subtitles, listMp4SubtitleTracks } from "./mp4";
import { listSidecarSubtitles, loadSidecarSubtitles } from "./sidecarSubtitles";
import { SubtitleTrack } from "./subtitles";

export type SubtitleSource = {
    // Stable across reloads of the same video, so a selection can be remembered.
    id: string;
    origin: "sidecar" | "embedded";
    // The language as the file states it: an ISO code for container tracks, a
    // free-form filename tag for sidecars, "" when nothing says.
    lang: string;
    // `lang` resolved to something readable, falling back to `lang` itself when
    // it isn't a code we know.
    langName: string;
    format: string;
    // Track name, filename -- whatever distinguishes two entries in the same
    // language. Empty when there's nothing useful to add.
    detail: string;
    // False for bitmap codecs we can't decode (PGS, DVBSUB). Listed anyway:
    // "this file has Spanish PGS subs we can't show" is useful information,
    // and hiding them makes the app look broken rather than honest.
    supported: boolean;
    load: () => Promise<SubtitleTrack | undefined>;
};

// ISO 639-2/B and 639-1 for the languages that actually turn up in rips. An
// unknown code falls through to being shown as-is, which is still better than
// hiding it -- the point is to make the menu readable, not to be exhaustive.
const LANG_NAMES: Record<string, string> = {
    ara: "Arabic", ar: "Arabic",
    bul: "Bulgarian", bg: "Bulgarian",
    chi: "Chinese", zho: "Chinese", zh: "Chinese",
    cze: "Czech", ces: "Czech", cs: "Czech",
    dan: "Danish", da: "Danish",
    dut: "Dutch", nld: "Dutch", nl: "Dutch",
    eng: "English", en: "English",
    est: "Estonian", et: "Estonian",
    fin: "Finnish", fi: "Finnish",
    fre: "French", fra: "French", fr: "French",
    ger: "German", deu: "German", de: "German",
    gre: "Greek", ell: "Greek", el: "Greek",
    heb: "Hebrew", he: "Hebrew",
    hin: "Hindi", hi: "Hindi",
    hrv: "Croatian", hr: "Croatian",
    hun: "Hungarian", hu: "Hungarian",
    ice: "Icelandic", isl: "Icelandic", is: "Icelandic",
    ind: "Indonesian", id: "Indonesian",
    ita: "Italian", it: "Italian",
    jpn: "Japanese", ja: "Japanese",
    kor: "Korean", ko: "Korean",
    lav: "Latvian", lv: "Latvian",
    lit: "Lithuanian", lt: "Lithuanian",
    may: "Malay", msa: "Malay", ms: "Malay",
    nor: "Norwegian", no: "Norwegian", nob: "Norwegian", nb: "Norwegian",
    pol: "Polish", pl: "Polish",
    por: "Portuguese", pt: "Portuguese",
    rum: "Romanian", ron: "Romanian", ro: "Romanian",
    rus: "Russian", ru: "Russian",
    slo: "Slovak", slk: "Slovak", sk: "Slovak",
    slv: "Slovenian", sl: "Slovenian",
    spa: "Spanish", es: "Spanish",
    srp: "Serbian", sr: "Serbian",
    swe: "Swedish", sv: "Swedish",
    tha: "Thai", th: "Thai",
    tur: "Turkish", tr: "Turkish",
    ukr: "Ukrainian", uk: "Ukrainian",
    vie: "Vietnamese", vi: "Vietnamese",
};

export function languageName(code: string): string {
    const c = code.trim().toLowerCase();
    if (!c) return "Unknown";
    return LANG_NAMES[c] ?? code.trim();
}

// True when a source's language matches what the viewer asked for. Both sides
// are normalised through LANG_NAMES so "en", "eng" and "English" all agree --
// otherwise a preference of "English" would never match a track tagged "eng".
export function matchesLanguage(source: SubtitleSource, want: string): boolean {
    const w = want.trim().toLowerCase();
    if (!w) return false;
    const wantName = languageName(w).toLowerCase();
    if (source.lang.trim().toLowerCase() === w) return true;
    if (source.langName.toLowerCase() === wantName) return true;
    // Sidecar tags are free-form ("Foo.english.forced.srt"), so fall back to a
    // substring test on the raw tag.
    return !!source.lang && source.lang.toLowerCase().includes(w);
}

// Rank sources for the automatic pick. A companion file beside the video wins
// outright: someone went and put it there for this rip, which is a stronger
// signal than anything the muxer happened to leave inside the container. Only
// once that class is settled do language, then text-over-bitmap, break ties --
// so a sidecar still loses to another SIDECAR in the preferred language, but
// never to an embedded track. Unsupported codecs are never auto-selected.
export function pickDefaultSource(sources: SubtitleSource[], want: string): SubtitleSource | undefined {
    const usable = sources.filter(s => s.supported);
    if (!usable.length) return undefined;
    const score = (s: SubtitleSource) =>
        (s.origin === "sidecar" ? 1000 : 0)
        + (matchesLanguage(s, want) ? 100 : 0)
        + (s.format === "VobSub" ? 0 : 10);
    return [...usable].sort((a, b) => score(b) - score(a))[0];
}

export async function listSubtitleSources(relativePath: string): Promise<SubtitleSource[]> {
    const sources: SubtitleSource[] = [];

    for (const s of await listSidecarSubtitles(relativePath)) {
        sources.push({
            id: `sidecar:${s.name}`,
            origin: "sidecar",
            lang: s.tag,
            langName: languageName(s.tag),
            format: s.ext.toUpperCase(),
            detail: s.name,
            supported: true,
            load: () => loadSidecarSubtitles(relativePath, s.name),
        });
    }

    const isMkv = /\.(mkv|webm)$/i.test(relativePath);
    const isMp4 = /\.(mp4|m4v|mov)$/i.test(relativePath);
    if (isMkv || isMp4) {
        // mediabunny can't help here: it only knows WebVTT, and its ISOBMFF
        // demuxer discards any track whose handler isn't `vide`/`soun` before
        // building a sample table. Hence our own readers for both containers.
        const file = await openVideo(relativePath);
        if (file) {
            try {
                if (isMkv) {
                    for (const t of await listMkvSubtitleTracks(file)) {
                        sources.push({
                            id: `mkv:${t.number}`,
                            origin: "embedded",
                            lang: t.lang,
                            langName: languageName(t.lang),
                            format: t.codec,
                            detail: t.name,
                            supported: t.supported,
                            load: () => extractMkvSubtitles(file, t.number),
                        });
                    }
                } else {
                    for (const t of await listMp4SubtitleTracks(file)) {
                        sources.push({
                            id: `mp4:${t.index}`,
                            origin: "embedded",
                            lang: t.lang,
                            langName: languageName(t.lang),
                            format: t.codec,
                            detail: "",
                            supported: true,
                            load: () => extractMp4Subtitles(file, t.index),
                        });
                    }
                }
            } catch {
                // Unparseable container. The sidecars we already found stand.
            }
        }
    }

    return sources;
}

async function openVideo(relativePath: string): Promise<File | undefined> {
    try {
        const root = await ensureFolder();
        if (!root) return undefined;
        const handle = await resolveFileHandle(root, relativePath);
        return await handle.getFile();
    } catch {
        return undefined;
    }
}
