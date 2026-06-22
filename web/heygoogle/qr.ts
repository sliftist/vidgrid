// Self-contained QR Code generator — byte mode only. Enough to encode the
// device-pairing URL into a scannable module matrix with zero dependencies
// (the `qrcode` npm package drags in pngjs, which doesn't run in a browser).
// Returns a boolean matrix (true = dark module); the caller renders it as
// inline SVG. Algorithm follows the standard QR construction: byte-mode bit
// stream, Reed-Solomon ECC over GF(256), block interleaving, the eight data
// masks with penalty scoring, and BCH-coded format/version information.

export type ECLevel = "L" | "M" | "Q" | "H";

const MODE_8BIT_BYTE = 4;

// Format-info value carried in the symbol (not the table index below).
const EC_FORMAT_BITS: Record<ECLevel, number> = { M: 0, L: 1, H: 2, Q: 3 };
// Column offset into RS_BLOCK_TABLE rows.
const EC_TABLE_INDEX: Record<ECLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };

const G15 = 1335;
const G18 = 7973;
const G15_MASK = 21522;

// ── GF(256) tables (primitive polynomial 0x11d) ────────────────────────────

function buildExp(): number[] {
    const exp = new Array<number>(256);
    for (let i = 0; i < 8; i++) exp[i] = 1 << i;
    for (let i = 8; i < 256; i++) {
        exp[i] = exp[i - 4] ^ exp[i - 5] ^ exp[i - 6] ^ exp[i - 8];
    }
    return exp;
}
const EXP_TABLE = buildExp();
const LOG_TABLE = (() => {
    const log = new Array<number>(256).fill(0);
    for (let i = 0; i < 255; i++) log[EXP_TABLE[i]] = i;
    return log;
})();

function glog(n: number): number {
    if (n < 1) throw new Error(`glog of ${n} is undefined`);
    return LOG_TABLE[n];
}
function gexp(n: number): number {
    while (n < 0) n += 255;
    while (n >= 256) n -= 255;
    return EXP_TABLE[n];
}

// ── polynomials (most-significant coefficient first) ───────────────────────

function polyTrim(num: number[]): number[] {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    return num.slice(offset);
}

function polyMultiply(a: number[], b: number[]): number[] {
    const num = new Array<number>(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
        for (let j = 0; j < b.length; j++) {
            num[i + j] ^= gexp(glog(a[i]) + glog(b[j]));
        }
    }
    return polyTrim(num);
}

function polyMod(num: number[], divisor: number[]): number[] {
    if (num.length - divisor.length < 0) return num;
    const ratio = glog(num[0]) - glog(divisor[0]);
    const next = num.slice();
    for (let i = 0; i < divisor.length; i++) {
        next[i] ^= gexp(glog(divisor[i]) + ratio);
    }
    return polyMod(polyTrim(next), divisor);
}

function errorCorrectionPolynomial(ecLength: number): number[] {
    let poly = [1];
    for (let i = 0; i < ecLength; i++) poly = polyMultiply(poly, [1, gexp(i)]);
    return poly;
}

// ── BCH (format / version information) ─────────────────────────────────────

function bchDigit(data: number): number {
    let digit = 0;
    while (data !== 0) { digit++; data >>>= 1; }
    return digit;
}

function bchTypeInfo(data: number): number {
    let d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
    return ((data << 10) | d) ^ G15_MASK;
}

function bchTypeNumber(data: number): number {
    let d = data << 12;
    while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
    return (data << 12) | d;
}

// ── data masks ─────────────────────────────────────────────────────────────

function maskBit(pattern: number, i: number, j: number): boolean {
    if (pattern === 0) return (i + j) % 2 === 0;
    if (pattern === 1) return i % 2 === 0;
    if (pattern === 2) return j % 3 === 0;
    if (pattern === 3) return (i + j) % 3 === 0;
    if (pattern === 4) return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    if (pattern === 5) return (i * j) % 2 + (i * j) % 3 === 0;
    if (pattern === 6) return ((i * j) % 2 + (i * j) % 3) % 2 === 0;
    if (pattern === 7) return ((i * j) % 3 + (i + j) % 2) % 2 === 0;
    throw new Error(`Bad mask pattern ${pattern}`);
}

// ── reference tables (index by version-1) ──────────────────────────────────

const PATTERN_POSITION_TABLE: number[][] = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
    [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170],
];

// Per (version, EC level): flat groups of [blockCount, totalCodewords,
// dataCodewords]. One or two groups per row. Rows ordered L, M, Q, H within
// each version.
const RS_BLOCK_TABLE: number[][] = [
    [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
    [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
    [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
    [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
    [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
    [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
    [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
    [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
    [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
    [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16],
    [4, 101, 81], [1, 80, 50, 4, 81, 51], [4, 50, 22, 4, 51, 23], [3, 36, 12, 8, 37, 13],
    [2, 116, 92, 2, 117, 93], [6, 58, 36, 2, 59, 37], [4, 46, 20, 6, 47, 21], [7, 42, 14, 4, 43, 15],
    [4, 133, 107], [8, 59, 37, 1, 60, 38], [8, 44, 20, 4, 45, 21], [12, 33, 11, 4, 34, 12],
    [3, 145, 115, 1, 146, 116], [4, 64, 40, 5, 65, 41], [11, 36, 16, 5, 37, 17], [11, 36, 12, 5, 37, 13],
    [5, 109, 87, 1, 110, 88], [5, 65, 41, 5, 66, 42], [5, 54, 24, 7, 55, 25], [11, 36, 12, 7, 37, 13],
    [5, 122, 98, 1, 123, 99], [7, 73, 45, 3, 74, 46], [15, 43, 19, 2, 44, 20], [3, 45, 15, 13, 46, 16],
    [1, 135, 107, 5, 136, 108], [10, 74, 46, 1, 75, 47], [1, 50, 22, 15, 51, 23], [2, 42, 14, 17, 43, 15],
    [5, 150, 120, 1, 151, 121], [9, 69, 43, 4, 70, 44], [17, 50, 22, 1, 51, 23], [2, 42, 14, 19, 43, 15],
    [3, 141, 113, 4, 142, 114], [3, 70, 44, 11, 71, 45], [17, 47, 21, 4, 48, 22], [9, 39, 13, 16, 40, 14],
    [3, 135, 107, 5, 136, 108], [3, 67, 41, 13, 68, 42], [15, 54, 24, 5, 55, 25], [15, 43, 15, 10, 44, 16],
    [4, 144, 116, 4, 145, 117], [17, 68, 42], [17, 50, 22, 6, 51, 23], [19, 46, 16, 6, 47, 17],
    [2, 139, 111, 7, 140, 112], [17, 74, 46], [7, 54, 24, 16, 55, 25], [34, 37, 13],
    [4, 151, 121, 5, 152, 122], [4, 75, 47, 14, 76, 48], [11, 54, 24, 14, 55, 25], [16, 45, 15, 14, 46, 16],
    [6, 147, 117, 4, 148, 118], [6, 73, 45, 14, 74, 46], [11, 54, 24, 16, 55, 25], [30, 46, 16, 2, 47, 17],
    [8, 132, 106, 4, 133, 107], [8, 75, 47, 13, 76, 48], [7, 54, 24, 22, 55, 25], [22, 45, 15, 13, 46, 16],
    [10, 142, 114, 2, 143, 115], [19, 74, 46, 4, 75, 47], [28, 50, 22, 6, 51, 23], [33, 46, 16, 4, 47, 17],
    [8, 152, 122, 4, 153, 123], [22, 73, 45, 3, 74, 46], [8, 53, 23, 26, 54, 24], [12, 45, 15, 28, 46, 16],
    [3, 147, 117, 10, 148, 118], [3, 73, 45, 23, 74, 46], [4, 54, 24, 31, 55, 25], [11, 45, 15, 31, 46, 16],
    [7, 146, 116, 7, 147, 117], [21, 73, 45, 7, 74, 46], [1, 53, 23, 37, 54, 24], [19, 45, 15, 26, 46, 16],
    [5, 145, 115, 10, 146, 116], [19, 75, 47, 10, 76, 48], [15, 54, 24, 25, 55, 25], [23, 45, 15, 25, 46, 16],
    [13, 145, 115, 3, 146, 116], [2, 74, 46, 29, 75, 47], [42, 54, 24, 1, 55, 25], [23, 45, 15, 28, 46, 16],
    [17, 145, 115], [10, 74, 46, 23, 75, 47], [10, 54, 24, 35, 55, 25], [19, 45, 15, 35, 46, 16],
    [17, 145, 115, 1, 146, 116], [14, 74, 46, 21, 75, 47], [29, 54, 24, 19, 55, 25], [11, 45, 15, 46, 46, 16],
    [13, 145, 115, 6, 146, 116], [14, 74, 46, 23, 75, 47], [44, 54, 24, 7, 55, 25], [59, 46, 16, 1, 47, 17],
    [12, 151, 121, 7, 152, 122], [12, 75, 47, 26, 76, 48], [39, 54, 24, 14, 55, 25], [22, 45, 15, 41, 46, 16],
    [6, 151, 121, 14, 152, 122], [6, 75, 47, 34, 76, 48], [46, 54, 24, 10, 55, 25], [2, 45, 15, 64, 46, 16],
    [17, 152, 122, 4, 153, 123], [29, 74, 46, 14, 75, 47], [49, 54, 24, 10, 55, 25], [24, 45, 15, 46, 46, 16],
    [4, 152, 122, 18, 153, 123], [13, 74, 46, 32, 75, 47], [48, 54, 24, 14, 55, 25], [42, 45, 15, 32, 46, 16],
    [20, 147, 117, 4, 148, 118], [40, 75, 47, 7, 76, 48], [43, 54, 24, 22, 55, 25], [10, 45, 15, 67, 46, 16],
    [19, 148, 118, 6, 149, 119], [18, 75, 47, 31, 76, 48], [34, 54, 24, 34, 55, 25], [20, 45, 15, 61, 46, 16],
];

type RSBlock = { totalCount: number; dataCount: number };

function getRSBlocks(version: number, ec: ECLevel): RSBlock[] {
    const row = RS_BLOCK_TABLE[(version - 1) * 4 + EC_TABLE_INDEX[ec]];
    const blocks: RSBlock[] = [];
    for (let i = 0; i < row.length; i += 3) {
        const count = row[i];
        const totalCount = row[i + 1];
        const dataCount = row[i + 2];
        for (let c = 0; c < count; c++) blocks.push({ totalCount, dataCount });
    }
    return blocks;
}

function totalDataCount(version: number, ec: ECLevel): number {
    return getRSBlocks(version, ec).reduce((sum, b) => sum + b.dataCount, 0);
}

function byteLengthBits(version: number): number {
    return version < 10 ? 8 : 16;
}

// ── bit buffer ─────────────────────────────────────────────────────────────

class BitBuffer {
    buffer: number[] = [];
    length = 0;
    put(num: number, len: number) {
        for (let i = len - 1; i >= 0; i--) this.putBit(((num >>> i) & 1) === 1);
    }
    putBit(bit: boolean) {
        const idx = Math.floor(this.length / 8);
        if (this.buffer.length <= idx) this.buffer.push(0);
        if (bit) this.buffer[idx] |= 0x80 >>> (this.length % 8);
        this.length++;
    }
}

// ── data codewords (interleaved data + EC) ─────────────────────────────────

function createData(version: number, ec: ECLevel, dataBytes: number[]): number[] {
    const buffer = new BitBuffer();
    buffer.put(MODE_8BIT_BYTE, 4);
    buffer.put(dataBytes.length, byteLengthBits(version));
    for (const b of dataBytes) buffer.put(b, 8);

    const totalBits = totalDataCount(version, ec) * 8;
    if (buffer.length + 4 <= totalBits) buffer.put(0, 4);
    while (buffer.length % 8 !== 0) buffer.putBit(false);
    while (true) {
        if (buffer.length >= totalBits) break;
        buffer.put(0xec, 8);
        if (buffer.length >= totalBits) break;
        buffer.put(0x11, 8);
    }
    return createBytes(buffer, version, ec);
}

function createBytes(buffer: BitBuffer, version: number, ec: ECLevel): number[] {
    const blocks = getRSBlocks(version, ec);
    let offset = 0;
    let maxDc = 0;
    let maxEc = 0;
    const dcdata: number[][] = [];
    const ecdata: number[][] = [];
    for (const block of blocks) {
        const dcCount = block.dataCount;
        const ecCount = block.totalCount - block.dataCount;
        maxDc = Math.max(maxDc, dcCount);
        maxEc = Math.max(maxEc, ecCount);
        const dc = buffer.buffer.slice(offset, offset + dcCount);
        offset += dcCount;

        const rsPoly = errorCorrectionPolynomial(ecCount);
        const raw = dc.concat(new Array<number>(ecCount).fill(0));
        const mod = polyMod(polyTrim(raw), rsPoly);
        const ecBytes = new Array<number>(ecCount).fill(0);
        for (let i = 0; i < ecCount; i++) {
            const modIndex = i + mod.length - ecCount;
            ecBytes[i] = modIndex >= 0 ? mod[modIndex] : 0;
        }
        dcdata.push(dc);
        ecdata.push(ecBytes);
    }

    const out: number[] = [];
    for (let i = 0; i < maxDc; i++) {
        for (let r = 0; r < blocks.length; r++) {
            if (i < dcdata[r].length) out.push(dcdata[r][i]);
        }
    }
    for (let i = 0; i < maxEc; i++) {
        for (let r = 0; r < blocks.length; r++) {
            if (i < ecdata[r].length) out.push(ecdata[r][i]);
        }
    }
    return out;
}

// ── matrix construction ────────────────────────────────────────────────────

type Cell = boolean | null;

function makeMatrix(version: number, ec: ECLevel, maskPattern: number, data: number[], test: boolean): Cell[][] {
    const count = version * 4 + 17;
    const modules: Cell[][] = [];
    for (let r = 0; r < count; r++) modules.push(new Array<Cell>(count).fill(null));

    setupProbe(modules, count, 0, 0);
    setupProbe(modules, count, count - 7, 0);
    setupProbe(modules, count, 0, count - 7);
    setupAlignment(modules, version);
    setupTiming(modules, count);
    setupFormatInfo(modules, count, ec, maskPattern, test);
    if (version >= 7) setupVersionInfo(modules, count, version, test);
    mapData(modules, count, data, maskPattern);
    return modules;
}

function setupProbe(modules: Cell[][], count: number, row: number, col: number) {
    for (let r = -1; r <= 7; r++) {
        if (row + r < 0 || count <= row + r) continue;
        for (let c = -1; c <= 7; c++) {
            if (col + c < 0 || count <= col + c) continue;
            const isDark =
                (0 <= r && r <= 6 && (c === 0 || c === 6)) ||
                (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
                (2 <= r && r <= 4 && 2 <= c && c <= 4);
            modules[row + r][col + c] = isDark;
        }
    }
}

function setupTiming(modules: Cell[][], count: number) {
    for (let i = 8; i < count - 8; i++) {
        if (modules[i][6] === null) modules[i][6] = i % 2 === 0;
        if (modules[6][i] === null) modules[6][i] = i % 2 === 0;
    }
}

function setupAlignment(modules: Cell[][], version: number) {
    const pos = PATTERN_POSITION_TABLE[version - 1];
    for (const row of pos) {
        for (const col of pos) {
            if (modules[row][col] !== null) continue;
            for (let r = -2; r <= 2; r++) {
                for (let c = -2; c <= 2; c++) {
                    modules[row + r][col + c] =
                        r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
                }
            }
        }
    }
}

function setupFormatInfo(modules: Cell[][], count: number, ec: ECLevel, maskPattern: number, test: boolean) {
    const data = (EC_FORMAT_BITS[ec] << 3) | maskPattern;
    const bits = bchTypeInfo(data);
    for (let i = 0; i < 15; i++) {
        const mod = !test && ((bits >> i) & 1) === 1;
        if (i < 6) modules[i][8] = mod;
        else if (i < 8) modules[i + 1][8] = mod;
        else modules[count - 15 + i][8] = mod;

        if (i < 8) modules[8][count - i - 1] = mod;
        else if (i < 9) modules[8][15 - i - 1 + 1] = mod;
        else modules[8][15 - i - 1] = mod;
    }
    modules[count - 8][8] = !test;
}

function setupVersionInfo(modules: Cell[][], count: number, version: number, test: boolean) {
    const bits = bchTypeNumber(version);
    for (let i = 0; i < 18; i++) {
        const mod = !test && ((bits >> i) & 1) === 1;
        modules[Math.floor(i / 3)][i % 3 + count - 8 - 3] = mod;
        modules[i % 3 + count - 8 - 3][Math.floor(i / 3)] = mod;
    }
}

function mapData(modules: Cell[][], count: number, data: number[], maskPattern: number) {
    let inc = -1;
    let row = count - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let col = count - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
            for (let c = 0; c < 2; c++) {
                if (modules[row][col - c] !== null) continue;
                let dark = false;
                if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
                if (maskBit(maskPattern, row, col - c)) dark = !dark;
                modules[row][col - c] = dark;
                bitIndex--;
                if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
            }
            row += inc;
            if (row < 0 || count <= row) { row -= inc; inc = -inc; break; }
        }
    }
}

// ── mask selection (penalty scoring) ───────────────────────────────────────

function lostPoint(modules: Cell[][], count: number): number {
    let lost = 0;
    // Rule 1: runs of same colour.
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            let sameCount = 0;
            const dark = modules[row][col];
            for (let r = -1; r <= 1; r++) {
                if (row + r < 0 || count <= row + r) continue;
                for (let c = -1; c <= 1; c++) {
                    if (col + c < 0 || count <= col + c) continue;
                    if (r === 0 && c === 0) continue;
                    if (dark === modules[row + r][col + c]) sameCount++;
                }
            }
            if (sameCount > 5) lost += 3 + sameCount - 5;
        }
    }
    // Rule 2: 2x2 blocks.
    for (let row = 0; row < count - 1; row++) {
        for (let col = 0; col < count - 1; col++) {
            let dcount = 0;
            if (modules[row][col]) dcount++;
            if (modules[row + 1][col]) dcount++;
            if (modules[row][col + 1]) dcount++;
            if (modules[row + 1][col + 1]) dcount++;
            if (dcount === 0 || dcount === 4) lost += 3;
        }
    }
    // Rule 3: finder-like patterns.
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count - 6; col++) {
            if (modules[row][col] && !modules[row][col + 1] && modules[row][col + 2]
                && modules[row][col + 3] && modules[row][col + 4] && !modules[row][col + 5]
                && modules[row][col + 6]) lost += 40;
        }
    }
    for (let col = 0; col < count; col++) {
        for (let row = 0; row < count - 6; row++) {
            if (modules[row][col] && !modules[row + 1][col] && modules[row + 2][col]
                && modules[row + 3][col] && modules[row + 4][col] && !modules[row + 5][col]
                && modules[row + 6][col]) lost += 40;
        }
    }
    // Rule 4: dark/light balance.
    let darkCount = 0;
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (modules[row][col]) darkCount++;
        }
    }
    const ratio = Math.abs(100 * darkCount / count / count - 50) / 5;
    lost += Math.floor(ratio) * 10;
    return lost;
}

function chooseVersion(byteLength: number, ec: ECLevel): number {
    for (let version = 1; version <= 40; version++) {
        const capacityBits = totalDataCount(version, ec) * 8;
        const needBits = 4 + byteLengthBits(version) + byteLength * 8;
        if (needBits <= capacityBits) return version;
    }
    throw new Error(`Data too long for a QR code: ${byteLength} bytes at EC level ${ec}`);
}

// ── public API ─────────────────────────────────────────────────────────────

export function generateQR(text: string, ec: ECLevel = "M"): boolean[][] {
    const dataBytes = Array.from(new TextEncoder().encode(text));
    const version = chooseVersion(dataBytes.length, ec);
    const data = createData(version, ec, dataBytes);
    const count = version * 4 + 17;

    let best: Cell[][] | undefined;
    let bestLost = Infinity;
    for (let pattern = 0; pattern < 8; pattern++) {
        const modules = makeMatrix(version, ec, pattern, data, false);
        const lost = lostPoint(modules, count);
        if (lost < bestLost) { bestLost = lost; best = modules; }
    }
    const chosen = best;
    if (!chosen) throw new Error("QR generation produced no matrix");
    return chosen.map(row => row.map(cell => cell === true));
}
