// Platform capability detection.

// This is for the case when the user has no cursor, but also has no touch
// events. So interacting is very difficult — e.g. the Amazon Silk browser
// on a Fire TV, driven only by a remote. In that case we drop
// cursor-centric affordances (like auto-focusing the search box) and lean
// on remote-friendly key handling instead.
export function isMissingPointerInput(): boolean {
    if (typeof navigator !== "undefined" && /\bSilk\b/.test(navigator.userAgent || "")) {
        return true;
    }
    if (typeof matchMedia === "function") {
        // No pointing device of any kind (neither a fine mouse cursor nor a
        // coarse touch pointer) reported by the platform.
        return !matchMedia("(any-pointer: fine), (any-pointer: coarse)").matches;
    }
    return false;
}
