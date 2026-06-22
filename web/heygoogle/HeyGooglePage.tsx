// Top-level page for ?page=heygoogle. Two modes:
//   - OAuth: when Google Home hands us client_id + redirect_uri +
//     response_type=code, we are the authorization endpoint. This browser's
//     public key IS the credential (the `code`), so linking just bounces back
//     to redirect_uri with the pubkey. We pause on a consent screen first so
//     the user explicitly accepts before we hand the key to Google.
//   - Management: the normal account/device management UI.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { primaryBtn } from "../styles";
import { oauthClientId, oauthRedirectUri, oauthResponseType, oauthState } from "../router";
import { setHeygoogleEnabled } from "../appState";
import { getPubkeyB64, makeOAuthCode } from "./identity";
import { pubkeyWords } from "./fingerprint";
import { ManagementView } from "./ManagementView";

function isOAuthRequest(): boolean {
    return !!oauthClientId.value && !!oauthRedirectUri.value && oauthResponseType.value === "code";
}

// This page can be reached directly (not only via the server's /oauth/authorize,
// which allow-lists redirect_uri). Mirror that allow-list here so a crafted link
// can't turn this trusted page into an open redirect that hands our pubkey (the
// OAuth `code`) to an attacker-controlled site. Must match the server's
// GOOGLE_REDIRECT_PREFIXES.
const ALLOWED_REDIRECT_PREFIXES = [
    "https://oauth-redirect.googleusercontent.com/r/",
    "https://oauth-redirect-sandbox.googleusercontent.com/r/",
];

function isAllowedRedirect(uri: string): boolean {
    return ALLOWED_REDIRECT_PREFIXES.some(p => uri.startsWith(p));
}

const detailRow = css.fontSize(11).color("hsl(0, 0%, 60%)").minWidth(0).overflowWrap("break-word");

@observer
export class HeyGooglePage extends preact.Component {
    synced = observable({ status: "", busy: false, pubkey: "" });

    componentDidMount() {
        if (isOAuthRequest()) void this.loadPubkey();
    }

    private async loadPubkey() {
        try {
            const pubkey = await getPubkeyB64();
            runInAction(() => { this.synced.pubkey = pubkey; });
        } catch (e) {
            runInAction(() => { this.synced.status = `Could not load identity: ${msg(e)}`; });
        }
    }

    private accept = async () => {
        if (!isAllowedRedirect(oauthRedirectUri.value)) {
            runInAction(() => { this.synced.status = "Refusing to link: this redirect target isn't a genuine Google address."; });
            return;
        }
        runInAction(() => {
            this.synced.busy = true;
            this.synced.status = "Opening Google Home. When it asks, add EVERY device shown to a room for the best results.";
        });
        // Explicitly accepting here is the opt-in.
        setHeygoogleEnabled(true);
        try {
            const code = await makeOAuthCode();
            const url = new URL(oauthRedirectUri.value);
            url.searchParams.set("code", code);
            if (oauthState.value) url.searchParams.set("state", oauthState.value);
            // Let the instruction render for a beat before navigation unloads us.
            await new Promise((r) => setTimeout(r, 1800));
            window.location.href = url.toString();
        } catch (e) {
            runInAction(() => { this.synced.busy = false; this.synced.status = `Linking failed: ${msg(e)}`; });
        }
    };

    render() {
        if (!isOAuthRequest()) return <ManagementView />;
        const s = this.synced;
        const allowed = isAllowedRedirect(oauthRedirectUri.value);
        return <div className={css.minHeight("100vh").hsl(0, 0, 7).color("white").pad2(24, 20)
            .display("flex").alignItems("center").justifyContent("center")}>
            <div className={css.vbox(14).maxWidth(520).fillWidth.minWidth(0)
                .hsl(0, 0, 11).bord(1, "hsl(0, 0%, 20%)").pad2(22, 18)}>
                <div className={css.fontSize(18)}>Link with Google Home?</div>
                {!allowed && <div className={css.fontSize(13).color("hsl(0, 80%, 80%)").hsl(0, 35, 16)
                    .bord(1, "hsl(0, 45%, 32%)").pad2(12, 9).minWidth(0).overflowWrap("break-word")}>
                    This link's redirect target isn't a genuine Google address, so it
                    won't be honored. Don't proceed unless you started this from Google
                    Home itself.
                </div>}
                <div className={css.fontSize(13).color("hsl(0, 0%, 75%)")}>
                    Google Home wants to link this browser so it can control it by
                    voice. Linking shares this browser's identity:
                </div>
                <div className={css.fontSize(13).color("hsl(140, 50%, 75%)").minWidth(0).overflowWrap("break-word")}>
                    {pubkeyWords(s.pubkey)}
                </div>
                <div className={css.fontSize(13).color("hsl(45, 80%, 78%)").hsl(45, 30, 14)
                    .bord(1, "hsl(45, 40%, 28%)").pad2(12, 9).minWidth(0)}>
                    Heads up: after you tap Link, Google Home will show a list of
                    devices. For the best results, add <b>every</b> device it shows
                    to a room before finishing.
                </div>
                <button
                    onMouseDown={() => { if (!s.busy && allowed) void this.accept(); }}
                    disabled={s.busy || !allowed}
                    className={primaryBtn + css.fontSize(14)
                        .alignSelf("flex-start") + (s.busy || !allowed ? css.opacity(0.6) : "")}
                >
                    Link with Google Home
                </button>
                {s.status && <div className={css.fontSize(13).color("hsl(50, 80%, 70%)")}>{s.status}</div>}
                <div className={css.vbox(4).opacity(0.45).pad2(0, 4)}>
                    <div className={detailRow}>Client ID: {oauthClientId.value}</div>
                    <div className={detailRow}>Redirect URI: {oauthRedirectUri.value}</div>
                    <div className={detailRow}>Response type: {oauthResponseType.value}</div>
                    {oauthState.value && <div className={detailRow}>State: {oauthState.value}</div>}
                    <div className={detailRow}>Public key (your identity): {s.pubkey || "…"}</div>
                </div>
            </div>
        </div>;
    }
}

function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
