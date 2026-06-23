# vidgrid project rules

These rules are enforced for ALL contributors and ALL automated agents
(local Claude Code AND cloud code review). They override default tooling
behavior. Treat violations as build-breaking.

## NEVER use dynamic `import()` of local modules

Do **not** write `await import("./...")` / `import("../...")` anywhere in
`web/` or `scripts/`. This includes lazy-loading for code-splitting,
breaking import cycles, or "deferring a heavy module."

**Why:** the bundler (sliftutils `bundleEntry`) produces a single bundle per
entry point. It does **not** emit or serve split chunks, so a dynamic
`import()` of a local module resolves to a chunk URL that does not exist at
runtime — the feature silently fails in production. This has bitten us
repeatedly. There is no scenario where dynamic-importing a local module
"works" here.

**What to do instead:**

- Just use a normal top-level `import`. ES-module import cycles are fine as
  long as the imported bindings are used at call time (inside functions),
  not at module-init time — which is already true everywhere we'd be
  tempted to lazy-load. Importing a "heavy" module does not bloat the
  bundle meaningfully when its true weight (e.g. onnxruntime-web) is loaded
  from a CDN at runtime anyway.
- If you genuinely need a separately-loaded artifact, either add a new
  **bundle entry point** (a second `build-web --entryPoint ...` target, see
  `package.json`) or load it from a **CDN at runtime**.

**The one sanctioned runtime-import pattern** (external CDN URLs only, never
local files) is the Function-constructor trick that hides the import from
the bundler:

```ts
const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const mod = await dynImport("https://cdn.jsdelivr.net/npm/<pkg>@<ver>/dist/...mjs");
```

See `web/faceEmbed/onnx.ts` and `web/player/WebDemuxerPlayer.ts`. This is
allowed **only** for pinned external URLs, never for a path into this repo.

## Every change ships

A vidgrid change is not done until it is committed, pushed, and deployed
(`yarn deploy`). Run `yarn type` and `yarn build-web` clean first.
