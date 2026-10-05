import { observable, runInAction } from "mobx";
import { getFileStorageNested2 } from "sliftutils/storage/FileFolderAPI";
import { b64, fromB64 } from "./heygoogle/identity";
import { demoParam } from "./router";
import { ensureFolder } from "./appState";

export const PASSPHRASE_FILE = "passphrase.json";
export const UNLOCK_FILE = "passphraseUnlock.json";
const UNLOCK_DURATION = 24 * 60 * 60 * 1000;
const ITERATIONS = 250000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

type StoredPassphrase = {
    salt: string;
    hash: string;
    iterations: number;
};

type StoredUnlock = {
    hash: string;
    at: number;
};

export type LockState = "loading" | "open" | "locked" | "unlocked";

export const lockState = observable.box<LockState>("loading");

let stored: StoredPassphrase | undefined;

async function readUnlock(): Promise<StoredUnlock | undefined> {
    let raw: Buffer | undefined;
    try {
        raw = await (await passphraseStorage()).get(UNLOCK_FILE);
    } catch {
        return undefined;
    }
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw.toString("utf8")) as StoredUnlock;
        if (typeof parsed?.hash !== "string" || typeof parsed?.at !== "number") return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

async function writeUnlock(hash: string): Promise<void> {
    const record: StoredUnlock = { hash, at: Date.now() };
    try {
        const storage = await passphraseStorage();
        await storage.set(UNLOCK_FILE, Buffer.from(JSON.stringify(record, null, 4), "utf8") as Buffer);
    } catch { }
}

async function clearUnlock(): Promise<void> {
    try {
        const storage = await passphraseStorage();
        await storage.remove(UNLOCK_FILE);
    } catch { }
}

async function passphraseStorage() {
    return await getFileStorageNested2("");
}

async function readStored(): Promise<StoredPassphrase | undefined> {
    let raw: Buffer | undefined;
    try {
        raw = await (await passphraseStorage()).get(PASSPHRASE_FILE);
    } catch {
        return undefined;
    }
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw.toString("utf8")) as StoredPassphrase;
        if (typeof parsed?.salt !== "string" || typeof parsed?.hash !== "string") return undefined;
        return {
            salt: parsed.salt,
            hash: parsed.hash,
            iterations: typeof parsed.iterations === "number" && parsed.iterations > 0
                ? parsed.iterations : ITERATIONS,
        };
    } catch {
        return undefined;
    }
}

// Only the letters of a passphrase count: it gets typed on phone keyboards and
// TV remotes where case and punctuation are a pointless way to fail. Applied on
// both setting and checking so the two can never disagree. A passphrase with no
// letters at all (say, all digits) would normalize to nothing, so those keep
// their raw text rather than every one of them collapsing to the same
// empty-string passphrase.
export function normalizePassphrase(passphrase: string): string {
    const letters = passphrase.toLowerCase().replace(/[^a-z]/g, "");
    return letters || passphrase;
}

async function derive(passphrase: string, salt: string, iterations: number): Promise<string> {
    const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: fromB64(salt), iterations, hash: "SHA-256" },
        key, HASH_BITS,
    );
    return b64(bits);
}

let initPromise: Promise<void> | undefined;

export function initPassphraseGate(): Promise<void> {
    if (!initPromise) {
        initPromise = (async () => {
            if (demoParam.value) {
                runInAction(() => lockState.set("open"));
                return;
            }
            const handle = await ensureFolder();
            if (!handle) {
                runInAction(() => lockState.set("open"));
                return;
            }
            stored = await readStored();
            const unlock = stored && await readUnlock();
            const fresh = !!unlock && !!stored && unlock.hash === stored.hash
                && Date.now() - unlock.at < UNLOCK_DURATION;
            runInAction(() => {
                if (!stored) lockState.set("open");
                else lockState.set(fresh ? "unlocked" : "locked");
            });
        })();
    }
    return initPromise;
}

export function passphraseIsSet(): boolean {
    const state = lockState.get();
    return state === "locked" || state === "unlocked";
}

export async function tryUnlock(passphrase: string): Promise<boolean> {
    const current = stored;
    if (!current) return true;
    // Normalized form first, then the raw text. The raw fallback is what keeps a
    // passphrase that was stored before normalization existed — hashed from
    // exactly the characters typed — from locking its owner out of their own
    // library. Re-setting the passphrase in settings stores the normalized form.
    for (const candidate of new Set([normalizePassphrase(passphrase), passphrase])) {
        const hash = await derive(candidate, current.salt, current.iterations);
        if (hash !== current.hash) continue;
        await writeUnlock(hash);
        runInAction(() => lockState.set("unlocked"));
        return true;
    }
    return false;
}

export async function setPassphrase(passphrase: string): Promise<void> {
    const salt = b64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
    const hash = await derive(normalizePassphrase(passphrase), salt, ITERATIONS);
    const record: StoredPassphrase = { salt, hash, iterations: ITERATIONS };
    const storage = await passphraseStorage();
    await storage.set(PASSPHRASE_FILE, Buffer.from(JSON.stringify(record, null, 4), "utf8") as Buffer);
    stored = record;
    await writeUnlock(hash);
    runInAction(() => lockState.set("unlocked"));
}

export async function clearPassphrase(): Promise<void> {
    const storage = await passphraseStorage();
    await storage.remove(PASSPHRASE_FILE);
    stored = undefined;
    await clearUnlock();
    runInAction(() => lockState.set("open"));
}

export function lockNow(): void {
    if (!stored) return;
    void clearUnlock();
    runInAction(() => lockState.set("locked"));
}
