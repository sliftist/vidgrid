// End-to-end check of every faceFrames row: does it have a character row, a real bestFaceEmbedding, and real member embeddings? Prints the files that fail anywhere, then per-step counts.
//
// Usage: yarn test <data_root>


process.chdir(process.argv[2] || "E:/downloads");

import { files } from "./web/appState";
async function main() {
    let keys = await files.getKeys();
}

main().catch(err => console.error(err)).finally(() => process.exit(0));
