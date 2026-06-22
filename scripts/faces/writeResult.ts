// Debug CLI: ingest a single video's face-processing result into the bulk DBs.
// The real pipeline drives this through writeServer.ts now (one long-lived
// process for the whole run); this standalone form is kept for one-off
// debugging. The ingest logic + payload shape live in faceIngest.ts.
//
// Usage:
//   yarn ts-node scripts/faces/writeResult.ts <data_root> <result_json_path>
//     <data_root>           chdir target; same as getWork.ts.
//     <result_json_path>    JSON produced by Python's process_one.py. Resolved
//                           BEFORE the chdir.

import * as fs from "fs";
import * as path from "path";
import { ingestResult, ResultPayload } from "./faceIngest";

async function main() {
    const root = process.argv[2];
    const jsonPath = process.argv[3];
    if (!root || !jsonPath) {
        throw new Error(`Expected <data_root> and <result_json_path>, got root=${root} jsonPath=${jsonPath}`);
    }
    const absJsonPath = path.resolve(jsonPath);
    process.chdir(root);

    const payload = JSON.parse(fs.readFileSync(absJsonPath, "utf8")) as ResultPayload;
    const counts = await ingestResult(payload);
    if (counts.error) {
        console.log(`[writeResult] ${payload.fileKey}: recorded error "${counts.error}"`);
        return;
    }
    console.log(`[writeResult] ${payload.fileKey}: ${counts.faces} faces, ${counts.characters} characters, ${counts.keyframes} keyframes`);
}

main().catch(err => {
    console.error((err as Error).stack);
    process.exit(1);
}).finally(() => process.exit(0));
