// Pure-TypeScript MPEG-4 Part 2 (Advanced Simple Profile) decoder, ported from
// FFmpeg's mpeg4videodec.c / h263.c / ituh263dec.c. Targets the XviD/DivX-in-AVI
// subset actually present in our streams: rectangular VOL, progressive,
// half-pel motion (no quarter-pel / GMC / sprites / data-partitioning / RVLC /
// interlacing / studio profile). I, P and B VOPs are supported.
//
// The bit-exact reference points (constants, rounding, prediction borders) all
// mirror FFmpeg so output matches the C decoder pixel-for-pixel.

import { BitReader } from "./BitReader";
import { Vlc } from "./Vlc";
import { Frame, EDGE, extendEdges, packI420 } from "./frame";
import { lumaMc, chromaMc } from "./motion";
import { idctPut, idctAdd } from "./idct";
import {
    intraMCBPC, interMCBPC, cbpyTab, mvTab, mbTypeBTab2,
    dcLumTab, dcChromTab, rlInter, rlIntra, RLTable,
    yDcScaleTable, cDcScaleTable, dcThreshold,
    zigzagDirect, alternateHorizontalScan, alternateVerticalScan,
} from "./tables";

const PICT_I = 0;
const PICT_P = 1;
const PICT_B = 2;

// Per-MB type flags stored in Frame.mbType.
const MB_INTRA = 1;
const MB_SKIP = 2;
const MB_8X8 = 8;

const QUANT_TAB = [-1, -2, 1, 2];

const CHROMA_ROUND = Int8Array.from([0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1]);
const roundChroma = (x: number): number => CHROMA_ROUND[x & 0xf]! + (x >> 3);

const midPred = (a: number, b: number, c: number): number => {
    let min = a, max = a;
    if (b < min) min = b; else max = b;
    if (c < min) min = c; else if (c > max) max = c;
    return a + b + c - min - max;
};

const roundedDiv = (a: number, b: number): number =>
    ((a > 0 ? a + (b >> 1) : a - (b >> 1)) / b) | 0;

// Run/level VLC plus the max_level/max_run tables used by the three escape modes.
class RlDecoder {
    readonly vlc: Vlc;
    readonly run: Int8Array;
    readonly level: Int8Array;
    readonly last: number;
    readonly n: number;
    readonly maxLevel: Int16Array[];
    readonly maxRun: Int16Array[];

    constructor(rl: RLTable) {
        this.vlc = new Vlc(rl.vlc);
        this.run = rl.run;
        this.level = rl.level;
        this.last = rl.last;
        this.n = rl.n;
        this.maxLevel = [new Int16Array(64), new Int16Array(64)];
        this.maxRun = [new Int16Array(64), new Int16Array(64)];
        for (let last = 0; last < 2; last++) {
            const start = last === 0 ? 0 : rl.last;
            const end = last === 0 ? rl.last : rl.n;
            const ml = this.maxLevel[last]!;
            const mr = this.maxRun[last]!;
            for (let i = start; i < end; i++) {
                const run = rl.run[i]!;
                const level = rl.level[i]!;
                if (level > ml[run]!) ml[run] = level;
                if (run > mr[level]!) mr[level] = run;
            }
        }
    }
}

type Out = { time: number; data: Uint8Array };

export class Mpeg4Decoder {
    private volParsed = false;
    private width = 0;
    private height = 0;
    private mbWidth = 0;
    private mbHeight = 0;
    private mbStride = 0;
    private mpegQuant = false;
    private timeIncrementBits = 1;
    private framerateNum = 1;
    private progressive = true;
    private lowDelay = false;
    private quantPrecision = 5;

    // VOP state.
    private pictType = PICT_I;
    private qscale = 1;
    private fCode = 1;
    private bCode = 1;
    private noRounding = false;
    private acPred = false;
    private intraDcThreshold = 99;
    private yDcScale = 8;
    private cDcScale = 8;

    // Timing.
    private timeBase = 0;
    private lastTimeBase = 0;
    private time = 0;
    private lastNonBTime = 0;
    private ppTime = 0;
    private pbTime = 0;
    private readonly directMv0 = new Int32Array(64);
    private readonly directMv1 = new Int32Array(64);

    // Prediction grids (allocated when dimensions are known).
    private gwY = 0;
    private gwC = 0;
    private dcY = new Int16Array(0);
    private dcU = new Int16Array(0);
    private dcV = new Int16Array(0);
    private acY = new Int16Array(0);
    private acU = new Int16Array(0);
    private acV = new Int16Array(0);
    private qscaleGrid = new Int8Array(0);

    // References (ref0 = older/forward, ref1 = newer/backward).
    private ref0: Frame | undefined;
    private ref1: Frame | undefined;
    private cur!: Frame;

    private br!: BitReader;
    private readonly block = new Int16Array(64);
    private readonly blockLastIndex = new Int32Array(6);
    private intraScan: Uint8Array = zigzagDirect;

    // B-frame motion-vector predictors (last_mv[dir][i][comp]).
    private readonly lastMv = [
        [new Int32Array(2), new Int32Array(2)],
        [new Int32Array(2), new Int32Array(2)],
    ];
    // Working MVs for the current MB: mv[dir][block][comp].
    private readonly mv = [
        [new Int32Array(2), new Int32Array(2), new Int32Array(2), new Int32Array(2)],
        [new Int32Array(2), new Int32Array(2), new Int32Array(2), new Int32Array(2)],
    ];
    private mbX = 0;
    private mbY = 0;

    // VLC tables.
    private readonly intraMcbpcVlc = new Vlc(intraMCBPC);
    private readonly interMcbpcVlc = new Vlc(interMCBPC);
    private readonly cbpyVlc = new Vlc(cbpyTab);
    private readonly mvVlc = new Vlc(mvTab);
    private readonly mbTypeBVlc = new Vlc(mbTypeBTab2);
    private readonly dcLumVlc = new Vlc(dcLumTab);
    private readonly dcChromVlc = new Vlc(dcChromTab);
    private readonly rlIntra = new RlDecoder(rlIntra);
    private readonly rlInter = new RlDecoder(rlInter);

    // --- Public API -------------------------------------------------------

    decode(packet: Uint8Array): Out[] {
        const out: Out[] = [];
        this.scanStartCodes(packet, out);
        return out;
    }

    flush(): Out[] {
        const out: Out[] = [];
        if (this.ref1) out.push(this.emit(this.ref1));
        this.ref0 = undefined;
        this.ref1 = undefined;
        return out;
    }

    // --- Start-code scanning ---------------------------------------------

    private scanStartCodes(data: Uint8Array, out: Out[]): void {
        const n = data.length;
        let i = 0;
        while (i + 4 <= n) {
            if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
                const code = data[i + 3]!;
                const after = i + 4;
                if (code >= 0x20 && code <= 0x2f) {
                    this.br = new BitReader(data, after);
                    this.decodeVolHeader();
                } else if (code === 0xb3) {
                    this.br = new BitReader(data, after);
                    this.decodeGopHeader();
                } else if (code === 0xb6) {
                    this.br = new BitReader(data, after);
                    this.decodeVop(out);
                    return; // one VOP per packet; slice consumes the rest
                }
                i = after;
            } else {
                i++;
            }
        }
    }

    private decodeGopHeader(): void {
        const br = this.br;
        const hours = br.getBits(5);
        const minutes = br.getBits(6);
        br.skipBits(1); // marker
        const seconds = br.getBits(6);
        this.timeBase = seconds + 60 * (minutes + 60 * hours);
        br.skipBits(2); // closed_gov, broken_link
    }

    // --- VOL header ------------------------------------------------------

    private decodeVolHeader(): void {
        const br = this.br;
        br.skipBits(1); // random_accessible_vol
        br.skipBits(8); // video_object_type_indication
        let voVerId = 1;
        if (br.getBits1()) {
            voVerId = br.getBits(4);
            br.skipBits(3); // priority
        }
        const aspect = br.getBits(4);
        if (aspect === 15) br.skipBits(16); // extended par

        if (br.getBits1()) { // vol_control_parameters
            br.skipBits(2); // chroma_format
            this.lowDelay = br.getBits1() !== 0;
            if (br.getBits1()) { // vbv parameters
                br.skipBits(15); br.skipBits(1);
                br.skipBits(15); br.skipBits(1);
                br.skipBits(15); br.skipBits(3);
                br.skipBits(11); br.skipBits(1);
                br.skipBits(15); br.skipBits(1);
            }
        }

        const shape = br.getBits(2); // 0 = rectangular
        if (shape === 3 && voVerId !== 1) br.skipBits(4);

        br.skipBits(1); // marker
        this.framerateNum = br.getBits(16);
        this.timeIncrementBits = Math.max(1, this.log2(this.framerateNum - 1) + 1);
        br.skipBits(1); // marker
        if (br.getBits1()) br.skipBits(this.timeIncrementBits); // fixed_vop_rate

        if (shape === 0) {
            br.skipBits(1); // marker
            this.width = br.getBits(13);
            br.skipBits(1); // marker
            this.height = br.getBits(13);
            br.skipBits(1); // marker
        }
        this.progressive = br.getBits1() === 0; // interlaced flag inverted
        br.skipBits(1); // obmc_disable
        const spriteUsage = voVerId === 1 ? br.getBits1() : br.getBits(2);
        if (spriteUsage !== 0) throw new Error("mp4v: sprites not supported");

        if (br.getBits1()) { // not_8_bit
            this.quantPrecision = br.getBits(4);
            br.skipBits(4); // bits_per_pixel
            if (this.quantPrecision < 3 || this.quantPrecision > 9) this.quantPrecision = 5;
        } else {
            this.quantPrecision = 5;
        }

        this.mpegQuant = br.getBits1() !== 0;
        if (this.mpegQuant) {
            if (br.getBits1()) this.skipQuantMatrix(); // intra
            if (br.getBits1()) this.skipQuantMatrix(); // non-intra
        }

        if (voVerId !== 1) br.skipBits(1); // quarter_sample (must be 0 for us)

        if (!br.getBits1()) { // not (complexity_estimation_disable)
            // We never see this in practice; bail loudly rather than mis-parse.
            throw new Error("mp4v: complexity estimation not supported");
        }
        br.skipBits(1); // resync_marker_disable
        const dataPartitioned = br.getBits1();
        if (dataPartitioned) throw new Error("mp4v: data partitioning not supported");

        this.mbWidth = (this.width + 15) >> 4;
        this.mbHeight = (this.height + 15) >> 4;
        this.mbStride = this.mbWidth + 1;
        this.allocGrids();
        this.volParsed = true;
    }

    private skipQuantMatrix(): void {
        const br = this.br;
        let v = 0;
        for (let i = 0; i < 64; i++) {
            v = br.getBits(8);
            if (v === 0) break;
        }
    }

    private allocGrids(): void {
        this.gwY = 2 * this.mbWidth + 1;
        this.gwC = this.mbWidth + 1;
        const ny = this.gwY * (2 * this.mbHeight + 1);
        const nc = this.gwC * (this.mbHeight + 1);
        this.dcY = new Int16Array(ny);
        this.dcU = new Int16Array(nc);
        this.dcV = new Int16Array(nc);
        this.acY = new Int16Array(ny * 16);
        this.acU = new Int16Array(nc * 16);
        this.acV = new Int16Array(nc * 16);
        this.qscaleGrid = new Int8Array(this.mbStride * (this.mbHeight + 1));
        this.dcY.fill(1024);
        this.dcU.fill(1024);
        this.dcV.fill(1024);
    }

    // --- VOP header ------------------------------------------------------

    private decodeVop(out: Out[]): void {
        if (!this.volParsed) throw new Error("mp4v: VOP before VOL");
        const br = this.br;
        this.pictType = br.getBits(2); // 0=I,1=P,2=B
        let timeIncr = 0;
        while (br.getBits1() !== 0) timeIncr++;
        br.skipBits(1); // marker
        const timeIncrement = br.getBits(this.timeIncrementBits);

        if (this.pictType !== PICT_B) {
            this.lastTimeBase = this.timeBase;
            this.timeBase += timeIncr;
            this.time = this.timeBase * this.framerateNum + timeIncrement;
            this.ppTime = this.time - this.lastNonBTime;
            this.lastNonBTime = this.time;
        } else {
            this.time = (this.lastTimeBase + timeIncr) * this.framerateNum + timeIncrement;
            this.pbTime = this.ppTime - (this.lastNonBTime - this.time);
        }

        br.skipBits(1); // marker
        if (br.getBits1() !== 1) return; // vop not coded

        if (this.pictType === PICT_P) this.noRounding = br.getBits1() !== 0;
        else this.noRounding = false;

        // shape == rect: no width/height/CR fields here.
        this.intraDcThreshold = dcThreshold[br.getBits(3)]!;
        if (!this.progressive) {
            br.skipBits(1); // top_field_first
            br.skipBits(1); // alternate_scan
        }
        this.intraScan = zigzagDirect;

        this.fCode = 1;
        this.bCode = 1;
        this.qscale = br.getBits(this.quantPrecision);
        this.setQscale(this.qscale);
        if (this.pictType !== PICT_I) this.fCode = br.getBits(3);
        if (this.pictType === PICT_B) this.bCode = br.getBits(3);

        // Allocate the output picture.
        this.cur = new Frame(this.width, this.height, this.mbStride, this.mbHeight);
        this.cur.vopTime = this.time;

        if (this.pictType === PICT_B) {
            this.initDirectMv();
            this.decodeSliceB();
        } else {
            this.resetPredGrids();
            this.decodeSlice();
            extendEdges(this.cur);
        }

        this.finishFrame(out);
    }

    private finishFrame(out: Out[]): void {
        if (this.pictType === PICT_B) {
            out.push(this.emit(this.cur));
            return;
        }
        // Reference frame: emit the displaced reference, then rotate.
        if (this.ref1) out.push(this.emit(this.ref1));
        this.ref0 = this.ref1;
        this.ref1 = this.cur;
    }

    private emit(f: Frame): Out {
        return { time: f.vopTime, data: packI420(f) };
    }

    private setQscale(q: number): void {
        if (q < 1) q = 1; else if (q > 31) q = 31;
        this.qscale = q;
        this.yDcScale = yDcScaleTable[q]!;
        this.cDcScale = cDcScaleTable[q]!;
    }

    private resetPredGrids(): void {
        // Borders stay 1024/0; interior cells are rewritten per MB (intra MBs
        // store real values, inter MBs clear to 1024/0 — see cleanIntra).
        this.dcY.fill(1024);
        this.dcU.fill(1024);
        this.dcV.fill(1024);
        this.acY.fill(0);
        this.acU.fill(0);
        this.acV.fill(0);
    }

    private initDirectMv(): void {
        const pp = this.ppTime || 1;
        for (let i = 0; i < 64; i++) {
            this.directMv0[i] = ((i - 32) * this.pbTime / pp) | 0;
            this.directMv1[i] = ((i - 32) * (this.pbTime - this.ppTime) / pp) | 0;
        }
    }

    // --- Slice decode (I / P) -------------------------------------------

    private decodeSlice(): void {
        for (this.mbY = 0; this.mbY < this.mbHeight; this.mbY++) {
            for (this.mbX = 0; this.mbX < this.mbWidth; this.mbX++) {
                if (this.pictType === PICT_I) this.decodeMbIntra();
                else this.decodeMbP();
            }
        }
    }

    private decodeSliceB(): void {
        for (this.mbY = 0; this.mbY < this.mbHeight; this.mbY++) {
            this.resetLastMvRow();
            for (this.mbX = 0; this.mbX < this.mbWidth; this.mbX++) {
                this.decodeMbB();
            }
        }
    }

    private resetLastMvRow(): void {
        for (let d = 0; d < 2; d++) {
            this.lastMv[d]![0]![0] = 0; this.lastMv[d]![0]![1] = 0;
            this.lastMv[d]![1]![0] = 0; this.lastMv[d]![1]![1] = 0;
        }
    }

    // --- Intra MB (I-VOP, or intra MB inside a P-VOP) --------------------

    private decodeMbIntra(): void {
        const br = this.br;
        let cbpc: number;
        do {
            cbpc = this.intraMcbpcVlc.read(br);
            if (cbpc < 0) throw new Error("mp4v: bad intra mcbpc");
        } while (cbpc === 8);
        const dquant = cbpc & 4;
        this.reconIntra(cbpc, dquant);
    }

    // Shared intra reconstruction (cbpc low bits hold chroma cbp; dquant flag).
    private reconIntra(cbpc: number, dquant: number): void {
        const br = this.br;
        this.acPred = br.getBits1() !== 0;
        const cbpy = this.cbpyVlc.read(br);
        if (cbpy < 0) throw new Error("mp4v: bad intra cbpy");
        let cbp = (cbpc & 3) | (cbpy << 2);
        const useDcVlc = this.qscale < this.intraDcThreshold;
        if (dquant) this.setQscale(this.qscale + QUANT_TAB[br.getBits(2)]!);
        this.qscaleGrid[this.mbX + this.mbY * this.mbStride] = this.qscale;
        if (this.pictType !== PICT_I) {
            this.cur.mbType[this.mbX + this.mbY * this.mbStride] = MB_INTRA;
            this.storeMotion(0, 0); // intra MBs predict as zero motion
        }

        for (let i = 0; i < 6; i++) {
            this.block.fill(0);
            this.decodeBlock(i, (cbp & 32) !== 0, true, useDcVlc);
            this.dequantIntra(i);
            this.idctIntra(i);
            cbp <<= 1;
        }
    }

    private dequantIntra(n: number): void {
        const b = this.block;
        b[0] = b[0]! * (n < 4 ? this.yDcScale : this.cDcScale);
        const qmul = this.qscale << 1;
        const qadd = (this.qscale - 1) | 1;
        for (let i = 1; i < 64; i++) {
            const l = b[i]!;
            if (l) b[i] = l < 0 ? l * qmul - qadd : l * qmul + qadd;
        }
    }

    private idctIntra(n: number): void {
        if (n < 4) {
            const off = this.cur.yOrigin + (this.mbY * 16 + (n >> 1) * 8) * this.cur.yStride +
                this.mbX * 16 + (n & 1) * 8;
            idctPut(this.cur.y, off, this.cur.yStride, this.block);
        } else {
            const off = this.cur.cOrigin + this.mbY * 8 * this.cur.cStride + this.mbX * 8;
            idctPut(n === 4 ? this.cur.u : this.cur.v, off, this.cur.cStride, this.block);
        }
    }

    // --- Inter MB (P-VOP) -----------------------------------------------

    private decodeMbP(): void {
        const br = this.br;
        const xy = this.mbX + this.mbY * this.mbStride;
        let cbpc: number;
        if (br.getBits1()) {
            // skipped MB: zero motion, copy from forward reference.
            this.cur.mbType[xy] = MB_SKIP;
            this.storeMotion(0, 0);
            this.mcInter(this.ref1!, 0, 0, 0, 0, false);
            this.cleanIntra();
            return;
        }
        do {
            cbpc = this.interMcbpcVlc.read(br);
            if (cbpc < 0) throw new Error("mp4v: bad inter mcbpc");
        } while (cbpc === 20);

        const dquant = cbpc & 8;
        if (cbpc & 4) {
            // Intra MB inside a P-frame.
            this.reconIntra(cbpc, dquant);
            return;
        }

        let cbpy = this.cbpyVlc.read(br);
        if (cbpy < 0) throw new Error("mp4v: bad P cbpy");
        cbpy ^= 0xf;
        let cbp = (cbpc & 3) | (cbpy << 2);
        if (dquant) this.setQscale(this.qscale + QUANT_TAB[br.getBits(2)]!);
        this.qscaleGrid[xy] = this.qscale;
        this.cleanIntra();

        const pxy = this.pxy;
        if ((cbpc & 16) === 0) {
            // 16x16 forward motion.
            this.cur.mbType[xy] = 0;
            this.predMotion(0, pxy);
            const mx = this.decodeMotion(pxy[0], this.fCode);
            const my = this.decodeMotion(pxy[1], this.fCode);
            this.storeMotion(mx, my);
            this.mcInter(this.ref1!, mx, my, mx, my, false);
        } else {
            // Four 8x8 forward vectors.
            this.cur.mbType[xy] = MB_8X8;
            let sumX = 0, sumY = 0;
            for (let i = 0; i < 4; i++) {
                this.predMotion(i, pxy);
                const mx = this.decodeMotion(pxy[0], this.fCode);
                const my = this.decodeMotion(pxy[1], this.fCode);
                this.setMotion(i, mx, my);
                sumX += mx; sumY += my;
                lumaMc(this.ref1!, mx, my,
                    this.mbX * 16 + (i & 1) * 8, this.mbY * 16 + (i >> 1) * 8, 8, 8,
                    this.cur.y, this.lumaOff(i), this.cur.yStride, false, this.noRounding);
            }
            const cmx = roundChroma(sumX);
            const cmy = roundChroma(sumY);
            this.mcChroma(this.ref1!, cmx, cmy, false);
        }

        // Residual.
        for (let i = 0; i < 6; i++) {
            if (cbp & 32) {
                this.block.fill(0);
                this.decodeBlock(i, true, false, false);
                this.idctAddBlock(i);
            }
            cbp <<= 1;
        }
    }

    // --- B MB ------------------------------------------------------------

    private decodeMbB(): void {
        const br = this.br;
        const xy = this.mbX + this.mbY * this.mbStride;
        const colocated = this.ref1!.mbType[xy]!;

        if (this.mbX === 0) this.resetLastMvRow();

        // Inherit skip from the colocated forward (next) reference MB.
        if (colocated & MB_SKIP) {
            this.directReconstruct(0, 0, colocated);
            return;
        }

        let cbp = 0;
        let direct = false;
        let mvCoded = false;
        let fwd = false;
        let bwd = false;
        const modb1 = br.getBits1();
        let mbType = 0;
        if (modb1) {
            // direct mode with no coded motion (skip-like).
            direct = true;
        } else {
            const modb2 = br.getBits1();
            mbType = this.mbTypeBVlc.read(br);
            if (mbType < 0) throw new Error("mp4v: bad B mb_type");
            if (!modb2) cbp = br.getBits(6);
            // mb_type: 0=direct,1=interpolate(bidir),2=backward,3=forward.
            if (mbType === 0) { direct = true; mvCoded = true; }
            else if (mbType === 1) { fwd = true; bwd = true; }
            else if (mbType === 2) bwd = true;
            else if (mbType === 3) fwd = true;

            if (!direct && cbp) {
                if (br.getBits1()) this.setQscale(this.qscale + br.getBits1() * 4 - 2);
            }
            // progressive: no interlaced_dct / field bits.

            if (fwd) {
                const mx = this.decodeMotion(this.lastMv[0]![0]![0], this.fCode);
                const my = this.decodeMotion(this.lastMv[0]![0]![1], this.fCode);
                this.lastMv[0]![0]![0] = mx; this.lastMv[0]![1]![0] = mx;
                this.lastMv[0]![0]![1] = my; this.lastMv[0]![1]![1] = my;
                for (let i = 0; i < 4; i++) { this.mv[0]![i]![0] = mx; this.mv[0]![i]![1] = my; }
            }
            if (bwd) {
                const mx = this.decodeMotion(this.lastMv[1]![0]![0], this.bCode);
                const my = this.decodeMotion(this.lastMv[1]![0]![1], this.bCode);
                this.lastMv[1]![0]![0] = mx; this.lastMv[1]![1]![0] = mx;
                this.lastMv[1]![0]![1] = my; this.lastMv[1]![1]![1] = my;
                for (let i = 0; i < 4; i++) { this.mv[1]![i]![0] = mx; this.mv[1]![i]![1] = my; }
            }
        }

        if (direct) {
            let mx = 0, my = 0;
            if (mvCoded) {
                mx = this.decodeMotion(0, 1);
                my = this.decodeMotion(0, 1);
            }
            this.directReconstruct(mx, my, colocated);
            this.bResidual(cbp);
            return;
        }

        // 16x16 fwd/bwd/bidir.
        this.mcBidir(fwd, bwd, false);
        this.bResidual(cbp);
    }

    private directReconstruct(mx: number, my: number, colocated: number): void {
        const use8x8 = (colocated & MB_8X8) !== 0;
        if (use8x8) {
            for (let i = 0; i < 4; i++) this.setDirectMv(mx, my, i);
        } else {
            this.setDirectMv(mx, my, 0);
            for (let i = 1; i < 4; i++) {
                this.mv[0]![i]![0] = this.mv[0]![0]![0]; this.mv[0]![i]![1] = this.mv[0]![0]![1];
                this.mv[1]![i]![0] = this.mv[1]![0]![0]; this.mv[1]![i]![1] = this.mv[1]![0]![1];
            }
        }
        this.mcBidir(true, true, use8x8);
    }

    private setDirectMv(mx: number, my: number, i: number): void {
        const idx = this.mvIndex(i);
        const pmx = this.ref1!.mv[idx * 2]!;
        const pmy = this.ref1!.mv[idx * 2 + 1]!;
        const pp = this.ppTime || 1;
        if ((pmx + 32) >>> 0 < 64) {
            this.mv[0]![i]![0] = this.directMv0[pmx + 32]! + mx;
            this.mv[1]![i]![0] = mx ? this.mv[0]![i]![0] - pmx : this.directMv1[pmx + 32]!;
        } else {
            this.mv[0]![i]![0] = ((pmx * this.pbTime / pp) | 0) + mx;
            this.mv[1]![i]![0] = mx ? this.mv[0]![i]![0] - pmx : (pmx * (this.pbTime - this.ppTime) / pp) | 0;
        }
        if ((pmy + 32) >>> 0 < 64) {
            this.mv[0]![i]![1] = this.directMv0[pmy + 32]! + my;
            this.mv[1]![i]![1] = my ? this.mv[0]![i]![1] - pmy : this.directMv1[pmy + 32]!;
        } else {
            this.mv[0]![i]![1] = ((pmy * this.pbTime / pp) | 0) + my;
            this.mv[1]![i]![1] = my ? this.mv[0]![i]![1] - pmy : (pmy * (this.pbTime - this.ppTime) / pp) | 0;
        }
    }

    private bResidual(cbp: number): void {
        for (let i = 0; i < 6; i++) {
            if (cbp & 32) {
                this.block.fill(0);
                this.decodeBlock(i, true, false, false);
                this.idctAddBlock(i);
            }
            cbp <<= 1;
        }
    }

    // Bidirectional MC using per-block mv[0]=fwd (ref0), mv[1]=bwd (ref1).
    private mcBidir(fwd: boolean, bwd: boolean, _use8x8: boolean): void {
        let fSumX = 0, fSumY = 0, bSumX = 0, bSumY = 0;
        for (let i = 0; i < 4; i++) {
            const px = this.mbX * 16 + (i & 1) * 8;
            const py = this.mbY * 16 + (i >> 1) * 8;
            const off = this.lumaOff(i);
            if (fwd) {
                lumaMc(this.ref0!, this.mv[0]![i]![0], this.mv[0]![i]![1], px, py, 8, 8,
                    this.cur.y, off, this.cur.yStride, false, this.noRounding);
            }
            if (bwd) {
                lumaMc(this.ref1!, this.mv[1]![i]![0], this.mv[1]![i]![1], px, py, 8, 8,
                    this.cur.y, off, this.cur.yStride, fwd, this.noRounding);
            }
            fSumX += this.mv[0]![i]![0]; fSumY += this.mv[0]![i]![1];
            bSumX += this.mv[1]![i]![0]; bSumY += this.mv[1]![i]![1];
        }
        if (fwd) this.mcChroma(this.ref0!, roundChroma(fSumX), roundChroma(fSumY), false);
        if (bwd) this.mcChroma(this.ref1!, roundChroma(bSumX), roundChroma(bSumY), fwd);
    }

    // --- Motion compensation helpers ------------------------------------

    private readonly pxy = new Int32Array(2);

    private lumaOff(block: number): number {
        return this.cur.yOrigin + (this.mbY * 16 + (block >> 1) * 8) * this.cur.yStride +
            this.mbX * 16 + (block & 1) * 8;
    }

    // 16x16 luma + chroma using a single forward/backward vector.
    private mcInter(ref: Frame, mx: number, my: number, sx: number, sy: number, avg: boolean): void {
        lumaMc(ref, mx, my, this.mbX * 16, this.mbY * 16, 16, 16,
            this.cur.y, this.cur.yOrigin + this.mbY * 16 * this.cur.yStride + this.mbX * 16,
            this.cur.yStride, avg, this.noRounding);
        this.mcChroma(ref, roundChroma(sx * 4), roundChroma(sy * 4), avg);
    }

    private mcChroma(ref: Frame, cmx: number, cmy: number, avg: boolean): void {
        const off = this.cur.cOrigin + this.mbY * 8 * this.cur.cStride + this.mbX * 8;
        chromaMc(ref, cmx, cmy, this.mbX * 8, this.mbY * 8,
            this.cur.u, this.cur.v, off, this.cur.cStride, avg, this.noRounding);
    }

    private idctAddBlock(n: number): void {
        if (n < 4) {
            idctAdd(this.cur.y, this.lumaOff(n), this.cur.yStride, this.block);
        } else {
            const off = this.cur.cOrigin + this.mbY * 8 * this.cur.cStride + this.mbX * 8;
            idctAdd(n === 4 ? this.cur.u : this.cur.v, off, this.cur.cStride, this.block);
        }
    }

    // --- Motion vector prediction (h263) --------------------------------

    private mvIndex(block: number): number {
        const wrap = this.cur.b8Stride;
        const col = 2 * this.mbX + (block & 1) + 1;
        const row = 2 * this.mbY + (block >> 1) + 1;
        return row * wrap + col;
    }

    private storeMotion(mx: number, my: number): void {
        const mv = this.cur.mv;
        for (let b = 0; b < 4; b++) {
            const idx = this.mvIndex(b);
            mv[idx * 2] = mx; mv[idx * 2 + 1] = my;
        }
    }

    private setMotion(block: number, mx: number, my: number): void {
        const idx = this.mvIndex(block);
        this.cur.mv[idx * 2] = mx; this.cur.mv[idx * 2 + 1] = my;
    }

    private predMotion(block: number, out: Int32Array): void {
        const wrap = this.cur.b8Stride;
        const mv = this.cur.mv;
        const idx = this.mvIndex(block);
        const aX = mv[(idx - 1) * 2]!, aY = mv[(idx - 1) * 2 + 1]!;
        const off = block === 0 ? 2 : block === 3 ? -1 : 1;
        const firstLine = this.mbY === 0;
        let px: number, py: number;
        if (firstLine && block < 3) {
            if (block === 0) {
                if (this.mbX === 0) { px = 0; py = 0; }
                else { px = aX; py = aY; }
            } else if (block === 1) {
                px = aX; py = aY;
            } else { // block 2
                const bX = mv[(idx - wrap) * 2]!, bY = mv[(idx - wrap) * 2 + 1]!;
                const c = idx + off - wrap;
                const cX = mv[c * 2]!, cY = mv[c * 2 + 1]!;
                const a0 = this.mbX === 0 ? 0 : aX;
                const a1 = this.mbX === 0 ? 0 : aY;
                px = midPred(a0, bX, cX); py = midPred(a1, bY, cY);
            }
        } else {
            const bX = mv[(idx - wrap) * 2]!, bY = mv[(idx - wrap) * 2 + 1]!;
            const c = idx + off - wrap;
            const cX = mv[c * 2]!, cY = mv[c * 2 + 1]!;
            px = midPred(aX, bX, cX); py = midPred(aY, bY, cY);
        }
        out[0] = px; out[1] = py;
    }

    private decodeMotion(pred: number, fCode: number): number {
        const br = this.br;
        const code = this.mvVlc.read(br);
        if (code === 0) return pred;
        if (code < 0) throw new Error("mp4v: bad mv code");
        const sign = br.getBits1();
        const shift = fCode - 1;
        let val = code;
        if (shift) {
            val = (val - 1) << shift;
            val |= br.getBits(shift);
            val++;
        }
        if (sign) val = -val;
        val += pred;
        // modulo / sign-extend to (5 + fCode) bits.
        const bits = 5 + fCode;
        const sb = 1 << (bits - 1);
        val &= (1 << bits) - 1;
        if (val & sb) val -= 1 << bits;
        return val;
    }

    // --- Block decode (DC/AC + RL) --------------------------------------

    private decodeBlock(n: number, coded: boolean, intra: boolean, useDcVlc: boolean): void {
        const br = this.br;
        const b = this.block;
        let i: number;
        let level = 0;
        let pred = 0;
        let dir = 0;
        let rl: RlDecoder;
        let scan: Uint8Array;
        let qmul: number, qadd: number;

        if (intra) {
            if (useDcVlc) {
                const r = this.decodeDc(n);
                level = r.level; dir = r.dir;
                b[0] = level;
                i = 0;
            } else {
                i = -1;
                const r = this.predDc(n);
                pred = r.pred; dir = r.dir;
            }
            if (!coded) {
                if (!useDcVlc) {
                    b[0] = this.getLevelDc(n, pred, b[0]!);
                    if (i < 0) i = 0;
                }
                this.predAc(n, dir);
                if (this.acPred) i = 63;
                this.blockLastIndex[n] = i;
                return;
            }
            rl = this.rlIntra;
            scan = this.acPred
                ? (dir === 0 ? alternateVerticalScan : alternateHorizontalScan)
                : this.intraScan;
            qmul = 1; qadd = 0;
        } else {
            i = -1;
            if (!coded) { this.blockLastIndex[n] = -1; return; }
            rl = this.rlInter;
            scan = this.intraScan;
            if (this.mpegQuant) { qmul = 1; qadd = 0; }
            else { qmul = this.qscale << 1; qadd = (this.qscale - 1) | 1; }
        }

        for (;;) {
            const idx = rl.vlc.read(br);
            if (idx < 0) throw new Error("mp4v: invalid rl code");
            if (idx !== rl.n) {
                let run = rl.run[idx]! + 1;
                if (idx >= rl.last) run += 192;
                level = rl.level[idx]! * qmul + qadd;
                i += run;
                if (br.getBits1()) level = -level;
            } else {
                const c = br.showBits(2);
                if ((c & 2) === 0) {
                    br.skipBits(1); // first escape "0"
                    const i2 = rl.vlc.read(br);
                    if (i2 < 0 || i2 === rl.n) throw new Error("mp4v: bad esc1");
                    const last2 = i2 >= rl.last ? 1 : 0;
                    let run = rl.run[i2]! + 1; if (last2) run += 192;
                    level = rl.level[i2]! * qmul + qadd;
                    i += run;
                    level += rl.maxLevel[last2]![rl.run[i2]!]! * qmul;
                    if (br.getBits1()) level = -level;
                } else if (c === 2) {
                    br.skipBits(2); // second escape "10"
                    const i2 = rl.vlc.read(br);
                    if (i2 < 0 || i2 === rl.n) throw new Error("mp4v: bad esc2");
                    const last2 = i2 >= rl.last ? 1 : 0;
                    let run = rl.run[i2]! + 1; if (last2) run += 192;
                    level = rl.level[i2]! * qmul + qadd;
                    i += run + rl.maxRun[last2]![rl.level[i2]!]! + 1;
                    if (br.getBits1()) level = -level;
                } else {
                    br.skipBits(2); // third escape "11"
                    const lastFlag = br.getBits1();
                    const run = br.getBits(6);
                    br.skipBits(1); // marker
                    level = br.getSBits(12);
                    br.skipBits(1); // marker
                    level = level > 0 ? level * qmul + qadd : level * qmul - qadd;
                    if (((level + 2048) >>> 0) > 4095) level = level < 0 ? -2048 : 2047;
                    i += run + 1;
                    if (lastFlag) i += 192;
                }
            }
            if (i > 62) {
                i -= 192;
                if (i & ~63) throw new Error("mp4v: ac-tex damaged");
                b[scan[i]!] = level;
                break;
            }
            b[scan[i]!] = level;
        }

        if (intra) {
            if (!useDcVlc) {
                b[0] = this.getLevelDc(n, pred, b[0]!);
                if (i < 0) i = 0;
            }
            this.predAc(n, dir);
            if (this.acPred) i = 63;
        }
        this.blockLastIndex[n] = i;
    }

    // --- DC prediction ---------------------------------------------------

    private dcCell(n: number): { grid: Int16Array; wrap: number; idx: number } {
        if (n < 4) {
            const col = 2 * this.mbX + (n & 1) + 1;
            const row = 2 * this.mbY + (n >> 1) + 1;
            return { grid: this.dcY, wrap: this.gwY, idx: row * this.gwY + col };
        }
        const idx = (this.mbY + 1) * this.gwC + (this.mbX + 1);
        return { grid: n === 4 ? this.dcU : this.dcV, wrap: this.gwC, idx };
    }

    private predDc(n: number): { pred: number; dir: number } {
        const { grid, wrap, idx } = this.dcCell(n);
        let a = grid[idx - 1]!;
        let b = grid[idx - 1 - wrap]!;
        let c = grid[idx - wrap]!;
        const firstLine = this.mbY === 0;
        if (firstLine && n !== 3) {
            if (n !== 2) { b = 1024; c = 1024; }
            if (n !== 1 && this.mbX === 0) { b = 1024; a = 1024; }
        }
        if (this.mbX === 0 && this.mbY === 1) {
            if (n === 0 || n === 4 || n === 5) b = 1024;
        }
        if (Math.abs(a - b) < Math.abs(b - c)) return { pred: c, dir: 1 };
        return { pred: a, dir: 0 };
    }

    private getLevelDc(n: number, pred: number, level: number): number {
        const scale = n < 4 ? this.yDcScale : this.cDcScale;
        pred = ((pred + (scale >> 1)) / scale) | 0;
        level += pred;
        const ret = level;
        let scaled = level * scale;
        if (scaled & ~2047) scaled = scaled < 0 ? 0 : 2047;
        const { grid, idx } = this.dcCell(n);
        grid[idx] = scaled;
        return ret;
    }

    private decodeDc(n: number): { level: number; dir: number } {
        const br = this.br;
        const code = (n < 4 ? this.dcLumVlc : this.dcChromVlc).read(br);
        if (code < 0) throw new Error("mp4v: illegal dc vlc");
        let level = 0;
        if (code !== 0) {
            level = this.getXbits(code);
            if (code > 8) br.skipBits(1); // marker
        }
        const { pred, dir } = this.predDc(n);
        return { level: this.getLevelDc(n, pred, level), dir };
    }

    private getXbits(n: number): number {
        const v = this.br.getBits(n);
        return (v & (1 << (n - 1))) ? v : v - (1 << n) + 1;
    }

    // --- AC prediction ---------------------------------------------------

    private acCell(n: number): { grid: Int16Array; wrap: number; base: number } {
        if (n < 4) {
            const col = 2 * this.mbX + (n & 1) + 1;
            const row = 2 * this.mbY + (n >> 1) + 1;
            return { grid: this.acY, wrap: this.gwY, base: (row * this.gwY + col) * 16 };
        }
        const idx = (this.mbY + 1) * this.gwC + (this.mbX + 1);
        return { grid: n === 4 ? this.acU : this.acV, wrap: this.gwC, base: idx * 16 };
    }

    private predAc(n: number, dir: number): void {
        const b = this.block;
        const { grid, wrap, base } = this.acCell(n);
        if (this.acPred) {
            if (dir === 0) {
                const xy = (this.mbX - 1) + this.mbY * this.mbStride;
                const lb = base - 16;
                const sameQ = this.mbX === 0 || this.qscale === this.qscaleGrid[xy] || n === 1 || n === 3;
                if (sameQ) {
                    for (let i = 1; i < 8; i++) b[i << 3] = b[i << 3]! + grid[lb + i]!;
                } else {
                    const nq = this.qscaleGrid[xy]!;
                    for (let i = 1; i < 8; i++) b[i << 3] = b[i << 3]! + roundedDiv(grid[lb + i]! * nq, this.qscale);
                }
            } else {
                const xy = this.mbX + (this.mbY - 1) * this.mbStride;
                const tb = base - 16 * wrap;
                const sameQ = this.mbY === 0 || this.qscale === this.qscaleGrid[xy] || n === 2 || n === 3;
                if (sameQ) {
                    for (let i = 1; i < 8; i++) b[i] = b[i]! + grid[tb + 8 + i]!;
                } else {
                    const nq = this.qscaleGrid[xy]!;
                    for (let i = 1; i < 8; i++) b[i] = b[i]! + roundedDiv(grid[tb + 8 + i]! * nq, this.qscale);
                }
            }
        }
        for (let i = 1; i < 8; i++) grid[base + i] = b[i << 3]!;
        for (let i = 1; i < 8; i++) grid[base + 8 + i] = b[i]!;
    }

    // Reset the current MB's intra prediction cells (inter/skip MBs), so a later
    // intra MB sees default 1024/0 neighbors (ff_clean_intra_table_entries).
    private cleanIntra(): void {
        const cy = 2 * this.mbX + 1;
        const ry = 2 * this.mbY + 1;
        const i0 = ry * this.gwY + cy;
        this.dcY[i0] = 1024; this.dcY[i0 + 1] = 1024;
        this.dcY[i0 + this.gwY] = 1024; this.dcY[i0 + this.gwY + 1] = 1024;
        const ci = (this.mbY + 1) * this.gwC + (this.mbX + 1);
        this.dcU[ci] = 1024; this.dcV[ci] = 1024;
        // ac: clear xy+1, xy+wrap, xy+wrap+1 (luma) + chroma; leave xy (top-left).
        this.acY.fill(0, (i0 + 1) * 16, (i0 + 2) * 16);
        this.acY.fill(0, (i0 + this.gwY) * 16, (i0 + this.gwY + 2) * 16);
        this.acU.fill(0, ci * 16, ci * 16 + 16);
        this.acV.fill(0, ci * 16, ci * 16 + 16);
    }

    private log2(v: number): number {
        let r = -1;
        while (v > 0) { v >>= 1; r++; }
        return r < 0 ? 0 : r;
    }

    get displayWidth(): number { return this.width; }
    get displayHeight(): number { return this.height; }
    get hasDims(): boolean { return this.volParsed; }
}
