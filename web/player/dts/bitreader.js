// MSB-first bit reader over a Uint8Array, mirroring FFmpeg's get_bits.
class BitReader {
    constructor(bytes) { this.b = bytes; this.pos = 0; } // pos in bits
    bits(n) { let v = 0; for (let i = 0; i < n; i++) { const byte = this.b[this.pos >> 3] | 0; const bit = (byte >> (7 - (this.pos & 7))) & 1; v = v * 2 + bit; this.pos++; } return v; }
    bit() { const byte = this.b[this.pos >> 3] | 0; const bit = (byte >> (7 - (this.pos & 7))) & 1; this.pos++; return bit; }
    skip(n) { this.pos += n; }
    count() { return this.pos; }
    left() { return this.b.length * 8 - this.pos; }
    align() { if (this.pos & 7) this.pos += 8 - (this.pos & 7); }
}
module.exports = { BitReader };
