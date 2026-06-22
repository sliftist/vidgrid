// We import mediabunny's self-contained browser bundle by its concrete path
// (see scripts/postinstall.js for why). That deep path has no shipped types,
// so borrow them from the package root, whose declarations match the bundle.
declare module "mediabunny/dist/bundles/mediabunny.cjs" {
    export * from "mediabunny";
}
