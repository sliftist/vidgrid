import { files, FileRecord } from "../web/appState";

const SAME_KEY_REPEATS = 4;
const OTHER_KEY_COUNT = 4;
const DEFAULT_COLUMN = "name";

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const value = await fn();
    console.log(`${label}: ${(performance.now() - start).toFixed(1)}ms`);
    return value;
}

async function main(): Promise<void> {
    const root = process.argv[2];
    if (!root) throw new Error(`Expected the data root folder as the first argument, got ${JSON.stringify(process.argv.slice(2))}`);
    const column = (process.argv[3] || DEFAULT_COLUMN) as keyof FileRecord;
    process.chdir(root);
    console.log(`[bench pid ${process.pid}] collection=vidgrid_index column=${String(column)}`);

    const keys = await timed("getKeys (initial load)", () => files.getKeys());
    console.log(`  ${keys.length} keys`);
    if (keys.length === 0) throw new Error(`Expected at least one key in vidgrid_index, got ${keys.length}`);
    const key = keys[0];

    const first = await timed("getSingleFieldObj key #0, first call", () => files.getSingleFieldObj(key, column));
    console.log(`  ${first ? "present" : "absent"}`);
    for (let i = 0; i < SAME_KEY_REPEATS; i++) {
        await timed(`getSingleFieldObj key #0, call ${i + 2}`, () => files.getSingleFieldObj(key, column));
    }

    const step = Math.max(1, Math.floor(keys.length / (OTHER_KEY_COUNT + 1)));
    for (let i = 1; i <= OTHER_KEY_COUNT; i++) {
        const index = Math.min(keys.length - 1, i * step);
        await timed(`getSingleFieldObj key #${index}`, () => files.getSingleFieldObj(keys[index], column));
    }
}

main().then(() => process.exit(0), err => {
    console.error((err as Error).stack ?? err);
    process.exit(1);
});
