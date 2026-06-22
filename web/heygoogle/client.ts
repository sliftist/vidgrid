// Signed-WebSocket client for the heygoogle broker. Lazy singleton: nothing
// connects at import. Call ensureConnected() (or any of the typed packet
// wrappers) to bring the socket up. Outbound packets are signed envelopes;
// the server replies unsigned {type:"return"|"error", id}. Inbound
// {type:"device-call"} frames are dispatched to deviceProtocol and answered
// with a signed device-return.

import { observable, runInAction } from "mobx";
import { signEnvelope, randomId, randomB64, Secured } from "./identity";
import { handleDeviceCall } from "./deviceProtocol";

const WS_URL = "wss://heygoogle.vidgridweb.com:7951/control";
const DEFAULT_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 3000;

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type DeviceInfo = {
    device_pubkey: string;
    description: string;
    capabilities: unknown;
    registered_at: number;
    last_active_at: number;
    connected: boolean;
};

export type AccountInfo = {
    account_pubkey: string;
    registered_at: number;
};

export type GoogleLinkInfo = {
    google_user_id: string;
    linked_at: number;
};

export type GoogleRequest = {
    received_at: number;
    intent: string;
    body: unknown;
};

export type DailyCost = {
    usd: number;
    capUsd: number;
    date: string;
};

export type TotalDailyCost = {
    totalUsd: number;
    accountsContributing: number;
    date: string;
};

export const hgStatus = observable({
    state: "disconnected" as ConnectionState,
    lastError: "" as string,
    devices: [] as DeviceInfo[],
    accounts: [] as AccountInfo[],
    googleLinks: [] as GoogleLinkInfo[],
    superuser: false,
    dailyCost: undefined as DailyCost | undefined,
    totalDailyCost: undefined as TotalDailyCost | undefined,
    googleRequests: [] as GoogleRequest[],
    // True for a few seconds after an inbound device-call, so the UI can show
    // that this browser is actively being remote-controlled right now.
    beingControlled: false,
});

const CONTROLLED_WINDOW_MS = 6000;
let controlledTimer: number | undefined;

export function markBeingControlled() {
    runInAction(() => { hgStatus.beingControlled = true; });
    if (controlledTimer !== undefined) window.clearTimeout(controlledTimer);
    controlledTimer = window.setTimeout(() => {
        controlledTimer = undefined;
        runInAction(() => { hgStatus.beingControlled = false; });
    }, CONTROLLED_WINDOW_MS);
}

type Pending = {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: number;
};

let ws: WebSocket | undefined;
let connectPromise: Promise<void> | undefined;
let shouldConnect = false;
let reconnectTimer: number | undefined;
const pending = new Map<string, Pending>();

function setState(state: ConnectionState, error?: string) {
    runInAction(() => {
        hgStatus.state = state;
        if (error !== undefined) hgStatus.lastError = error;
    });
}

function scheduleReconnect() {
    if (!shouldConnect) return;
    if (reconnectTimer !== undefined) return;
    reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        if (shouldConnect) void connect();
    }, RECONNECT_DELAY_MS);
}

function connect(): Promise<void> {
    if (connectPromise) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
        setState("connecting");
        const sock = new WebSocket(WS_URL);
        ws = sock;
        sock.onopen = () => {
            setState("connected", "");
            resolve();
        };
        sock.onerror = () => {
            setState("error", "WebSocket error");
            // onclose follows; reconnect is scheduled there.
        };
        sock.onclose = () => {
            if (ws === sock) ws = undefined;
            connectPromise = undefined;
            // Reject any in-flight calls — the socket they were riding is gone.
            for (const [, p] of pending) {
                window.clearTimeout(p.timer);
                p.reject(new Error("WebSocket closed"));
            }
            pending.clear();
            if (shouldConnect) {
                setState("disconnected");
                scheduleReconnect();
            } else {
                setState("disconnected");
            }
            reject(new Error("WebSocket closed before open"));
        };
        sock.onmessage = ev => { void onMessage(ev); };
    });
    return connectPromise;
}

export function ensureConnected(): Promise<void> {
    shouldConnect = true;
    if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return connect();
}

export function disconnect() {
    shouldConnect = false;
    if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }
    if (ws) ws.close();
    ws = undefined;
    connectPromise = undefined;
}

async function onMessage(ev: MessageEvent) {
    let msg: { type?: string; id?: string; data?: unknown; error?: string; payload?: unknown };
    try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as typeof msg;
    } catch {
        console.error("[heygoogle] non-JSON frame", ev.data);
        return;
    }
    if (msg.type === "return" || msg.type === "error") {
        const id = msg.id || "";
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        window.clearTimeout(p.timer);
        if (msg.type === "return") p.resolve(msg.data);
        else p.reject(new Error(msg.error || "Unknown server error"));
        return;
    }
    if (msg.type === "device-call") {
        await respondToDeviceCall(msg.id || "", msg.payload);
        return;
    }
    console.warn("[heygoogle] unexpected frame", msg.type);
}

async function respondToDeviceCall(id: string, payload: unknown) {
    let data: { response: unknown } | { error: string };
    try {
        data = { response: await handleDeviceCall(payload) };
    } catch (e) {
        data = { error: e instanceof Error ? e.message : String(e) };
    }
    const secured: Secured = {
        type: "device-return",
        id,
        nonce: randomB64(12),
        timestamp: Date.now(),
        data,
    };
    const envelope = await signEnvelope(secured);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(envelope));
}

// Build, sign, and send a packet; resolve on the matching {type:"return"} or
// reject on {type:"error"}. Casts the server's untyped `data` to T.
export async function call<T = unknown>(type: string, data: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    await ensureConnected();
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) throw new Error("WebSocket not open");
    const id = randomId();
    const secured: Secured = {
        type,
        id,
        nonce: randomB64(12),
        timestamp: Date.now(),
        data,
    };
    const envelope = await signEnvelope(secured);
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
            pending.delete(id);
            reject(new Error(`heygoogle call "${type}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve: d => resolve(d as T), reject, timer });
        sock.send(JSON.stringify(envelope));
    });
}

// ── Typed packet wrappers ──────────────────────────────────────────────────

export async function listDevices(): Promise<DeviceInfo[]> {
    const data = await call<{ devices: DeviceInfo[] }>("list-devices", {});
    runInAction(() => { hgStatus.devices = data.devices || []; });
    return hgStatus.devices;
}

export async function unregisterDevice(device_pubkey: string) {
    const data = await call<{ removed: boolean; devices?: DeviceInfo[] }>("unregister-device", { device_pubkey });
    if (data.devices) runInAction(() => { hgStatus.devices = data.devices || []; });
    return data;
}

export async function updateDeviceDescription(config: { device_pubkey: string; description: string }) {
    const data = await call<{ updated: boolean; devices?: DeviceInfo[] }>("update-device-description", config);
    if (data.devices) runInAction(() => { hgStatus.devices = data.devices || []; });
    return data;
}

export async function registerDeviceConfirm(config: { device_pubkey: string; otp: string }) {
    const data = await call<{ ok: boolean; devices?: DeviceInfo[] }>("register-device-confirm", config);
    if (data.devices) runInAction(() => { hgStatus.devices = data.devices || []; });
    return data;
}

export async function listGoogleLinks(): Promise<GoogleLinkInfo[]> {
    const data = await call<{ links: GoogleLinkInfo[] }>("list-google-links", {});
    runInAction(() => { hgStatus.googleLinks = data.links || []; });
    return hgStatus.googleLinks;
}

export async function unregisterGoogleLink(google_user_id: string) {
    const data = await call<{ removed: boolean; links?: GoogleLinkInfo[] }>("unregister-google-link", { google_user_id });
    if (data.links) runInAction(() => { hgStatus.googleLinks = data.links || []; });
    return data;
}

export function registerDevicePairing(config: { otp: string; description: string; capabilities: unknown }) {
    return call<{ ok: boolean }>("register-device-pairing", config);
}

// Re-advertise this device's capabilities (device-only on the server).
export function updateCapabilities(capabilities: unknown) {
    return call<{ updatedRows: number }>("update-capabilities", { capabilities });
}

export async function listAccounts(): Promise<AccountInfo[]> {
    const data = await call<{ accounts: AccountInfo[] }>("list-accounts", {});
    runInAction(() => { hgStatus.accounts = data.accounts || []; });
    return hgStatus.accounts;
}

export async function unregisterAccount(account_pubkey: string) {
    const data = await call<{ removed: boolean; accounts?: AccountInfo[] }>("unregister-account", { account_pubkey });
    if (data.accounts) runInAction(() => { hgStatus.accounts = data.accounts || []; });
    return data;
}

export function wsStats() {
    return call<{ connectionsForThisAccount: number; lastConnectedAt: number; lastDisconnectedAt: number }>("ws-stats", {});
}

export async function dailyCost(): Promise<DailyCost & { superuser: boolean }> {
    const data = await call<{ usd: number; capUsd: number; date: string; superuser: boolean }>("daily-cost", {});
    runInAction(() => {
        hgStatus.dailyCost = { usd: data.usd, capUsd: data.capUsd, date: data.date };
        hgStatus.superuser = !!data.superuser;
    });
    return data;
}

// Superuser-only: the most recent Google fulfillment requests the server has
// seen for this account, newest first (the server already orders them DESC).
export async function listGoogleRequests(limit = 100): Promise<GoogleRequest[]> {
    const data = await call<{ requests: GoogleRequest[] }>("list-google-requests", { limit });
    runInAction(() => { hgStatus.googleRequests = data.requests || []; });
    return hgStatus.googleRequests;
}

// Superuser-only: today's summed LLM cost across every account.
export async function totalDailyCost(): Promise<TotalDailyCost> {
    const data = await call<TotalDailyCost>("total-daily-cost", {});
    runInAction(() => { hgStatus.totalDailyCost = data; });
    return data;
}
