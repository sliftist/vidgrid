// Public keys are shown to humans as a word phrase so they can be eyeballed and
// compared. We hash the key first (SHA-256) before mapping to words: the raw
// base64 SPKI shares a fixed DER prefix across every P-256 key, so unhashed
// phrases all start with the same words and are annoying to compare. Hashing
// spreads the difference across the whole phrase and keeps collisions hard, so
// a look-alike key can't share a fingerprint.
//
// SHA-256 in the browser is async (crypto.subtle.digest), but render code wants
// a string now. So `pubkeyWords` returns a cached value synchronously and, on a
// miss, kicks off the hash and stores the result in an observable map — mobx
// observers reading it re-render once it resolves.

import { observable, runInAction } from "mobx";
import { fromB64 } from "./identity";
import { bytesToWords } from "./words";

const cache = observable.map<string, string>();
const pending = new Set<string>();

async function compute(pubkeyB64: string) {
    try {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(pubkeyB64)));
        const phrase = bytesToWords(digest).join(" ");
        runInAction(() => cache.set(pubkeyB64, phrase));
    } catch {
        runInAction(() => cache.set(pubkeyB64, "(invalid key)"));
    }
}

// Word phrase for a base64-SPKI public key. Reactive: returns "..." until the
// hash resolves, then the real phrase on the next render.
export function pubkeyWords(pubkeyB64: string): string {
    if (!pubkeyB64) return "...";
    const existing = cache.get(pubkeyB64);
    if (existing !== undefined) return existing;
    if (!pending.has(pubkeyB64)) {
        pending.add(pubkeyB64);
        void compute(pubkeyB64);
    }
    return "...";
}
