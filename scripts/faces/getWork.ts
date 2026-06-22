// Debug CLI: dump every FileRecord that needs face processing as a JSON file —
// shape { version, total, items: [{ key, relativePath, durationSec? }] }. The
// real pipeline drives this through writeServer.ts now; this standalone form is
// kept for one-off inspection. The collection logic lives in faceIngest.ts.
//
// Usage:
//   yarn ts-node scripts/faces/getWork.ts <data_root> <out_json_path> [--force]
//     <data_root>       chdir target; bulk DBs live at
//                       <data_root>/data/bulkDatabases2/<name>/...
//     <out_json_path>   resolved BEFORE the chdir so a relative path still works
//                       once we cd elsewhere; a file (not stdout) so storage-
//                       layer logging can't corrupt the output.

import * as fs from "fs";
import * as path from "path";
import { collectWork } from "./faceIngest";

async function main() {
    const root = process.argv[2];
    const outPath = process.argv[3];
    const force = process.argv[4] === "--force";
    if (!root || !outPath) {
        throw new Error(`Expected <data_root> and <out_json_path>, got root=${root} outPath=${outPath}`);
    }
    const absOutPath = path.resolve(outPath);
    process.chdir(root);

    const work = await collectWork(force);
    fs.writeFileSync(absOutPath, JSON.stringify(work));
    console.log(`[getWork] ${work.total} items need face processing (FACES_VERSION=${work.version})`);
}

main().catch(err => {
    console.error((err as Error).stack);
    process.exit(1);
}).finally(() => process.exit(0));
