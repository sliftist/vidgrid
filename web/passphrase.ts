import { observable, runInAction } from "mobx";
import { getFileStorageNested2 } from "sliftutils/storage/FileFolderAPI";
import { b64, fromB64 } from "./heygoogle/identity";
import { demoParam } from "./router";
import { ensureFolder } from "./appState";

export const PASSPHRASE_FILE = "passphrase.json";
const UNLOCK_KEY = "vidgrid_passphrase_unlock";
const ITERATIONS = 250000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

type StoredPassphrase = {
    salt: string;
    hash: string;
    iterations: number;
};

export type LockState = "loading" | "open" | "locked" | "unlocked";

export const lockState = observable.box<LockState>("loading");

let stored: StoredPassphrase | undefined;

function readUnlockToken(): string | undefined {
    try {
        return sessionStorage.getItem(UNLOCK_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

function writeUnlockToken(token: string | undefined): void {
    try {
        if (token === undefined) sessionStorage.removeItem(UNLOCK_KEY);
        else sessionStorage.setItem(UNLOCK_KEY, token);
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
            const token = readUnlockToken();
            runInAction(() => {
                if (!stored) lockState.set("open");
                else lockState.set(token === stored.hash ? "unlocked" : "locked");
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
    const hash = await derive(passphrase, current.salt, current.iterations);
    if (hash !== current.hash) return false;
    writeUnlockToken(hash);
    runInAction(() => lockState.set("unlocked"));
    return true;
}

export async function setPassphrase(passphrase: string): Promise<void> {
    const salt = b64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
    const hash = await derive(passphrase, salt, ITERATIONS);
    const record: StoredPassphrase = { salt, hash, iterations: ITERATIONS };
    const storage = await passphraseStorage();
    await storage.set(PASSPHRASE_FILE, Buffer.from(JSON.stringify(record, null, 4), "utf8") as Buffer);
    stored = record;
    writeUnlockToken(hash);
    runInAction(() => lockState.set("unlocked"));
}

export async function clearPassphrase(): Promise<void> {
    const storage = await passphraseStorage();
    await storage.remove(PASSPHRASE_FILE);
    stored = undefined;
    writeUnlockToken(undefined);
    runInAction(() => lockState.set("open"));
}

export function lockNow(): void {
    if (!stored) return;
    writeUnlockToken(undefined);
    runInAction(() => lockState.set("locked"));
}
