// Browser-side identity for the heygoogle protocol: one ECDSA P-256 keypair
// per browser, persisted in IndexedDB. The private key never leaves the
// browser; the base64 SPKI public key is the stable identifier the server
// stores. See PROTOCOL.md in the heygoogle repo for the wire formats.
//
// No import-time side effects: the keypair is generated/loaded lazily on
// first use and memoized, never at module load.

const DB_NAME = "vidgrid-heygoogle";
const STORE = "identity";
const KEY = "keypair";

type StoredKeyPair = { publicKey: CryptoKey; privateKey: CryptoKey };

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE)) {
                req.result.createObjectStore(STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
    });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

let keyPairPromise: Promise<StoredKeyPair> | undefined;

async function loadOrGenerate(): Promise<StoredKeyPair> {
    const db = await openDB();
    const existing = await idbGet<StoredKeyPair>(db, KEY);
    // CryptoKey objects survive IndexedDB's structured clone, so we store
    // them directly — no export/import round-trip, and the private key can
    // stay non-extractable.
    if (existing && existing.publicKey && existing.privateKey) return existing;
    const pair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
    ) as CryptoKeyPair;
    const stored: StoredKeyPair = { publicKey: pair.publicKey, privateKey: pair.privateKey };
    await idbPut(db, KEY, stored);
    return stored;
}

export function getKeyPair(): Promise<StoredKeyPair> {
    if (!keyPairPromise) keyPairPromise = loadOrGenerate();
    return keyPairPromise;
}

// ── base64 / random helpers ───────────────────────────────────────────────

export function b64(bytes: ArrayBuffer | Uint8Array): string {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
}

export function fromB64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function randomB64(n: number): string {
    const arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    return b64(arr);
}

export function randomId(): string {
    return randomB64(12);
}

// ── canonical JSON + signing ──────────────────────────────────────────────

// Recursively sort object keys; no whitespace; preserve array order; drop
// `undefined` fields. Must match the server's reference implementation byte
// for byte — it's what both sides sign over.
export function canonicalJSON(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
        if (obj[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ":" + canonicalJSON(obj[k]));
    }
    return "{" + parts.join(",") + "}";
}

let pubkeyB64Promise: Promise<string> | undefined;

export function getPubkeyB64(): Promise<string> {
    if (!pubkeyB64Promise) {
        pubkeyB64Promise = (async () => {
            const { publicKey } = await getKeyPair();
            return b64(await crypto.subtle.exportKey("spki", publicKey));
        })();
    }
    return pubkeyB64Promise;
}

export type Secured = {
    type: string;
    id: string;
    nonce: string;
    timestamp: number;
    data: unknown;
};

export type SignedEnvelope = {
    secured: Secured;
    signature: string;
    pubkey: string;
};

// Build a fully signed envelope around a `secured` body. The signature is the
// raw P1363 64-byte ECDSA/SHA-256 signature over canonicalJSON(secured).
export async function signEnvelope(secured: Secured): Promise<SignedEnvelope> {
    const { privateKey } = await getKeyPair();
    const pubkey = await getPubkeyB64();
    const bytes = new TextEncoder().encode(canonicalJSON(secured));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, bytes);
    return { secured, signature: b64(sig), pubkey };
}

// The OAuth `code` handed back to Google: a base64-encoded signed envelope with
// secured.type = "oauth-link". Signing it (rather than sending the raw pubkey)
// proves this browser holds the private key, so knowing the public key — which
// is sent on every packet and visible in logs — is no longer enough to mint
// tokens against the account. Server verifies signature, type, and a 15-minute
// timestamp window (see PROTOCOL.md "Signed OAuth code format").
export async function makeOAuthCode(): Promise<string> {
    const secured: Secured = {
        type: "oauth-link",
        id: randomId(),
        nonce: randomB64(16),
        timestamp: Date.now(),
        data: undefined,
    };
    const envelope = await signEnvelope(secured);
    return btoa(JSON.stringify(envelope));
}
