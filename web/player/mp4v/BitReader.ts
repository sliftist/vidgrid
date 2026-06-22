// MSB-first ("big-endian") bit reader matching ffmpeg's GetBitContext
// semantics. Backed by a Uint8Array; positions are tracked in bits.
//
// All reads are bounds-loose like ffmpeg (reading past the end returns zero
// bits) — callers rely on start codes / explicit length checks, not on
// exceptions, exactly as the C decoder does.

export class BitReader {
    readonly data: Uint8Array;
    // Absolute bit position from the start of `data`.
    pos: number;
    // One past the last readable bit.
    readonly end: number;

    constructor(data: Uint8Array, startByte = 0, byteLen = data.length - startByte) {
        this.data = data;
        this.pos = startByte * 8;
        this.end = (startByte + byteLen) * 8;
    }

    get bitsLeft(): number {
        return this.end - this.pos;
    }

    // Peek n bits (1..32) without consuming. Bits past the buffer read as 0.
    showBits(n: number): number {
        let v = 0;
        let p = this.pos;
        let need = n;
        const data = this.data;
        const endByte = data.length;
        while (need > 0) {
            const byteIdx = p >> 3;
            const cur = byteIdx < endByte ? data[byteIdx]! : 0;
            const bitOff = p & 7;
            const avail = 8 - bitOff;
            const take = avail < need ? avail : need;
            const shift = avail - take;
            const mask = (1 << take) - 1;
            const bits = (cur >> shift) & mask;
            // Multiply (not <<) so 32-bit values don't hit JS sign issues.
            v = v * (1 << take) + bits;
            p += take;
            need -= take;
        }
        return v >>> 0;
    }

    getBits(n: number): number {
        if (n === 0) {
            return 0;
        }
        const v = this.showBits(n);
        this.pos += n;
        return v;
    }

    getBits1(): number {
        const byteIdx = this.pos >> 3;
        const cur = byteIdx < this.data.length ? this.data[byteIdx]! : 0;
        const bit = (cur >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return bit;
    }

    skipBits(n: number): void {
        this.pos += n;
    }

    // Signed n-bit value read as in MPEG-4 (raw two's-complement style not
    // used here; mpeg4 mostly uses get_bits + manual sign). Provided for
    // convenience where a signed fixed field is needed.
    getSBits(n: number): number {
        const v = this.getBits(n);
        const signBit = 1 << (n - 1);
        return (v & signBit) ? v - (1 << n) : v;
    }

    alignByte(): void {
        this.pos = (this.pos + 7) & ~7;
    }

    bytePos(): number {
        return this.pos >> 3;
    }

    // Number of bits consumed so far (from the buffer start).
    count(): number {
        return this.pos;
    }
}
