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

export function goToSearch() {
    batchURLParamUpdate([
        [currentVideo, ""],
        [seekParam, ""],
        [fromSeries, ""],
        [page, ""],
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

export function goToPlayerFromSeries(videoKey: string, seriesPathValue: string) {
    playSound("videoOpen");
    batchURLParamUpdate([
        [fromSeries, seriesPathValue],
        [currentVideo, videoKey],
        [seekParam, ""],
        [page, ""],
    ]);
}
