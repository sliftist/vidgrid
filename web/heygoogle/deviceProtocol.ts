// Device side of the heygoogle protocol. The server's LLM reads CAPABILITIES
// (advertised at registration) and forms a `{payload}` whose `command` selects
// one of the handlers below. handleDeviceCall runs in an async context (driven
// by an inbound device-call frame), so every library read goes through the
// Promise column variants — never the reactive-only sync reads.

import { files, seriesMinVideos } from "../appState";
import { search } from "../search/searchPipeline";
import { getSeries, SeriesGroup, SeriesVideo } from "../search/series";
import { goToPlayer, goToPlayerFromSeries } from "../router";
import { getPlayerControls } from "./playerControls";
import { openNotification } from "./NotificationModal";
import { pushToast } from "./Toasts";
import { markBeingControlled } from "./client";
import { allThemes, setActiveTheme, BUILTIN_THEMES } from "../restyle/themes";

// Baked into the restyle command's description so the LLM knows the exact set of
// theme ids it can pass. Built from the built-in themes at module load.
const THEME_LIST = BUILTIN_THEMES.map(t => `"${t.id}" (${t.name})`).join(", ");

const MAX_SEARCH_RESULTS = 20;

const SEARCH_SYNTAX = "Exact, case-insensitive substring match over each file's name and path"
    + " (NOT fuzzy — the characters must appear in order). Operators: ' ' or '&' between"
    + " terms means AND (all must match), '|' means OR, and a leading '!' negates a term."
    + " Punctuation you type is matched literally; if you omit punctuation it is also ignored"
    + " in the results, so \"silence of\" matches \"silence.of\". Example: \"office & !christmas | parks\".";

// Advertised to the server at device registration (and re-sent via
// update-capabilities on connect). The LLM reads this to learn what payloads it
// may send. `payload.command` selects a handler; the other fields are that
// command's arguments.
export const CAPABILITIES = {
    app: "vidgrid",
    description: "A personal video library. Search the collection by text, play a result, control playback, and show notifications on the screen.",
    commands: [
        {
            command: "search",
            description: `Search the library. ${SEARCH_SYNTAX}`
                + " Results are flat (individual videos), but when matched videos belong to a"
                + " series (show), an extra entry with type \"series\" is added for that show,"
                + " named after the series. Series entries are listed first.",
            args: { query: "string — the search expression described above" },
            returns: "list of { index, type: \"video\" | \"series\", name, relativePath }; pass an index to \"play\"",
        },
        {
            command: "play",
            description: `Play one of the results at "index". ALWAYS run "search" FIRST and inspect the`
                + " returned results before calling \"play\" — never play blindly. Look at the actual"
                + " names/paths the search returned, decide which entry truly matches what the user asked"
                + " for, and only then call \"play\" with that entry's \"index\". If the search results are"
                + " ambiguous or none of them clearly match, ask the user to clarify (or report what you"
                + ` found) instead of guessing. The query here runs the same search as "search" (${SEARCH_SYNTAX}),`
                + " so use the SAME query you just searched with and pass the index from those results."
                + " Be specific: pick the most precise match for what the user asked. If they name a"
                + " particular episode, play that exact episode (a \"video\" entry) rather than the"
                + " \"series\" entry. Only choose a \"series\" entry when the user asks for the show in"
                + " general — playing a \"series\" entry resumes from the last-played episode of that"
                + " series (or the first episode if none has been played).",
            args: {
                query: "string — the search expression",
                index: "number — which result to play, 0-based (optional, defaults to 0 = the top result)",
            },
            returns: "{ playing, index, type, name, relativePath }",
        },
        {
            command: "playback",
            description: "Pause or resume the currently playing video. Only affects the video that is already open.",
            args: { action: "\"pause\" | \"resume\"" },
            returns: "{ ok, action }",
        },
        {
            command: "series",
            description: "Navigate between episodes within the series that is CURRENTLY playing. This only works"
                + " while a video that belongs to a series is open — if nothing is playing, or the current video"
                + " isn't part of a series, it fails. Use it for \"next episode\", \"previous episode\", or jumping"
                + " to a specific episode. To start a show that isn't playing yet, use \"play\" instead.",
            args: {
                action: "\"next\" | \"prev\" | \"episode\" — go to the next/previous episode, or \"episode\" to jump to a specific one",
                episode: "number — required when action is \"episode\": the episode's 1-based position in the series (1 = first)",
            },
            returns: "{ advanced } — false when there is no next/prev episode, the episode number is out of range, or nothing is playing",
        },
        {
            command: "status",
            description: "Current playback status, or null when nothing is playing.",
            args: {},
            returns: "playback status or null",
        },
        {
            command: "notify",
            description: "Show a message on the screen (newlines preserved).",
            args: { message: "string — text to display" },
            returns: "{ shown }",
        },
        {
            command: "restyle",
            description: "Change the app's visual theme (colors, fonts, backgrounds)."
                + ` Available themes (pass the id): ${THEME_LIST}.`
                + " Match the user's request to the closest theme by name or vibe; you may pass either"
                + " the id or the display name (case-insensitive). Use \"default\" for the standard look.",
            args: { theme: "string — the theme id or name to switch to" },
            returns: "{ applied, theme } — applied is false when no theme matched the given name",
        },
    ],
};

type Payload = {
    command?: string;
    query?: string;
    index?: number;
    action?: string;
    episode?: number;
    message?: string;
    theme?: string;
};

export async function handleDeviceCall(payloadRaw: unknown): Promise<unknown> {
    const payload = normalizePayload(payloadRaw);
    console.log("%c[heygoogle] device-call %s", "color: magenta; font-weight: bold", JSON.stringify(payloadRaw));
    markBeingControlled();
    pushToast(`Hey Google: ${describePayload(payload)}`);
    const command = payload.command;
    if (!command) throw new Error(`Expected a "command" field, was ${JSON.stringify(payloadRaw).slice(0, 500)}`);

    if (command === "search") return doSearch(payload.query || "");
    if (command === "play") return doPlay(payload.query || "", payload.index ?? 0);
    if (command === "notify") {
        openNotification(payload.message || "");
        return { shown: true };
    }
    if (command === "restyle") {
        const want = (payload.theme || "").trim().toLowerCase();
        if (!want) throw new Error("restyle needs a \"theme\"");
        const match = allThemes().find(t => t.id.toLowerCase() === want || t.name.toLowerCase() === want);
        if (!match) return { applied: false, theme: payload.theme };
        setActiveTheme(match.id);
        return { applied: true, theme: match.id };
    }
    if (command === "status") {
        const controls = getPlayerControls();
        return controls ? (controls.getStatus() ?? null) : null;
    }
    if (command === "playback") {
        const controls = getPlayerControls();
        if (!controls) throw new Error("No video is currently open, so playback can't be controlled");
        const action = payload.action;
        if (action === "pause") { controls.pause(); return { ok: true, action }; }
        if (action === "resume") { controls.resume(); return { ok: true, action }; }
        throw new Error(`Unknown playback action "${action}" (expected pause or resume)`);
    }
    if (command === "series") {
        const controls = getPlayerControls();
        if (!controls) throw new Error("Nothing is playing, so there is no series to navigate");
        const action = payload.action;
        if (action === "next") return { advanced: controls.playNext() };
        if (action === "prev") return { advanced: controls.playPrev() };
        if (action === "episode") {
            const ep = payload.episode;
            if (typeof ep !== "number") throw new Error("series \"episode\" needs an \"episode\" number");
            return { advanced: controls.playEpisode(ep) };
        }
        throw new Error(`Unknown series action "${action}" (expected next, prev, or episode)`);
    }

    throw new Error(`Unknown command "${command}"`);
}

// The LLM forms the payload from CAPABILITIES, which presents each command's
// arguments under an `args:` key. It is inconsistent about reproducing that:
// sometimes it sends fields flat ({command,query}), sometimes nested under
// `args` ({command, args:{query}}). Accept either by folding an optional `args`
// object onto the top level (top level wins on conflict).
function normalizePayload(payloadRaw: unknown): Payload {
    const raw = (payloadRaw || {}) as Record<string, unknown>;
    const args = (raw.args && typeof raw.args === "object") ? raw.args as Record<string, unknown> : {};
    const pick = (k: string) => raw[k] ?? args[k];
    return {
        command: pick("command") as string | undefined,
        query: pick("query") as string | undefined,
        index: pick("index") as number | undefined,
        action: pick("action") as string | undefined,
        episode: pick("episode") as number | undefined,
        message: pick("message") as string | undefined,
        theme: pick("theme") as string | undefined,
    };
}

function describePayload(payload: Payload): string {
    const c = payload.command || "(no command)";
    if (c === "search") return `search "${payload.query || ""}"`;
    if (c === "play") return `play "${payload.query || ""}"${payload.index ? ` #${payload.index}` : ""}`;
    if (c === "playback") return `playback ${payload.action || ""}`.trim();
    if (c === "series") return `series ${payload.action || ""}${payload.action === "episode" && payload.episode ? ` ${payload.episode}` : ""}`.trim();
    if (c === "notify") return `notify "${(payload.message || "").slice(0, 60)}"`;
    if (c === "restyle") return `restyle "${payload.theme || ""}"`;
    return c;
}

type ResolvedEntry =
    | { index: number; type: "video"; key: string; name: string; relativePath: string }
    | { index: number; type: "series"; name: string; relativePath: string; parentPath: string; videos: SeriesVideo[] };

// Runs the flat text search and resolves it to entries with stable 0-based
// indices (so "play" can refer back by index). Matched videos stay as
// individual "video" entries; any series those videos belong to is additionally
// surfaced as a "series" entry (named after the show), listed first.
async function resolveSearch(query: string): Promise<ResolvedEntry[]> {
    const [nameCol, pathCol] = await Promise.all([
        files.getColumn("name"),
        files.getColumn("relativePath"),
        files.getColumn("addedAt"),
        files.getColumn("fileModifiedAt"),
    ]);
    const nameByKey = new Map<string, string>();
    for (const { key, value } of nameCol) nameByKey.set(key, value);
    const pathByKey = new Map<string, string>();
    for (const { key, value } of pathCol) pathByKey.set(key, value);

    // Detect series over the whole library, then index group-by-key so we can
    // tell which matched videos belong to a show.
    const allRecords: SeriesVideo[] = [];
    for (const { key, value: name } of nameCol) {
        const relativePath = pathByKey.get(key);
        if (relativePath) allRecords.push({ key, name, relativePath });
    }
    const seriesMap = getSeries(allRecords, seriesMinVideos.get());
    const groupByKey = new Map<string, SeriesGroup>();
    for (const group of seriesMap.values()) {
        for (const v of group.videos) groupByKey.set(v.key, group);
    }

    const result = search({ mode: "flat", query, fsSpec: undefined, perFrame: false, sortOrder: "unified", sortReversed: false });

    // Series whose matched videos appear, in first-seen order.
    const matchedSeries = new Map<string, SeriesGroup>();
    for (const k of result.keys) {
        const group = groupByKey.get(k.key);
        if (group && !matchedSeries.has(group.parentPath)) matchedSeries.set(group.parentPath, group);
    }

    const entries: ResolvedEntry[] = [];
    let index = 0;
    for (const group of matchedSeries.values()) {
        entries.push({
            index: index++,
            type: "series",
            name: group.folderName,
            relativePath: group.parentPath,
            parentPath: group.parentPath,
            videos: group.videos,
        });
    }
    for (const k of result.keys) {
        entries.push({
            index: index++,
            type: "video",
            key: k.key,
            name: nameByKey.get(k.key) || "",
            relativePath: pathByKey.get(k.key) || "",
        });
    }
    return entries;
}

async function doSearch(query: string) {
    const all = await resolveSearch(query);
    const results = all.slice(0, MAX_SEARCH_RESULTS)
        .map(e => ({ index: e.index, type: e.type, name: e.name, relativePath: e.relativePath }));
    return { results, totalMatches: all.length };
}

async function doPlay(query: string, index: number) {
    if (!query) throw new Error("play needs a \"query\"");
    const all = await resolveSearch(query);
    if (all.length === 0) throw new Error(`No results for "${query}"`);
    const chosen = all[index];
    if (!chosen) throw new Error(`index ${index} is out of range — the search returned ${all.length} result(s)`);
    if (chosen.type === "series") {
        const target = await lastPlayedKey(chosen.videos) ?? chosen.videos[0]?.key;
        if (!target) throw new Error(`Series "${chosen.name}" has no playable videos`);
        goToPlayerFromSeries(target, chosen.parentPath);
        return { playing: true, index: chosen.index, type: "series", name: chosen.name, relativePath: chosen.relativePath, key: target };
    }
    goToPlayer(chosen.key);
    return { playing: true, index: chosen.index, type: "video", name: chosen.name, relativePath: chosen.relativePath, key: chosen.key };
}

// Most-recently-played episode key in a series (async-safe column read).
async function lastPlayedKey(videos: SeriesVideo[]): Promise<string | undefined> {
    const posCol = await files.getColumn("positionUpdatedAt");
    const posByKey = new Map<string, number>();
    for (const { key, value } of posCol) posByKey.set(key, value || 0);
    let bestAt = 0;
    let best: string | undefined;
    for (const v of videos) {
        const t = posByKey.get(v.key) || 0;
        if (t > bestAt) { bestAt = t; best = v.key; }
    }
    return best;
}
