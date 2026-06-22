// Account/device management UI for hey-google mode. This browser acts as both
// an account (it can own devices and Google links) and a device (it can be
// registered and driven by voice). The server enforces which role a pubkey
// actually has; we just attempt each operation and surface failures per
// section rather than gating by role on the client.

import * as preact from "preact";
import { observable, runInAction } from "mobx";
import { observer } from "sliftutils/render-utils/observer";
import { css } from "typesafecss";
import { actionBtn, primaryBtn, dangerBtn, fieldInput } from "../styles";
import { formatTime } from "socket-function/src/formatting/format";
import { generateQR } from "./qr";
import { heygoogleEnabled, setHeygoogleEnabled } from "../appState";
import { goToSearch, hgAddDevice, hgOtp } from "../router";
import { batchURLParamUpdate } from "sliftutils/render-utils/URLParam";
import { getPubkeyB64, randomB64 } from "./identity";
import { pubkeyWords } from "./fingerprint";
import { CAPABILITIES } from "./deviceProtocol";
import { playSound } from "../sounds";
import {
    hgStatus, ensureConnected, disconnect,
    listDevices, unregisterDevice, updateDeviceDescription,
    listAccounts, unregisterAccount,
    listGoogleLinks, unregisterGoogleLink,
    registerDevicePairing, registerDeviceConfirm,
    dailyCost, totalDailyCost, listGoogleRequests,
} from "./client";

const GOOGLE_HOME_DEEPLINK = "https://madeby.google.com/home-app/?deeplink=setup%2Fha_linking%3Fagent_id%3Dgridvid-0046ef";

const sectionBox = css.vbox(8).pad2(14, 12).hsl(0, 0, 11).bord(1, "hsl(0, 0%, 20%)").minWidth(0);

function shortKey(pubkey: string): string {
    if (pubkey.length <= 18) return pubkey;
    return `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}`;
}

function lastActive(ms: number): string {
    if (!ms) return "never";
    return `${formatTime(Date.now() - ms)} ago`;
}

function isLikelyPhone(): boolean {
    if (typeof navigator === "undefined") return false;
    return /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent);
}

@observer
export class ManagementView extends preact.Component {
    synced = observable({
        pubkey: "",
        description: "main tv",
        otp: undefined as string | undefined,
        pairingUrl: undefined as string | undefined,
        notice: "" as string,
        devicesError: "" as string,
        accountsError: "" as string,
        googleError: "" as string,
        requestsError: "" as string,
        addBusy: false,
    });

    private pollTimer: number | undefined;

    componentDidMount() {
        void this.init();
        // While this page is open, keep every displayed section fresh.
        this.pollTimer = window.setInterval(() => {
            if (heygoogleEnabled.get()) void this.refreshAll();
        }, 10_000);
    }

    componentWillUnmount() {
        if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    }

    private async init() {
        const pubkey = await getPubkeyB64();
        runInAction(() => { this.synced.pubkey = pubkey; });
        if (heygoogleEnabled.get()) await this.refreshAll();
    }

    private async refreshAll() {
        try { await ensureConnected(); } catch (e) {
            runInAction(() => { this.synced.notice = `Connection failed: ${msg(e)}`; });
            return;
        }
        await Promise.allSettled([
            listDevices().catch(e => { runInAction(() => { this.synced.devicesError = msg(e); }); }),
            listAccounts().catch(e => { runInAction(() => { this.synced.accountsError = msg(e); }); }),
            listGoogleLinks().catch(e => { runInAction(() => { this.synced.googleError = msg(e); }); }),
            dailyCost().catch(() => { /* cost is best-effort; surfaced as "—" */ }),
        ]);
        if (hgStatus.superuser) {
            await Promise.allSettled([
                this.refreshRequests(),
                totalDailyCost().catch(() => { /* best-effort */ }),
            ]);
        }
    }

    private refreshRequests = async () => {
        runInAction(() => { this.synced.requestsError = ""; });
        try {
            await ensureConnected();
            await listGoogleRequests();
        } catch (e) {
            runInAction(() => { this.synced.requestsError = msg(e); });
        }
    };

    private enable = async () => {
        setHeygoogleEnabled(true);
        await this.refreshAll();
    };

    private disable = () => {
        setHeygoogleEnabled(false);
        disconnect();
    };

    private onLinkGoogleHome = () => {
        // The anchor itself navigates; arriving via the link is the opt-in.
        setHeygoogleEnabled(true);
    };

    private registerAsDevice = async () => {
        runInAction(() => { this.synced.notice = ""; });
        const otp = randomB64(9);
        try {
            await ensureConnected();
            await registerDevicePairing({ otp, description: this.synced.description, capabilities: CAPABILITIES });
        } catch (e) {
            runInAction(() => { this.synced.notice = `Pairing failed: ${msg(e)}`; });
            return;
        }
        const url = new URL(window.location.href);
        url.search = "";
        url.searchParams.set("page", "heygoogle");
        url.searchParams.set("hgAddDevice", this.synced.pubkey);
        url.searchParams.set("hgOtp", otp);
        const pairingUrl = url.toString();
        runInAction(() => {
            this.synced.otp = otp;
            this.synced.pairingUrl = pairingUrl;
        });
    };

    private confirmIncomingDevice = async () => {
        runInAction(() => { this.synced.addBusy = true; this.synced.notice = ""; });
        try {
            await ensureConnected();
            await registerDeviceConfirm({ device_pubkey: hgAddDevice.value, otp: hgOtp.value });
            runInAction(() => { this.synced.notice = "Device added to your account."; });
            batchURLParamUpdate([[hgAddDevice, ""], [hgOtp, ""]]);
            await this.refreshAll();
        } catch (e) {
            runInAction(() => { this.synced.notice = `Add failed: ${msg(e)}`; });
        } finally {
            runInAction(() => { this.synced.addBusy = false; });
        }
    };

    render() {
        const enabled = heygoogleEnabled.get();
        const phone = isLikelyPhone();
        const s = this.synced;
        return <div className={css.minHeight("100vh").hsl(0, 0, 7).color("white").pad2(24, 20)
            .display("flex").justifyContent("center")}>
            <div className={css.vbox(16).maxWidth(720).fillWidth.minWidth(0)}>
                <div className={css.hbox(12).alignCenter}>
                    <div className={css.fontSize(20).flexGrow(1)}>Hey Google</div>
                    <button onMouseDown={() => { playSound("heyGoogleBack"); goToSearch(); }} className={actionBtn}>Back to library</button>
                </div>

                {enabled && hgStatus.accounts.length > 0 && this.renderHowTo()}

                {enabled && hgStatus.accounts.length > 0 && this.renderAccounts()}

                {enabled && this.renderTopStatus()}

                {hgAddDevice.value && hgOtp.value && this.renderIncoming()}

                {this.renderIdentity(enabled)}

                {enabled && <>
                    {phone && this.renderGoogleLink(false)}
                    {this.renderRegisterDevice()}
                    {this.renderDevices()}
                    {this.renderGoogleLinks()}
                    {!phone && this.renderGoogleLink(true)}
                    {hgStatus.superuser && this.renderGoogleRequests()}
                </>}

                {s.notice && <div className={css.fontSize(13).color("hsl(50, 80%, 70%)")}>{s.notice}</div>}
            </div>
        </div>;
    }

    private renderTopStatus() {
        const dc = hgStatus.dailyCost;
        const tc = hgStatus.totalDailyCost;
        return <div className={sectionBox}>
            <div className={css.fontSize(15)}>
                {hgStatus.superuser
                    ? <span className={css.color("hsl(290, 70%, 72%)")}>Superuser</span>
                    : <span className={css.color("hsl(0, 0%, 65%)")}>Standard account</span>}
            </div>
            <div className={css.fontSize(13).color("hsl(0, 0%, 78%)").minWidth(0).overflowWrap("break-word")}>
                Daily LLM cost: {dc
                    ? <b>${dc.usd.toFixed(4)}</b>
                    : "—"}{dc && <span className={css.color("hsl(0, 0%, 55%)")}> / ${dc.capUsd.toFixed(2)} cap · {dc.date}</span>}
            </div>
            {hgStatus.superuser && <div className={css.fontSize(13).color("hsl(0, 0%, 78%)").minWidth(0).overflowWrap("break-word")}>
                All accounts today: {tc
                    ? <><b>${tc.totalUsd.toFixed(4)}</b><span className={css.color("hsl(0, 0%, 55%)")}> across {tc.accountsContributing} account{tc.accountsContributing === 1 ? "" : "s"}</span></>
                    : "—"}
            </div>}
        </div>;
    }

    private renderGoogleRequests() {
        const s = this.synced;
        const reqs = hgStatus.googleRequests;
        return <div className={sectionBox}>
            <div className={css.hbox(10).alignCenter}>
                <div className={css.fontSize(15).flexGrow(1)}>Recent Google requests</div>
                <button onMouseDown={() => void this.refreshRequests()} className={actionBtn}>Refresh</button>
            </div>
            {s.requestsError && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>{s.requestsError}</div>}
            {!s.requestsError && reqs.length === 0 && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>No requests yet.</div>}
            {reqs.map((r, i) => <div key={i} className={css.vbox(4).pad2(10, 8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 18%)").minWidth(0)}>
                <div className={css.fontSize(11).color("hsl(0, 0%, 55%)").minWidth(0).overflowWrap("break-word")}>
                    {lastActive(r.received_at)}{r.intent ? ` · ${r.intent}` : ""}
                </div>
                <div className={css.fontSize(12).color("hsl(0, 0%, 85%)").whiteSpace("pre-wrap").overflowWrap("break-word").minWidth(0)}>
                    {typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2)}
                </div>
            </div>)}
        </div>;
    }

    private renderIncoming() {
        return <div className={sectionBox + css.bord(1, "hsl(220, 60%, 40%)")}>
            <div className={css.fontSize(15)}>Add this device to your account?</div>
            <div className={css.fontSize(12).color("hsl(0, 0%, 65%)").minWidth(0).overflowWrap("break-word")}>
                A device wants to be controlled by this account:
                <span className={css.color("white")}> {pubkeyWords(hgAddDevice.value)}</span>
            </div>
            <ConfirmAction
                label="Add device"
                busy={this.synced.addBusy}
                onConfirm={this.confirmIncomingDevice}
            />
        </div>;
    }

    private renderIdentity(enabled: boolean) {
        const stateColor =
            hgStatus.state === "connected" ? "hsl(130, 60%, 50%)" :
            hgStatus.state === "connecting" ? "hsl(50, 80%, 55%)" :
            hgStatus.state === "error" ? "hsl(0, 70%, 55%)" :
            "hsl(0, 0%, 50%)";
        return <div className={sectionBox}>
            <div className={css.fontSize(15)}>This browser</div>
            <div className={css.hbox(8).alignCenter.fontSize(12).color("hsl(0, 0%, 70%)")}>
                <span className={css.size(9, 9).hslcolor(0, 0, 0).background(stateColor)} />
                <span>{enabled ? hgStatus.state : "disabled"}</span>
                {hgStatus.lastError && <span className={css.color("hsl(0, 70%, 60%)")}>· {hgStatus.lastError}</span>}
            </div>
            <div className={css.fontSize(12).color("hsl(0, 0%, 60%)").minWidth(0).overflowWrap("break-word")}
                title={this.synced.pubkey}>
                Identity: {pubkeyWords(this.synced.pubkey)}
            </div>
            {enabled
                ? <button onMouseDown={this.disable} className={actionBtn + css.alignSelf("flex-start")}>Disable hey-google mode</button>
                : <button onMouseDown={() => void this.enable()} className={primaryBtn + css.alignSelf("flex-start")}>Enable hey-google mode</button>}
        </div>;
    }

    private renderGoogleLink(discouraged: boolean) {
        return <div className={sectionBox + (discouraged ? css.opacity(0.5) : "")}>
            <div className={css.fontSize(15)}>Link with Google Home</div>
            {discouraged && <div className={css.fontSize(13).color("hsl(40, 90%, 65%)")}>
                Run this step on a phone.
            </div>}
            <div className={css.fontSize(12).color("hsl(0, 0%, 65%)")}>
                Opens the Google Home app to link this account. After you finish
                in Google Home, your linked accounts appear below.
            </div>
            <a
                href={GOOGLE_HOME_DEEPLINK}
                target="_blank"
                rel="noopener noreferrer"
                onClick={this.onLinkGoogleHome}
                className={primaryBtn + css.alignSelf("flex-start").textDecoration("none").display("inline-block")}
            >
                Link with Google Home
            </a>
        </div>;
    }

    private renderRegisterDevice() {
        const s = this.synced;
        return <div className={sectionBox}>
            <div className={css.fontSize(15)}>Control this device</div>
            <div className={css.fontSize(12).color("hsl(0, 0%, 65%)")}>
                Make this browser controllable by voice. Give it a description,
                then open the pairing link on your phone (where you're signed in
                to the account that should own it).
            </div>
            <input
                className={fieldInput}
                value={s.description}
                onInput={(e: Event) => runInAction(() => { this.synced.description = (e.currentTarget as HTMLInputElement).value; })}
                placeholder="Device description (e.g. Living room TV)"
            />
            <button onMouseDown={() => void this.registerAsDevice()} className={primaryBtn + css.alignSelf("flex-start")}>
                Create pairing link
            </button>
            {s.otp && s.pairingUrl && <div className={css.vbox(8).pad2(12, 10).hsl(0, 0, 8).bord(1, "hsl(0, 0%, 18%)")}>
                <div className={css.fontSize(13)}>Open this on your phone to confirm:</div>
                <QRView text={s.pairingUrl} size={220} />
                <div className={css.fontSize(11).color("hsl(0, 0%, 60%)").minWidth(0).overflowWrap("break-word")}>{s.pairingUrl}</div>
                <div className={css.fontSize(12).color("hsl(0, 0%, 75%)")}>One-time code: <b>{s.otp}</b></div>
            </div>}
        </div>;
    }

    private renderDevices() {
        const s = this.synced;
        return <div className={sectionBox}>
            <div className={css.fontSize(15)}>Devices you own</div>
            {s.devicesError && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>{s.devicesError}</div>}
            {!s.devicesError && hgStatus.devices.length === 0 && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>No devices.</div>}
            {hgStatus.devices.map(d => <DeviceRow
                key={d.device_pubkey}
                device_pubkey={d.device_pubkey}
                description={d.description}
                capabilities={d.capabilities}
                connected={d.connected}
                lastActiveAt={d.last_active_at}
                onChanged={() => void this.refreshAll()}
            />)}
        </div>;
    }

    private renderAccounts() {
        const s = this.synced;
        return <div className={sectionBox}>
            <div className={css.fontSize(15)}>Accounts controlling this device</div>
            {s.accountsError && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>{s.accountsError}</div>}
            {!s.accountsError && hgStatus.accounts.length === 0 && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>No accounts.</div>}
            {hgStatus.accounts.map(a => <div key={a.account_pubkey} className={css.hbox(10).alignCenter.pad2(10, 8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 18%)")}>
                <div className={css.vbox(2).flexGrow(1).minWidth(0)}>
                    <div className={css.fontSize(13).overflowWrap("break-word")}>{pubkeyWords(a.account_pubkey)}</div>
                    <div className={css.fontSize(11).color("hsl(0, 0%, 55%)")}>added {lastActive(a.registered_at)}</div>
                </div>
                <ConfirmAction label="Remove" onConfirm={async () => { await unregisterAccount(a.account_pubkey); await this.refreshAll(); }} />
            </div>)}
        </div>;
    }

    private renderHowTo() {
        return <div className={css.vbox(8).pad2(18, 18).hsl(280, 35, 16).bord(1, "hsl(280, 45%, 38%)").minWidth(0)}>
            <div className={css.fontSize(22).color("hsl(280, 70%, 82%)")}>Try saying:</div>
            <div className={css.fontSize(26).color("white").minWidth(0).overflowWrap("break-word")}>
                hey google{" "}
                <span className={css.fontFamily("monospace").fontSize(24).pad2(3, 8).hsl(280, 40, 26).color("hsl(50, 95%, 80%)")}>
                    open Andor Season 1 on the tv
                </span>
            </div>
        </div>;
    }

    private renderGoogleLinks() {
        const s = this.synced;
        return <div className={sectionBox}>
            <div className={css.fontSize(15)}>Google links</div>
            {s.googleError && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>{s.googleError}</div>}
            {!s.googleError && hgStatus.googleLinks.length === 0 && <div className={css.fontSize(12).color("hsl(0, 0%, 55%)")}>No Google accounts linked.</div>}
            {hgStatus.googleLinks.map(l => <div key={l.google_user_id} className={css.hbox(10).alignCenter.pad2(10, 8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 18%)")}>
                <div className={css.vbox(2).flexGrow(1).minWidth(0)}>
                    <div className={css.fontSize(13).overflowWrap("break-word")}>{shortKey(l.google_user_id)}</div>
                    <div className={css.fontSize(11).color("hsl(0, 0%, 55%)")}>linked {lastActive(l.linked_at)}</div>
                </div>
                <ConfirmAction label="Unlink" onConfirm={async () => { await unregisterGoogleLink(l.google_user_id); await this.refreshAll(); }} />
            </div>)}
        </div>;
    }
}

function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

// Renders a QR matrix as inline SVG — one <path> over the dark modules plus a
// white background, with a 4-module quiet zone. crispEdges keeps the squares
// sharp at any scale.
function QRView(props: { text: string; size?: number }) {
    let matrix: boolean[][];
    try {
        matrix = generateQR(props.text, "M");
    } catch (e) {
        return <div className={css.fontSize(12).color("hsl(0, 70%, 60%)")}>QR error: {msg(e)}</div>;
    }
    const n = matrix.length;
    const quiet = 4;
    const dim = n + quiet * 2;
    let path = "";
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (matrix[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
        }
    }
    const size = props.size ?? 220;
    return <svg
        width={size}
        height={size}
        viewBox={`0 0 ${dim} ${dim}`}
        shapeRendering="crispEdges"
        className={css.background("white")}
    >
        <rect x={0} y={0} width={dim} height={dim} fill="white" />
        <path d={path} fill="black" />
    </svg>;
}

@observer
class DeviceRow extends preact.Component<{
    device_pubkey: string;
    description: string;
    capabilities: unknown;
    connected: boolean;
    lastActiveAt: number;
    onChanged: () => void;
}> {
    synced = observable({ desc: this.props.description, editing: false, expanded: false, error: "" });

    private save = async () => {
        try {
            await updateDeviceDescription({ device_pubkey: this.props.device_pubkey, description: this.synced.desc });
            runInAction(() => { this.synced.editing = false; });
            this.props.onChanged();
        } catch (e) {
            runInAction(() => { this.synced.error = msg(e); });
        }
    };

    render() {
        const p = this.props;
        const s = this.synced;
        return <div className={css.vbox(6).pad2(10, 8).hsl(0, 0, 13).bord(1, "hsl(0, 0%, 18%)")}>
            <div className={css.hbox(10).alignCenter}>
                <span className={css.size(9, 9).background(p.connected ? "hsl(130, 60%, 50%)" : "hsl(0, 0%, 40%)")} />
                <div className={css.fontSize(13).flexGrow(1).minWidth(0).ellipsis}>{s.desc || "(no description)"}</div>
                <ConfirmAction label="Remove" onConfirm={async () => { await unregisterDevice(p.device_pubkey); p.onChanged(); }} />
            </div>
            <div className={css.fontSize(11).color("hsl(0, 0%, 55%)").minWidth(0).overflowWrap("break-word")}>
                {pubkeyWords(p.device_pubkey)} · active {lastActive(p.lastActiveAt)}
            </div>
            {s.editing
                ? <div className={css.hbox(8).alignCenter}>
                    <input
                        className={fieldInput}
                        value={s.desc}
                        onInput={(e: Event) => runInAction(() => { this.synced.desc = (e.currentTarget as HTMLInputElement).value; })}
                    />
                    <button onMouseDown={() => void this.save()} className={actionBtn}>Save</button>
                    <button onMouseDown={() => runInAction(() => { this.synced.desc = p.description; this.synced.editing = false; })} className={actionBtn}>Cancel</button>
                </div>
                : <div className={css.hbox(8).alignCenter}>
                    <button onMouseDown={() => runInAction(() => { this.synced.editing = true; })} className={actionBtn}>Edit description</button>
                    <button onMouseDown={() => runInAction(() => { this.synced.expanded = !this.synced.expanded; })} className={actionBtn}>
                        {s.expanded ? "Hide capabilities" : "Show capabilities"}
                    </button>
                </div>}
            {s.expanded && <div className={css.fontSize(11).color("hsl(0, 0%, 80%)")
                .whiteSpace("pre-wrap").overflowWrap("break-word").minWidth(0)
                .pad2(12, 10).hsl(0, 0, 8).bord(1, "hsl(0, 0%, 18%)").maxHeight(360).overflowAuto}>
                {p.capabilities === undefined || p.capabilities === null
                    ? "(no capabilities reported)"
                    : JSON.stringify(p.capabilities, null, 2)}
            </div>}
            {s.error && <div className={css.fontSize(11).color("hsl(0, 70%, 60%)")}>{s.error}</div>}
        </div>;
    }
}


// Destructive actions need two clicks: the first arms the action and jumps the
// confirm button to the START of the line (via flex `order`), so the user must
// physically move the cursor to confirm — an accidental double-click in place
// lands on Cancel (which stays where the button was) instead.
@observer
class ConfirmAction extends preact.Component<{ label: string; busy?: boolean; onConfirm: () => void | Promise<void> }> {
    synced = observable({ armed: false });
    render() {
        const s = this.synced;
        if (!s.armed) {
            return <button
                onMouseDown={() => runInAction(() => { this.synced.armed = true; })}
                className={dangerBtn}
            >
                {this.props.label}
            </button>;
        }
        return <>
            <button
                disabled={this.props.busy}
                onMouseDown={() => { runInAction(() => { this.synced.armed = false; }); void this.props.onConfirm(); }}
                className={dangerBtn + css.order(-1)}
            >
                Confirm {this.props.label.toLowerCase()}
            </button>
            <button
                onMouseDown={() => runInAction(() => { this.synced.armed = false; })}
                className={actionBtn}
            >
                Cancel
            </button>
        </>;
    }
}
