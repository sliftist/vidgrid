import { URLParam, batchURLParamUpdate } from "sliftutils/render-utils/URLParam";
import { playSound } from "./sounds";

// URL state for the whole app. Two pages — SearchPage when `video` is empty,
// PlayerPage when set. `q` is the search query on the search page; `t` is the
// initial seek seconds on the player page (overrides the saved position).
// `series` is the parentPath of a series the user has drilled into on the
// grid (when set, the grid shows that series' contents). `fromSeries` is
// the parentPath of the series the user came in through — drives the
// series UI in the player (count, prev/next, autoplay next on end). It's
// cleared when navigating back to the grid.

export const searchQuery = new URLParam<string>("q", "");
export const currentVideo = new URLParam<string>("video", "");
export const seekParam = new URLParam<string>("t", "");
export const seriesPath = new URLParam<string>("series", "");
export const fromSeries = new URLParam<string>("from_series", "");
// Optional top-level page override. When set to "facetest" the app shows
// the face-embedding test page instead of the normal grid / player.
// "heygoogle" shows the Hey Google OAuth/management page.
export const page = new URLParam<string>("page", "");

// Google Home OAuth external-page params. When client_id + redirect_uri +
// response_type=code are present on ?page=heygoogle, the page runs the OAuth
// redirect flow (export pubkey as the `code`, bounce back to redirect_uri).
export const oauthClientId = new URLParam<string>("client_id", "");
export const oauthRedirectUri = new URLParam<string>("redirect_uri", "");
export const oauthResponseType = new URLParam<string>("response_type", "");
export const oauthState = new URLParam<string>("state", "");

// Device-pairing handoff: the device shows a link/QR carrying its own pubkey
// + a one-time password; the owner opens it on their phone, where ?page=
// heygoogle reads these and prompts to confirm adding the device.
export const hgAddDevice = new URLParam<string>("hgAddDevice", "");
export const hgOtp = new URLParam<string>("hgOtp", "");

// Effective display mode in the grid. Drives both the chip-row
// selection and showFaces (mode "face" implies the face strip is on).
// Lives in the URL so browser back/forward restores the view the user
// was looking at.
export type ViewMode = "list" | "hybrid" | "movies" | "series" | "flat" | "face";
export const viewMode = new URLParam<ViewMode>("view", "list");

// Face search: by default only files whose closest character is within the
// closeness threshold are shown. Set true (?faceAll=true) to instead show
// every file's closest character regardless of distance.
export const faceShowAll = new URLParam<boolean>("faceAll", false);

// Face-search result order: "count" (matched character's face count, most
// first — the default) or "distance" (closest match first).
export type FaceSort = "count" | "distance";
export const faceSort = new URLParam<FaceSort>("faceSort", "count");

// Which overlay modal is open ("settings" | "restyling" | ""). Driving this
// from the URL makes modals deep-linkable (?modal=restyling opens straight
// into the theme editor) and lets tooling load one URL into a given state.
export const modalParam = new URLParam<string>("modal", "");

// Optional active-theme override. When set, it wins over the localStorage
// active-theme selection for this page load — handy for deep-linking a look
// (?theme=cyberpunk) and for screenshotting every theme without persisting.
export const themeParam = new URLParam<string>("theme", "");

// When set (?demo=1) the app seeds a synthetic library into the in-memory
// collections instead of opening a real folder, so the grid renders fully
// populated. For development screenshots / theme previews only.
export const demoParam = new URLParam<string>("demo", "");

export function goToSearch() {
    batchURLParamUpdate([
        [currentVideo, ""],
        [seekParam, ""],
        [fromSeries, ""],
        [page, ""],
    ]);
}

// Open the search page with a query already filled in. Clears any series
// drill so the query runs against the whole library, mirroring what typing
// into the search box does.
export function goToSearchWithQuery(query: string) {
    batchURLParamUpdate([
        [currentVideo, ""],
        [seekParam, ""],
        [fromSeries, ""],
        [page, ""],
        [seriesPath, ""],
        [searchQuery, query],
    ]);
}

export function goToPlayer(videoKey: string, seekSec?: number) {
    playSound("videoOpen");
    batchURLParamUpdate([
        [currentVideo, videoKey],
        [seekParam, seekSec !== undefined ? seekSec.toFixed(2) : ""],
        [page, ""],
    ]);
}

export function goToSeriesGrid(seriesPathValue: string) {
    batchURLParamUpdate([
        [currentVideo, ""],
        [seekParam, ""],
        [fromSeries, ""],
        [page, ""],
        [seriesPath, seriesPathValue],
    ]);
}

export function goToPlayerFromSeries(videoKey: string, seriesPathValue: string) {
    playSound("videoOpen");
    batchURLParamUpdate([
        [fromSeries, seriesPathValue],
        [currentVideo, videoKey],
        [seekParam, ""],
        [page, ""],
    ]);
}
