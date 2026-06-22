// Coordinates the two-phase folder scan across browser tabs:
// - Cross-tab lock so only one tab scans at a time (localStorage + heartbeat).
// - 24-hour freshness — tracked SEPARATELY for the file-walk phase and the
//   metadata/thumbnail phase. A refresh mid-metadata resumes there without
//   redoing the file walk.
//
// State lives entirely in localStorage so tabs see each other's progress
// without any server.

const LOCK_KEY = "vidgrid.scanLock";
const COMPLETE_KEY = "vidgrid.scanComplete";
const HEARTBEAT_MS = 2000;
const STALE_MS = 6000;
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

const TAB_ID = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}.${Math.random().toString(36).slice(2)}`;

interface ScanLock {
    tabId: string;
    heartbeatAt: number;
}

interface ScanComplete {
    rootName: string;
    fileScanCompletedAt?: number;
    metadataScanCompletedAt?: number;
    keyframesScanCompletedAt?: number;
    facesScanCompletedAt?: number;
}

function readLock(): ScanLock | undefined {
    try {
        const raw = localStorage.getItem(LOCK_KEY);
        if (!raw) return undefined;
        return JSON.parse(raw) as ScanLock;
    } catch {
        return undefined;
    }
}

function readComplete(): ScanComplete | undefined {
    try {
        const raw = localStorage.getItem(COMPLETE_KEY);
        if (!raw) return undefined;
        return JSON.parse(raw) as ScanComplete;
    } catch {
        return undefined;
    }
}

function writeComplete(state: ScanComplete) {
    localStorage.setItem(COMPLETE_KEY, JSON.stringify(state));
}

function isFresh(at: number | undefined): boolean {
    if (!at) return false;
    return Date.now() - at < FRESHNESS_MS;
}

export function isFileScanFresh(rootName: string): boolean {
    const c = readComplete();
    if (!c || c.rootName !== rootName) return false;
    return isFresh(c.fileScanCompletedAt);
}

export function isMetadataScanFresh(rootName: string): boolean {
    const c = readComplete();
    if (!c || c.rootName !== rootName) return false;
    return isFresh(c.metadataScanCompletedAt);
}

export function markFileScanComplete(rootName: string): void {
    const cur = readComplete();
    // If the root changed, start fresh (clears any stale metadata marker for
    // the previous folder).
    const base: ScanComplete = (cur && cur.rootName === rootName) ? cur : { rootName };
    writeComplete({ ...base, rootName, fileScanCompletedAt: Date.now() });
}

export function markMetadataScanComplete(rootName: string): void {
    const cur = readComplete();
    const base: ScanComplete = (cur && cur.rootName === rootName) ? cur : { rootName };
    writeComplete({ ...base, rootName, metadataScanCompletedAt: Date.now() });
}

export function isKeyframesScanFresh(rootName: string): boolean {
    const c = readComplete();
    if (!c || c.rootName !== rootName) return false;
    return isFresh(c.keyframesScanCompletedAt);
}

export function markKeyframesScanComplete(rootName: string): void {
    const cur = readComplete();
    const base: ScanComplete = (cur && cur.rootName === rootName) ? cur : { rootName };
    writeComplete({ ...base, rootName, keyframesScanCompletedAt: Date.now() });
}

export function isFacesScanFresh(rootName: string): boolean {
    const c = readComplete();
    if (!c || c.rootName !== rootName) return false;
    return isFresh(c.facesScanCompletedAt);
}

export function markFacesScanComplete(rootName: string): void {
    const cur = readComplete();
    const base: ScanComplete = (cur && cur.rootName === rootName) ? cur : { rootName };
    writeComplete({ ...base, rootName, facesScanCompletedAt: Date.now() });
}

export function tryAcquireScanLock(): boolean {
    const existing = readLock();
    if (existing && existing.tabId !== TAB_ID && Date.now() - existing.heartbeatAt < STALE_MS) {
        return false;
    }
    const lock: ScanLock = { tabId: TAB_ID, heartbeatAt: Date.now() };
    localStorage.setItem(LOCK_KEY, JSON.stringify(lock));
    return true;
}

export function heartbeat(): void {
    const lock: ScanLock = { tabId: TAB_ID, heartbeatAt: Date.now() };
    localStorage.setItem(LOCK_KEY, JSON.stringify(lock));
}

export function releaseScanLock(): void {
    const cur = readLock();
    if (cur?.tabId === TAB_ID) {
        localStorage.removeItem(LOCK_KEY);
    }
}

// Raw completion timestamps for UI countdowns / readouts. undefined means
// the phase has never run (or ran for a different folder name).
export function getCompletionTimestamps(rootName: string): { fileScan?: number; metadataScan?: number; keyframesScan?: number; facesScan?: number } {
    const c = readComplete();
    if (!c || c.rootName !== rootName) return {};
    return {
        fileScan: c.fileScanCompletedAt,
        metadataScan: c.metadataScanCompletedAt,
        keyframesScan: c.keyframesScanCompletedAt,
        facesScan: c.facesScanCompletedAt,
    };
}

// 24h freshness gate is shared across all phases.
export const FRESHNESS_WINDOW_MS = FRESHNESS_MS;

export function getActiveLockOwner(): { tabId: string; ageMs: number } | undefined {
    const lock = readLock();
    if (!lock) return undefined;
    const age = Date.now() - lock.heartbeatAt;
    if (age >= STALE_MS) return undefined;
    if (lock.tabId === TAB_ID) return undefined;
    return { tabId: lock.tabId, ageMs: age };
}

export function getTabId(): string {
    return TAB_ID;
}
