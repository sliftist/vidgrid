// Helsinki-NLP opus-mt: one small purpose-built translation model per source
// language, all of them into English.
//
// These are Marian encoder-decoders of about 129 MB unpacked (q8), and they
// beat a 360M instruct LLM at this job outright -- translation is the only
// thing they were trained to do, so there is no instruction to misread and no
// commentary to strip out of the answer.
//
// The catch, and the reason for everything below: each model handles exactly
// ONE source language. So the source language has to be known before a model
// can be chosen, and 22 archives have to be hosted without making the viewer
// download 1.6 GB to use one of them.
//
//   Source language  -> franc, a pure n-gram detector. No model download, and a
//                       transcript is thousands of words, which is far more
//                       than it needs to be certain.
//   Hosting          -> all 22 archives are concatenated into ONE uploaded
//                       file with a JSON index at the front, and the browser
//                       Range-gets just the slice it needs (see buildpack).

// franc 5, deliberately, not 6. Version 6 is ESM-only, and the bundler emits
// such a package into the output verbatim -- leaving a bare `import` in a
// classic script, which takes the whole page down with "Cannot use import
// statement outside a module". 5.0.0 is the same detector as CommonJS.
import * as francModule from "franc";
import { MODEL_BASE_URL } from "./models";
import { ensureTarballExtracted, modelTarCache, TarProgress } from "./tarball";

// Layout: "OPUSPACK1", then the index length as 16 zero-padded ASCII digits,
// then the index JSON, then every .tar.gz back to back. Offsets are absolute,
// so one index read is enough to fetch any member.
export const OPUS_PACK_URL = MODEL_BASE_URL + "opus-mt-en-q8.pack";

// Every language's tokenizer.json, in one small archive, fetched once and
// shared by all of them.
//
// It is separate from the pack because it is not optional and it was not in
// it: transformers.js treats tokenizer.json as a fatal load for Marian models,
// so a language slice on its own cannot start. Splitting it out this way also
// means switching languages later costs nothing -- 21 MB covers all 22.
export const OPUS_TOKENIZERS_URL = MODEL_BASE_URL + "opus-mt-tokenizers.tar.gz";
const TOKENIZERS_UNPACKED_BYTES = 137_000_000;
const PACK_MAGIC = "OPUSPACK1";
const PACK_HEADER_BYTES = PACK_MAGIC.length + 16;
// Comfortably covers header + index (~750 bytes) in a single round trip.
const PACK_PROBE_BYTES = 65536;

// What one language occupies unpacked, for the storage-headroom check: encoder
// ~61 MB + decoder ~68 MB + tokenizer files.
const UNPACKED_BYTES = 140_000_000;

interface PackEntry { o: number; n: number; }

let packIndexPromise: Promise<Record<string, PackEntry>> | undefined;

async function packIndex(): Promise<Record<string, PackEntry>> {
    if (!packIndexPromise) {
        packIndexPromise = (async () => {
            const res = await fetch(OPUS_PACK_URL, {
                headers: { Range: `bytes=0-${PACK_PROBE_BYTES - 1}` },
            });
            if (res.status !== 206) {
                throw new Error(
                    `Could not read the translation model index: the server answered `
                    + `HTTP ${res.status} to a range request. Hosting must support ranges, `
                    + `otherwise using one model means downloading all 1.6 GB.`);
            }
            const head = new Uint8Array(await res.arrayBuffer());
            const text = new TextDecoder().decode(head);
            if (!text.startsWith(PACK_MAGIC)) {
                throw new Error("The translation model pack is not in the expected format.");
            }
            const indexLen = parseInt(text.slice(PACK_MAGIC.length, PACK_HEADER_BYTES), 10);
            if (!indexLen || PACK_HEADER_BYTES + indexLen > head.length) {
                throw new Error("The translation model pack has an unreadable index.");
            }
            return JSON.parse(text.slice(PACK_HEADER_BYTES, PACK_HEADER_BYTES + indexLen));
        })().catch(e => {
            packIndexPromise = undefined;
            throw e;
        });
    }
    return packIndexPromise;
}

// --- language identification ----------------------------------------------

// franc answers in ISO 639-3; the pack is keyed by the short code opus-mt uses
// in its own model names.
const ISO3_TO_PACK: Record<string, string> = {
    arb: "ar", ara: "ar", ces: "cs", dan: "da", deu: "de", spa: "es", fin: "fi",
    fra: "fr", hin: "hi", hun: "hu", ind: "id", ita: "it", jpn: "ja", kor: "ko",
    nld: "nl", pol: "pl", rus: "ru", swe: "sv", tur: "tr", ukr: "uk", vie: "vi",
    cmn: "zh", zho: "zh", yue: "zh",
};

// No dedicated model in the pack, but opus-mt-mul-en covers them. Quality is
// below a dedicated pair, which is exactly why it is the fallback and not the
// default.
const ISO3_VIA_MUL = ["por", "ell", "heb", "ron", "nor", "nob", "slk", "slv", "hrv", "srp", "bul", "cat", "lit", "lav", "est", "tha", "msa", "fas", "urd", "ben", "tam"];

const ISO3_NAMES: Record<string, string> = {
    arb: "Arabic", ara: "Arabic", ces: "Czech", dan: "Danish", deu: "German",
    spa: "Spanish", fin: "Finnish", fra: "French", hin: "Hindi", hun: "Hungarian",
    ind: "Indonesian", ita: "Italian", jpn: "Japanese", kor: "Korean",
    nld: "Dutch", pol: "Polish", rus: "Russian", swe: "Swedish", tur: "Turkish",
    ukr: "Ukrainian", vie: "Vietnamese", cmn: "Chinese", zho: "Chinese", yue: "Chinese",
    por: "Portuguese", ell: "Greek", heb: "Hebrew", ron: "Romanian",
    nor: "Norwegian", nob: "Norwegian", slk: "Slovak", slv: "Slovenian",
    hrv: "Croatian", srp: "Serbian", bul: "Bulgarian", cat: "Catalan",
    lit: "Lithuanian", lav: "Latvian", est: "Estonian", tha: "Thai",
    msa: "Malay", fas: "Persian", urd: "Urdu", ben: "Bengali", tam: "Tamil",
    eng: "English",
};

// Confining franc to languages we can act on is what keeps it from answering
// with a plausible-looking neighbour we have no model for (Frisian for Dutch,
// Occitan for French). English is in the list precisely so it CAN be the
// answer -- that is the signal to skip translating entirely.
const DETECTABLE = ["eng", ...Object.keys(ISO3_TO_PACK), ...ISO3_VIA_MUL];

export interface DetectedLanguage {
    iso3: string;
    name: string;
    // Which archive in the pack translates it. Undefined when iso3 is English.
    pack: string | undefined;
    // True when the only model that covers it is the multilingual fallback.
    viaMul: boolean;
}

// Identifies the language of transcript text. Returns undefined only when
// there is too little text to judge.
export function detectLanguage(text: string): DetectedLanguage | undefined {
    const sample = text.trim();
    if (sample.length < 24) return undefined;
    // v5 spells the restriction "whitelist"; v6 renamed it "only".
    const franc = francModule as unknown as
        (text: string, opts?: { whitelist?: string[] }) => string;
    const iso3 = franc(sample, { whitelist: DETECTABLE });
    if (iso3 === "und") return undefined;
    const pack = ISO3_TO_PACK[iso3];
    return {
        iso3,
        name: ISO3_NAMES[iso3] ?? iso3,
        pack: iso3 === "eng" ? undefined : pack ?? "mul",
        viaMul: iso3 !== "eng" && !pack,
    };
}

// The transcript is a list of cues; language is a property of the whole thing,
// so judge it on the joined text rather than on one line that might be a name.
export function detectLanguageOfCues(cues: { text: string }[]): DetectedLanguage | undefined {
    return detectLanguage(cues.map(c => c.text).join(" ").slice(0, 20000));
}

// --- model fetch -----------------------------------------------------------

export function opusRepo(packLang: string): string {
    return `Xenova/opus-mt-${packLang}-en`;
}

// Downloads and unpacks just this language's slice of the pack. Idempotent.
export async function ensureOpusModel(
    packLang: string, label: string, onProgress?: TarProgress,
): Promise<string> {
    const index = await packIndex();
    const entry = index[packLang];
    if (!entry) {
        throw new Error(`No translation model for ${label} is available.`);
    }
    const repo = opusRepo(packLang);
    modelTarCache.registerRepo(repo);
    // Tokenizers first: 21 MB against the model's 75, so a failure here is
    // cheap, and without it the model that follows could not run anyway.
    await ensureTarballExtracted(
        OPUS_TOKENIZERS_URL, "translation tokenizers", onProgress, TOKENIZERS_UNPACKED_BYTES);
    await ensureTarballExtracted(
        OPUS_PACK_URL, `${label} translation model`, onProgress, UNPACKED_BYTES,
        { offset: entry.o, length: entry.n });
    return repo;
}
