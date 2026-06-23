// Thin async wrappers around the system ffprobe / ffmpeg binaries. Used both by
// the analyzer (to bulk-classify what's actually inside a failing file) and by
// the ffprobeCli.ts entry point (manual one-off inspection).
//
// async spawn, never spawnSync — a single pathological file shouldn't block the
// event loop, and we want a hard per-call timeout so the whole sweep can't stall
// on one corrupt input.

import { spawn } from "child_process";

// On PATH on this machine. Hoisted so a different install location is a
// one-line change rather than buried in the spawn calls.
const FFPROBE = "ffprobe";
const FFMPEG = "ffmpeg";
const PROBE_TIMEOUT_MS = 30_000;
const DECODE_TIMEOUT_MS = 60_000;
// How many seconds of video the decode test actually decodes. Long enough to
// get past the header into real frame data (where decoder errors surface),
// short enough to stay fast across hundreds of files.
const DECODE_TEST_SECONDS = 4;

interface RunResult {
    code: number | undefined;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    spawnError?: string;
}

function run(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
    return new Promise<RunResult>(resolve => {
        const child = spawn(bin, args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("error", err => {
            clearTimeout(timer);
            resolve({ code: undefined, stdout, stderr, timedOut, spawnError: (err as Error).stack ?? String(err) });
        });
        child.on("close", code => {
            clearTimeout(timer);
            resolve({ code: code ?? undefined, stdout, stderr, timedOut });
        });
    });
}

export interface ProbeStream {
    index: number;
    codec_type?: string;
    codec_name?: string;
    codec_long_name?: string;
    codec_tag_string?: string;
    profile?: string;
    pix_fmt?: string;
    width?: number;
    height?: number;
    channels?: number;
    sample_rate?: string;
    bit_rate?: string;
    duration?: string;
}

export interface ProbeFormat {
    format_name?: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    nb_streams?: number;
}

export interface FfprobeResult {
    ok: boolean;
    format?: ProbeFormat;
    streams: ProbeStream[];
    // ffprobe still prints warnings to stderr even on success (e.g. a partly
    // unreadable stream); kept so the caller can see them.
    stderr?: string;
    error?: string;
}

// Header/container probe. Reads structure without fully decoding — fast, and
// enough to tell us the real codec/container of a file the browser rejected.
export async function runFfprobe(absPath: string): Promise<FfprobeResult> {
    const res = await run(FFPROBE, [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        absPath,
    ], PROBE_TIMEOUT_MS);
    if (res.spawnError) return { ok: false, streams: [], error: `ffprobe spawn failed: ${res.spawnError}` };
    if (res.timedOut) return { ok: false, streams: [], error: `ffprobe timed out after ${PROBE_TIMEOUT_MS}ms` };
    const text = res.stdout.trim();
    if (!text) {
        return { ok: false, streams: [], error: res.stderr.trim() || `ffprobe exited ${res.code} with no output` };
    }
    let parsed: { format?: ProbeFormat; streams?: ProbeStream[] };
    try {
        parsed = JSON.parse(text) as { format?: ProbeFormat; streams?: ProbeStream[] };
    } catch (err) {
        return { ok: false, streams: [], error: `ffprobe JSON parse failed: ${(err as Error).message}` };
    }
    return {
        ok: true,
        format: parsed.format,
        streams: parsed.streams ?? [],
        stderr: res.stderr.trim() || undefined,
        error: res.code !== 0 ? `ffprobe exited ${res.code}` : undefined,
    };
}

export interface DecodeTestResult {
    ok: boolean;
    timedOut: boolean;
    stderr: string;
    code: number | undefined;
}

// Actually decode the first few seconds to a null sink. Surfaces real decoder
// failures (broken bitstreams, unsupported profiles) that a header-only probe
// wouldn't catch. `-xerror` makes ffmpeg exit non-zero on the first decode error
// instead of soldiering on.
export async function ffmpegDecodeTest(absPath: string, seconds = DECODE_TEST_SECONDS): Promise<DecodeTestResult> {
    const res = await run(FFMPEG, [
        "-v", "error",
        "-xerror",
        "-t", String(seconds),
        "-i", absPath,
        "-an",
        "-f", "null",
        "-",
    ], DECODE_TIMEOUT_MS);
    if (res.spawnError) return { ok: false, timedOut: false, stderr: `ffmpeg spawn failed: ${res.spawnError}`, code: undefined };
    return {
        ok: res.code === 0 && !res.timedOut,
        timedOut: res.timedOut,
        stderr: res.stderr.trim(),
        code: res.code,
    };
}

// Codecs that only ever appear as attached cover art / thumbnails in a video
// stream slot — not a real, decodable moving picture. A file whose only "video"
// is one of these has no frame we'd thumbnail.
const COVER_ART_CODECS = new Set(["mjpeg", "png", "bmp", "gif", "webp"]);

export interface ProbeSummary {
    // ffprobe opened the container and found streams.
    ok: boolean;
    // At least one real (non-cover-art) video stream — i.e. something we could
    // decode a thumbnail from offline.
    hasVideo: boolean;
    container?: string;
    video: string[];
    audio: string[];
    // First real video codec (what the codec-bucket rules key on).
    primaryVideo?: string;
    // Tail of the ffprobe error/stderr when it couldn't open the file.
    ffError?: string;
}

export function summarizeProbe(p: FfprobeResult): ProbeSummary {
    const video = p.streams.filter(s => s.codec_type === "video").map(s => s.codec_name ?? "?");
    const audio = p.streams.filter(s => s.codec_type === "audio").map(s => s.codec_name ?? "?");
    const realVideo = video.filter(c => !COVER_ART_CODECS.has(c));
    const ok = p.ok && p.streams.length > 0;
    const ffError = !ok ? (p.error ?? p.stderr ?? "no streams").split("\n").slice(-2).join(" ").slice(0, 200) : undefined;
    return {
        ok,
        hasVideo: realVideo.length > 0,
        container: p.format?.format_name,
        video,
        audio,
        primaryVideo: realVideo[0],
        ffError,
    };
}

// Compact one-line description of what ffprobe found, for grouping/printing.
export function describeProbe(p: FfprobeResult): string {
    if (!p.ok) return `PROBE-FAILED: ${p.error ?? "unknown"}`;
    const container = p.format?.format_name ?? "?";
    const vids = p.streams.filter(s => s.codec_type === "video");
    const auds = p.streams.filter(s => s.codec_type === "audio");
    const vDesc = vids.map(s => s.codec_name ?? "?").join(",") || "none";
    const aDesc = auds.map(s => s.codec_name ?? "?").join(",") || "none";
    return `${container} | v=${vDesc} a=${aDesc}`;
}
