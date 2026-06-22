// DO NOT USE DYNAMIC IMPORTS FOR THIS OR ANY IMPORT. The concrete browser
// bundle is imported directly because the package's node build doesn't bundle.
// Must be the same path the rest of the app imports so the ac3 script (which
// reads globalThis.__mediabunny) registers on the same module instance.
import * as mediabunny from "mediabunny/dist/bundles/mediabunny.cjs";

// The patched @mediabunny/ac3 script sets these globals when it runs.
declare global {
    interface Window {
        __mediabunny?: typeof mediabunny;
        __mediabunnyAc3?: {
            registerAc3Decoder: () => void;
            registerAc3Encoder: () => void;
        };
    }
}

let loadPromise: Promise<void> | undefined;

// Lazy-loads the AC-3 / E-AC-3 decoder shipped with @mediabunny/ac3. We can't
// bundle it inline — it's ESM with a `import from "mediabunny"` top-level — so
// the postinstall script rewrites it into a side-effect-only classic script
// served from /mediabunny-ac3.js. Calling this once before opening an audio
// track is enough; mediabunny picks up the registered custom decoder.
export function ensureAc3Decoder(): Promise<void> {
    if (!loadPromise) loadPromise = doLoad();
    return loadPromise;
}

async function doLoad(): Promise<void> {
    window.__mediabunny = mediabunny;
    await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "./assets/mediabunny-ac3.js";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load /mediabunny-ac3.js"));
        document.head.appendChild(script);
    });
    if (!window.__mediabunnyAc3) {
        throw new Error("mediabunny-ac3.js loaded but did not set window.__mediabunnyAc3");
    }
    console.log("[audio] @mediabunny/ac3 loaded and registered with mediabunny");
}
