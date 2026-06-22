// Tweaks to make mediabunny + @mediabunny/ac3 work with sliftutils' bundler:
//
// 1. The bundler runs in Node, so `require("mediabunny")` (via the package's
//    conditional exports) hands back mediabunny.node.cjs — the *node* build.
//    That build branches between Node and browser and pulls a node-only path in
//    via a runtime import that doesn't survive bundling, so it explodes in the
//    browser (CustomSource ends up undefined). The fix is to import the
//    self-contained *browser* bundle (dist/bundles/mediabunny.cjs) directly
//    from our code. Node's `exports` field blocks deep subpaths, so we open up
//    `./dist/bundles/*` here.
//
// 2. @mediabunny/ac3 ships ESM-only, which sliftutils can't ingest. We rewrite
//    the .mjs as a side-effect-only script: replace the top-level `import` from
//    mediabunny with a globalThis lookup that the main bundle populates, and
//    replace the bottom-level `export` with a `globalThis.__mediabunnyAc3 = ...`
//    plus an immediate `registerAc3Decoder()` call. The result is loaded at
//    runtime via the browser's native dynamic import (bypassing the bundler
//    entirely) and is served from build-web/mediabunny-ac3.js. Copying happens
//    in build-web's asset pass since we write it under ./assets/.
//
// Runs after every `yarn install`.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function patchMediabunny() {
    const pkgPath = path.join(root, "node_modules", "mediabunny", "package.json");
    if (!fs.existsSync(pkgPath)) {
        console.log("[postinstall] mediabunny not installed yet, skipping");
        return;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.exports = pkg.exports || {};
    if (pkg.exports["./dist/bundles/*"] === "./dist/bundles/*") {
        console.log("[postinstall] mediabunny bundle subpath already exposed");
        return;
    }
    pkg.exports["./dist/bundles/*"] = "./dist/bundles/*";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log("[postinstall] exposed mediabunny ./dist/bundles/* subpath");
}

function patchMediabunnyAc3() {
    const srcPath = path.join(root, "node_modules", "@mediabunny", "ac3", "dist", "bundles", "mediabunny-ac3.mjs");
    if (!fs.existsSync(srcPath)) {
        console.log("[postinstall] @mediabunny/ac3 not installed yet, skipping");
        return;
    }
    const assetsDir = path.join(root, "assets");
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    const outPath = path.join(assetsDir, "mediabunny-ac3.js");

    let src = fs.readFileSync(srcPath, "utf8");

    // Replace EVERY `import { ... } from "mediabunny";` with a destructure from
    // globalThis.__mediabunny — the main bundle assigns mediabunny's exports
    // there before this script loads. The decoder and encoder modules each
    // have their own import block.
    src = src.replace(
        /import\s*{\s*([\s\S]*?)\s*}\s*from\s*["']mediabunny["'];/g,
        (_match, body) => {
            // Translate ESM rename syntax (`X as Y`) into JS destructure syntax (`X: Y`).
            const destructure = body
                .split(",")
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => s.replace(/\s+as\s+/, ": "))
                .join(", ");
            return `const { ${destructure} } = globalThis.__mediabunny;`;
        },
    );

    // Replace the trailing `export { ... }` with a globalThis assignment +
    // immediate decoder registration. Anchored to end of file.
    src = src.replace(
        /export\s*{\s*([\s\S]*?)\s*};?\s*$/,
        (_match, body) => {
            const names = body.split(",").map(s => s.trim()).filter(Boolean);
            const obj = names.join(", ");
            return `globalThis.__mediabunnyAc3 = { ${obj} };\nif (typeof registerAc3Decoder === "function") registerAc3Decoder();\n`;
        },
    );

    fs.writeFileSync(outPath, src);
    console.log(`[postinstall] patched @mediabunny/ac3 → ${path.relative(root, outPath)} (${(src.length / 1024).toFixed(1)} KB)`);
}

patchMediabunny();
patchMediabunnyAc3();
