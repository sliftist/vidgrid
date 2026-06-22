// Upload the two face-pipeline ONNX models to a public Backblaze
// bucket and print the download URLs so we can paste them into
// web/faceEmbed/index.ts.
//
// Run with `yarn ts-node scripts/uploadFaceModels.ts` or directly via
// `node -r typenode/index.js scripts/uploadFaceModels.ts`.

import * as fs from "fs";
import { getArchivesBackblazePublicImmutable } from "sliftutils/storage/backblaze";

const BUCKET_DOMAIN = "vidgrid-face-models";
const MODELS = [
    { fileName: "det_10g.onnx", path: "/root/face-models/det_10g.onnx" },
    { fileName: "w600k_r50.onnx", path: "/root/face-models/w600k_r50.onnx" },
    // float16 variants for the "Face models: float16" setting. Generate with:
    //   pip install onnx onnxconverter-common
    //   python -c "import onnx; from onnxconverter_common import float16; \
    //     [onnx.save(float16.convert_float_to_float16(onnx.load(s), keep_io_types=True), d) \
    //      for s,d in [('/root/face-models/det_10g.onnx','/root/face-models/det_10g_fp16.onnx'), \
    //                  ('/root/face-models/w600k_r50.onnx','/root/face-models/w600k_r50_fp16.onnx')]]"
    { fileName: "det_10g_fp16.onnx", path: "/root/face-models/det_10g_fp16.onnx" },
    { fileName: "w600k_r50_fp16.onnx", path: "/root/face-models/w600k_r50_fp16.onnx" },
];

async function main() {
    const bucket = getArchivesBackblazePublicImmutable(BUCKET_DOMAIN);
    bucket.enableLogging();

    for (const m of MODELS) {
        if (!fs.existsSync(m.path)) {
            throw new Error(`Missing model file at ${m.path}`);
        }
        const existing = await bucket.getInfo(m.fileName);
        const sizeOnDisk = fs.statSync(m.path).size;
        if (existing && existing.size === sizeOnDisk) {
            console.log(`Skipping ${m.fileName} — already uploaded (${existing.size} bytes)`);
        } else {
            console.log(`Uploading ${m.fileName} (${sizeOnDisk} bytes)...`);
            const data = fs.readFileSync(m.path);
            await bucket.set(m.fileName, data);
            console.log(`Uploaded ${m.fileName}`);
        }
        const url = await bucket.getURL(m.fileName);
        console.log(`URL: ${url}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
