// Flat single-level lookup-table VLC decoder. Built from [code, bitLength]
// entries where the decoded symbol is the entry's array index. Matches
// ffmpeg's get_vlc2 result (the symbol), but with one direct table lookup
// instead of a multi-level walk — the longest code here is 13 bits, so a
// single 2^13-entry table stays small.

import { BitReader } from "./BitReader";

export class Vlc {
    readonly maxLen: number;
    private readonly sym: Int16Array;
    private readonly len: Uint8Array;

    constructor(table: number[][]) {
        let maxLen = 0;
        for (const entry of table) {
            const l = entry[1]!;
            if (l > maxLen) {
                maxLen = l;
            }
        }
        this.maxLen = maxLen;
        const size = 1 << maxLen;
        this.sym = new Int16Array(size).fill(-1);
        this.len = new Uint8Array(size);
        for (let i = 0; i < table.length; i++) {
            const code = table[i]![0]!;
            const l = table[i]![1]!;
            // Skip unused/placeholder entries (length 0).
            if (l === 0) {
                continue;
            }
            const shift = maxLen - l;
            const base = code << shift;
            const fill = 1 << shift;
            for (let j = 0; j < fill; j++) {
                this.sym[base + j] = i;
                this.len[base + j] = l;
            }
        }
    }

    // Decode one symbol. Returns the array index, or -1 on an invalid code.
    read(br: BitReader): number {
        const peek = br.showBits(this.maxLen);
        const l = this.len[peek]!;
        if (l === 0) {
            return -1;
        }
        br.skipBits(l);
        return this.sym[peek]!;
    }
}
