const { BitReader } = require("./bitreader");
const { parseFrameHeader } = require("./header");
const tb = require("./tables");

// ---- fixed-point math (all intermediates < 2^53, safe in doubles) ----
const P2 = n => Math.pow(2, n);
function norm(a, bits) { return bits > 0 ? Math.floor((a + P2(bits - 1)) / P2(bits)) : a; }
const norm13 = a => norm(a, 13), norm21 = a => norm(a, 21), norm23 = a => norm(a, 23);
const mul = (a, b, bits) => norm(a * b, bits);
const mul17 = (a, b) => mul(a, b, 17), mul23 = (a, b) => mul(a, b, 23);
function clip23(a) { return a < -8388608 ? -8388608 : a > 8388607 ? 8388607 : a; }
function av_log2(x) { return 31 - Math.clz32(x); }

const SUBBANDS = 32, SUBBAND_SAMPLES = 8, ADPCM_COEFFS = 4, CODE_BOOKS = 10, ABITS_MAX = 26;

// DCASpeaker enum order (dca.h): C, L, R, Ls, Rs, LFE1, Cs, ...
const SPK_NAME = ["FC", "FL", "FR", "SL", "SR", "LFE", "BC"];
// prm_ch_to_spkr_map (dca_core.c): per audio_mode, the speaker each decoded
// primary channel feeds. -1 = unused. Indexes into SPK_NAME above.
const PRM_CH_TO_SPKR = [
    [0, -1, -1, -1, -1],            // 0: mono            -> C
    [1, 2, -1, -1, -1],             // 1: stereo          -> L R
    [1, 2, -1, -1, -1],             // 2
    [1, 2, -1, -1, -1],             // 3
    [1, 2, -1, -1, -1],             // 4
    [0, 1, 2, -1, -1],              // 5: 3.0             -> C L R
    [1, 2, 6, -1, -1],              // 6: 2.1             -> L R Cs
    [0, 1, 2, 6, -1],               // 7: 3.1             -> C L R Cs
    [1, 2, 3, 4, -1],               // 8: 2.2             -> L R Ls Rs
    [0, 1, 2, 3, 4],                // 9: 5.0             -> C L R Ls Rs
];
// Canonical (WAV/SMPTE) output rank for each speaker: FL, FR, FC, LFE, SL, SR, BC.
const SPK_RANK = { FL: 0, FR: 1, FC: 2, LFE: 3, SL: 4, SR: 5, BC: 6 };

// ---------------- IMDCT (dcadct.c imdct_half[0]) ----------------
const DCTA = [[8348215,8027397,7398092,6484482,5321677,3954362,2435084,822227],[8027397,5321677,822227,-3954362,-7398092,-8348215,-6484482,-2435084],[7398092,822227,-6484482,-8027397,-2435084,5321677,8348215,3954362],[6484482,-3954362,-8027397,822227,8348215,2435084,-7398092,-5321677],[5321677,-7398092,-2435084,8348215,-822227,-8027397,3954362,6484482],[3954362,-8348215,5321677,2435084,-8027397,6484482,822227,-7398092],[2435084,-6484482,8348215,-7398092,3954362,822227,-5321677,8027397],[822227,-2435084,3954362,-5321677,6484482,-7398092,8027397,-8348215]];
const DCTB = [[8227423,7750063,6974873,5931642,4660461,3210181,1636536],[6974873,3210181,-1636536,-5931642,-8227423,-7750063,-4660461],[4660461,-3210181,-8227423,-5931642,1636536,7750063,6974873],[1636536,-7750063,-4660461,5931642,6974873,-3210181,-8227423],[-1636536,-7750063,4660461,5931642,-6974873,-3210181,8227423],[-4660461,-3210181,8227423,-5931642,-1636536,7750063,-6974873],[-6974873,3210181,1636536,-5931642,8227423,-7750063,4660461],[-8227423,7750063,-6974873,5931642,-4660461,3210181,-1636536]];
const MODA = [4199362,4240198,4323885,4454708,4639772,4890013,5221943,5660703,-6245623,-7040975,-8158494,-9809974,-12450076,-17261920,-28585092,-85479984];
const MODB = [4214598,4383036,4755871,5425934,6611520,8897610,14448934,42791536];
const MODC = [1048892,1051425,1056522,1064244,1074689,1087987,1104313,1123884,1146975,1173922,1205139,1241133,1282529,1330095,1384791,1447815,-1520688,-1605358,-1704360,-1821051,-1959964,-2127368,-2332183,-2587535,-2913561,-3342802,-3931480,-4785806,-6133390,-8566050,-14253820,-42727120];
function sumA(inp, off, out, oo, len) { for (let i = 0; i < len; i++) out[oo + i] = inp[off + 2 * i] + inp[off + 2 * i + 1]; }
function sumB(inp, off, out, oo, len) { out[oo] = inp[off]; for (let i = 1; i < len; i++) out[oo + i] = inp[off + 2 * i] + inp[off + 2 * i - 1]; }
function sumC(inp, off, out, oo, len) { for (let i = 0; i < len; i++) out[oo + i] = inp[off + 2 * i]; }
function sumD(inp, off, out, oo, len) { out[oo] = inp[off + 1]; for (let i = 1; i < len; i++) out[oo + i] = inp[off + 2 * i - 1] + inp[off + 2 * i + 1]; }
function clpV(a, off, len) { for (let i = 0; i < len; i++) a[off + i] = clip23(a[off + i]); }
function dctA(inp, io, out, oo) { for (let i = 0; i < 8; i++) { let r = 0; for (let j = 0; j < 8; j++) r += DCTA[i][j] * inp[io + j]; out[oo + i] = norm23(r); } }
function dctB(inp, io, out, oo) { for (let i = 0; i < 8; i++) { let r = inp[io] * P2(23); for (let j = 0; j < 7; j++) r += DCTB[i][j] * inp[io + 1 + j]; out[oo + i] = norm23(r); } }
function modA(inp, io, out, oo) { for (let i = 0; i < 8; i++) out[oo + i] = mul23(MODA[i], inp[io + i] + inp[io + 8 + i]); for (let i = 8, k = 7; i < 16; i++, k--) out[oo + i] = mul23(MODA[i], inp[io + k] - inp[io + 8 + k]); }
function modB(inp, io, out, oo) { for (let i = 0; i < 8; i++) inp[io + 8 + i] = mul23(MODB[i], inp[io + 8 + i]); for (let i = 0; i < 8; i++) out[oo + i] = inp[io + i] + inp[io + 8 + i]; for (let i = 8, k = 7; i < 16; i++, k--) out[oo + i] = inp[io + k] - inp[io + 8 + k]; }
function modC(inp, out) { for (let i = 0; i < 16; i++) out[i] = mul23(MODC[i], inp[i] + inp[16 + i]); for (let i = 16, k = 15; i < 32; i++, k--) out[i] = mul23(MODC[i], inp[k] - inp[16 + k]); }
function imdct_half_32(output, input) {
    const a = new Array(32), b = new Array(32);
    let mag = 0; for (let i = 0; i < 32; i++) mag += Math.abs(input[i]);
    const shift = mag > 0x400000 ? 2 : 0, round = shift > 0 ? 1 << (shift - 1) : 0;
    for (let i = 0; i < 32; i++) a[i] = Math.floor((input[i] + round) / P2(shift));
    sumA(a, 0, b, 0, 16); sumB(a, 0, b, 16, 16); clpV(b, 0, 32);
    sumA(b, 0, a, 0, 8); sumB(b, 0, a, 8, 8); sumC(b, 16, a, 16, 8); sumD(b, 16, a, 24, 8); clpV(a, 0, 32);
    dctA(a, 0, b, 0); dctB(a, 8, b, 8); dctB(a, 16, b, 16); dctB(a, 24, b, 24); clpV(b, 0, 32);
    modA(b, 0, a, 0); modB(b, 16, a, 16); clpV(a, 0, 32);
    modC(a, b);
    for (let i = 0; i < 32; i++) b[i] = clip23(b[i] * P2(shift));
    for (let i = 0, k = 31; i < 16; i++, k--) { output[i] = clip23(b[i] - b[k]); output[16 + i] = clip23(b[i] + b[k]); }
}


// ---------------- synth filter (synth_filter_fixed, 32-band) ----------------
function synthFilter(st, window, out, inp) {
    const sb = st.hist1, off = st.offset, h2 = st.hist2;
    const tmp = st._tmp; imdct_half_32(tmp, inp);
    for (let i = 0; i < 32; i++) sb[off + i] = tmp[i];
    for (let i = 0; i < 16; i++) {
        let a = h2[i] * P2(21), b = h2[i + 16] * P2(21), c = 0, d = 0, j = 0;
        for (; j < 512 - off; j += 64) {
            a += window[i + j] * sb[off + i + j];
            b += window[i + j + 16] * sb[off + 15 - i + j];
            c += window[i + j + 32] * sb[off + 16 + i + j];
            d += window[i + j + 48] * sb[off + 31 - i + j];
        }
        for (; j < 512; j += 64) {
            a += window[i + j] * sb[off + i + j - 512];
            b += window[i + j + 16] * sb[off + 15 - i + j - 512];
            c += window[i + j + 32] * sb[off + 16 + i + j - 512];
            d += window[i + j + 48] * sb[off + 31 - i + j - 512];
        }
        out[i] = clip23(norm21(a)); out[i + 16] = clip23(norm21(b));
        h2[i] = norm21(c); h2[i + 16] = norm21(d);
    }
    st.offset = (off - 32) & 511;
}

// ---------------- LFE FIR (lfe_fir_float_c, 64-band) ----------------
// `lfe` is the persistent buffer of int32 decimated samples; `lfeBase` points
// at the first decoded sample (== DCA_LFE_HISTORY). Each decimated sample makes
// 64 interpolated output samples. We mirror ffmpeg's *float* decoder
// (lfe_fir_float_c with ff_dca_lfe_fir_64) — its default path — rather than the
// fixed-point table, which is a different filter decomposition. `fir` holds the
// SCALE()'d float coefficients (already divided by 2^23), so the result is in
// normalized [-1, 1]; we store it pre-multiplied by 2^23 to share the common
// output scaling with the QMF int32 channels.
// decSelect=0 => 64-band (factor 64, 8 taps); decSelect=1 => 128-band (factor
// 128, 4 taps). Generalizes lfe_fir_float_c.
function lfeFir(out, lfe, lfeBase, fir, npcmblocks, decSelect) {
    const factor = 64 << decSelect, ncoeffs = 8 >> decSelect, half = factor >> 1;
    const nlfe = npcmblocks >> (decSelect + 1);
    const S = P2(23);
    for (let i = 0; i < nlfe; i++) {
        const base = lfeBase + i;
        for (let j = 0; j < half; j++) {
            let a = 0, b = 0;
            for (let k = 0; k < ncoeffs; k++) {
                const s = lfe[base - k];
                a += fir[j * ncoeffs + k] * s;
                b += fir[255 - j * ncoeffs - k] * s;
            }
            out[i * factor + j] = a * S;
            out[i * factor + half + j] = b * S;
        }
    }
}

// ---------------- decoder ----------------
function decodeFrame(gb, st) {
    const h = parseFrameHeader(gb);
    const npcm = h.npcmblocks;
    // (re)allocate persistent buffers
    if (!st.subband || st.npcm !== npcm) {
        st.npcm = npcm;
        st.subband = [];
        for (let ch = 0; ch < 8; ch++) { st.subband[ch] = []; for (let b = 0; b < SUBBANDS; b++) st.subband[ch][b] = new Float64Array(ADPCM_COEFFS + npcm); }
        st.synth = []; for (let ch = 0; ch < 8; ch++) st.synth[ch] = { hist1: new Float64Array(512), hist2: new Float64Array(32), offset: 0, _tmp: new Array(32) };
        // LFE: DCA_LFE_HISTORY(8) + npcm/2 decimated samples. Zero-filled =>
        // correct initial history; history carries across frames thereafter.
        st.lfe = new Float64Array(8 + (npcm >> 1));
    }
    if (!h.predictor_history) for (let ch = 0; ch < 8; ch++) for (let b = 0; b < SUBBANDS; b++) st.subband[ch][b].fill(0);

    const nch = h.nchannels;
    const S = { gb, h, nch,
        nsubbands: [], subband_vq_start: [], joint_intensity_index: [], transition_mode_sel: [],
        scale_factor_sel: [], bit_allocation_sel: [], quant_index_sel: [], scale_factor_adj: [],
        prediction_mode: [], prediction_vq_index: [], bit_allocation: [], transition_mode: [],
        scale_factors: [], joint_scale_sel: [], joint_scale_factors: [], nsubsubframes: [], nsubframes: 0,
        subband: st.subband };
    for (let ch = 0; ch < nch; ch++) { S.quant_index_sel[ch] = new Array(CODE_BOOKS).fill(0); S.scale_factor_adj[ch] = new Array(CODE_BOOKS).fill(1 << 22); S.prediction_mode[ch] = []; S.prediction_vq_index[ch] = []; S.bit_allocation[ch] = new Array(SUBBANDS).fill(0); S.scale_factors[ch] = []; S.joint_scale_factors[ch] = new Array(SUBBANDS).fill(0); for (let b = 0; b < SUBBANDS; b++) S.scale_factors[ch][b] = [0, 0]; }

    parseCodingHeader(S);
    let sub_pos = 0;
    S.lfe = st.lfe; S.lfe_pos = 8; // DCA_LFE_HISTORY
    for (let sf = 0; sf < S.nsubframes; sf++) {
        parseSubframeHeader(S, sf);
        sub_pos = parseSubframeAudio(S, sf, sub_pos, st);
    }
    // ADPCM history update for next frame
    for (let ch = 0; ch < nch; ch++) {
        let nsub = S.nsubbands[ch];
        if (S.joint_intensity_index[ch]) nsub = Math.max(nsub, S.nsubbands[S.joint_intensity_index[ch] - 1]);
        for (let b = 0; b < nsub; b++) { const buf = st.subband[ch][b]; for (let k = 0; k < 4; k++) buf[k] = buf[npcm + k]; }
        for (let b = nsub; b < SUBBANDS; b++) st.subband[ch][b].fill(0);
    }
    // QMF synthesis -> int32 PCM per channel
    const window = h.filter_perfect ? tb.fir_perfect : tb.fir_nonperfect;
    const nsamples = npcm * 32;
    const pcm = [];
    const input = new Array(32);
    for (let ch = 0; ch < nch; ch++) {
        const o = new Int32Array(nsamples);
        const out = new Array(32);
        for (let j = 0; j < npcm; j++) {
            for (let i = 0; i < 32; i++) input[i] = st.subband[ch][i][ADPCM_COEFFS + j];
            synthFilter(st.synth[ch], window, out, input);
            for (let i = 0; i < 32; i++) o[j * 32 + i] = out[i];
        }
        pcm.push(o);
    }
    let outnch = nch;
    // LFE channel: interpolate the decimated LFE samples, then carry history.
    if (h.lfe_present) {
        // lfe_present: 1 = 128-band (DCA_LFE_FLAG_128), 2 = 64-band.
        const decSelect = h.lfe_present === 1 ? 1 : 0;
        const fir = decSelect ? tb.lfe_fir_128_float : tb.lfe_fir_64_float;
        const lfeOut = new Float64Array(nsamples);
        lfeFir(lfeOut, st.lfe, 8 /* DCA_LFE_HISTORY */, fir, npcm, decSelect);
        pcm.push(lfeOut);
        outnch = nch + 1;
        // Update LFE history: copy the last 8 decimated samples to the front.
        const nlfesamples = npcm >> (decSelect + 1);
        for (let n = 7; n >= 0; n--) st.lfe[n] = st.lfe[nlfesamples + n];
    }
    // Speaker label per output channel (decode order; LFE appended last).
    const map = PRM_CH_TO_SPKR[h.audio_mode] || [];
    const spk = [];
    for (let ch = 0; ch < nch; ch++) spk.push(SPK_NAME[map[ch]] || ("C" + ch));
    if (h.lfe_present) spk.push("LFE");
    return { pcm, nsamples, nch: outnch, spk, frame_size: h.frame_size, sampleRate: h.sample_rate };
}

function parseCodingHeader(S) {
    const gb = S.gb, nch = S.nch;
    S.nsubframes = gb.bits(4) + 1;
    const ncheck = gb.bits(3) + 1; // primary audio channels (== nchannels)
    for (let ch = 0; ch < nch; ch++) S.nsubbands[ch] = gb.bits(5) + 2;
    for (let ch = 0; ch < nch; ch++) S.subband_vq_start[ch] = gb.bits(5) + 1;
    for (let ch = 0; ch < nch; ch++) S.joint_intensity_index[ch] = gb.bits(3);
    for (let ch = 0; ch < nch; ch++) S.transition_mode_sel[ch] = gb.bits(2);
    for (let ch = 0; ch < nch; ch++) S.scale_factor_sel[ch] = gb.bits(3);
    for (let ch = 0; ch < nch; ch++) S.bit_allocation_sel[ch] = gb.bits(3);
    for (let n = 0; n < CODE_BOOKS; n++) for (let ch = 0; ch < nch; ch++) S.quant_index_sel[ch][n] = gb.bits(tb.quant_index_sel_nbits[n]);
    for (let n = 0; n < CODE_BOOKS; n++) for (let ch = 0; ch < nch; ch++) if (S.quant_index_sel[ch][n] < tb.quant_index_group_size[n]) S.scale_factor_adj[ch][n] = tb.scale_factor_adj[gb.bits(2)];
    if (S.h.crc_present) gb.skip(16);
}

function parseScale(gb, st, sel) {
    const table = sel > 5 ? tb.scale_factor_quant7 : tb.scale_factor_quant6;
    if (sel < 5) st.idx += tb.getVLC(gb, tb.vlc_scale_factor[sel]);
    else st.idx = gb.bits(sel + 1);
    return table[st.idx];
}
function parseJointScale(gb, sel) {
    let idx = sel < 5 ? tb.getVLC(gb, tb.vlc_scale_factor[sel]) : gb.bits(sel + 1);
    idx += 64;
    return tb.joint_scale_factors[idx];
}

function parseSubframeHeader(S, sf) {
    const gb = S.gb, nch = S.nch;
    S.nsubsubframes[sf] = gb.bits(2) + 1;
    gb.skip(3);
    for (let ch = 0; ch < nch; ch++) for (let b = 0; b < S.nsubbands[ch]; b++) S.prediction_mode[ch][b] = gb.bit();
    for (let ch = 0; ch < nch; ch++) for (let b = 0; b < S.nsubbands[ch]; b++) if (S.prediction_mode[ch][b]) S.prediction_vq_index[ch][b] = gb.bits(12);
    for (let ch = 0; ch < nch; ch++) { const sel = S.bit_allocation_sel[ch]; for (let b = 0; b < S.subband_vq_start[ch]; b++) { let abits; if (sel < 5) abits = tb.getVLC(gb, tb.vlc_bit_allocation[sel]); else abits = gb.bits(sel - 1); S.bit_allocation[ch][b] = abits; } }
    for (let ch = 0; ch < nch; ch++) { if (!S.transition_mode[sf]) S.transition_mode[sf] = []; S.transition_mode[sf][ch] = new Array(SUBBANDS).fill(0); if (S.nsubsubframes[sf] > 1) { const sel = S.transition_mode_sel[ch]; for (let b = 0; b < S.subband_vq_start[ch]; b++) if (S.bit_allocation[ch][b]) S.transition_mode[sf][ch][b] = tb.getVLC(gb, tb.vlc_transition_mode[sel]); } }
    for (let ch = 0; ch < nch; ch++) { const sel = S.scale_factor_sel[ch]; const st = { idx: 0 }; for (let b = 0; b < S.subband_vq_start[ch]; b++) { if (S.bit_allocation[ch][b]) { S.scale_factors[ch][b][0] = parseScale(gb, st, sel); if (S.transition_mode[sf][ch][b]) S.scale_factors[ch][b][1] = parseScale(gb, st, sel); } else S.scale_factors[ch][b][0] = 0; } for (let b = S.subband_vq_start[ch]; b < S.nsubbands[ch]; b++) S.scale_factors[ch][b][0] = parseScale(gb, st, sel); }
    for (let ch = 0; ch < nch; ch++) if (S.joint_intensity_index[ch]) S.joint_scale_sel[ch] = gb.bits(3);
    for (let ch = 0; ch < nch; ch++) { const src = S.joint_intensity_index[ch] - 1; if (src >= 0) { const sel = S.joint_scale_sel[ch]; for (let b = S.nsubbands[ch]; b < S.nsubbands[src]; b++) S.joint_scale_factors[ch][b] = parseJointScale(gb, sel); } }
    if (S.h.drc_present) gb.skip(8);
    if (S.h.crc_present) gb.skip(16);
}

function decodeBlockcodes(c1, c2, levels, audio) {
    const offset = (levels - 1) >> 1; let n;
    for (n = 0; n < 4; n++) { const div = Math.floor(c1 / levels); audio[n] = c1 - div * levels - offset; c1 = div; }
    for (; n < 8; n++) { const div = Math.floor(c2 / levels); audio[n] = c2 - div * levels - offset; c2 = div; }
    return c1 | c2;
}
function extractAudio(S, audio, abits, ch) {
    const gb = S.gb;
    if (abits === 0) { for (let i = 0; i < 8; i++) audio[i] = 0; return 0; }
    if (abits <= CODE_BOOKS) {
        const sel = S.quant_index_sel[ch][abits - 1];
        if (sel < tb.quant_index_group_size[abits - 1]) { for (let i = 0; i < 8; i++) audio[i] = tb.getVLC(gb, tb.vlc_quant_index[abits - 1][sel]); return 1; }
        if (abits <= 7) { const nb = tb.block_code_nbits[abits - 1]; const c1 = gb.bits(nb), c2 = gb.bits(nb); decodeBlockcodes(c1, c2, tb.quant_levels[abits], audio); return 0; }
    }
    getArraySigned(gb, audio, 8, abits - 3);
    return 0;
}
function getArraySigned(gb, audio, n, bits) { const sign = 1 << (bits - 1), full = 1 << bits; for (let i = 0; i < n; i++) { let v = gb.bits(bits); if (v >= sign) v -= full; audio[i] = v; } }

function dequantize(out, ofs, input, step_size, scale, residual) {
    let step_scale = step_size * scale, shift = 0;
    if (step_scale > (1 << 23)) { shift = av_log2(Math.floor(step_scale / P2(23))) + 1; step_scale = Math.floor(step_scale / P2(shift)); }
    for (let n = 0; n < 8; n++) { const v = clip23(norm(input[n] * step_scale, 22 - shift)); if (residual) out[ofs + n] += v; else out[ofs + n] = v; }
}
// Inverse ADPCM: predict from the 4 PAST samples (ptr[j-1..j-4]), coeff[0] on
// the most recent. Matches ff_dcaadpcm_predict (input[DCA_ADPCM_COEFFS-1-i]).
function adpcmPredict(predId, buf, base) { const co = tb.adpcm_vb[predId]; let pred = 0; for (let i = 0; i < 4; i++) pred += buf[base - 1 - i] * co[i]; return clip23(norm13(pred)); }

function parseSubframeAudio(S, sf, sub_pos, st) {
    const gb = S.gb, nch = S.nch, npcm = S.h.npcmblocks;
    const nsamples = S.nsubsubframes[sf] * SUBBAND_SAMPLES;
    const audio = new Array(16).fill(0);
    // VQ encoded subbands (high frequency)
    for (let ch = 0; ch < nch; ch++) {
        const vq = new Array(SUBBANDS).fill(0);
        for (let b = S.subband_vq_start[ch]; b < S.nsubbands[ch]; b++) vq[b] = gb.bits(10);
        for (let b = S.subband_vq_start[ch]; b < S.nsubbands[ch]; b++) {
            const coeff = tb.high_freq_vq[vq[b]]; const scale = S.scale_factors[ch][b][0]; const buf = st.subband[ch][b];
            for (let n = 0; n < nsamples; n++) buf[ADPCM_COEFFS + sub_pos + n] = clip23(Math.floor((coeff[n] * scale + 8) / 16));
        }
    }
    // LFE samples (low-frequency effects channel)
    if (S.h.lfe_present) {
        const nlfe = 2 * S.h.lfe_present * S.nsubsubframes[sf];
        const lfeaud = new Array(nlfe);
        getArraySigned(gb, lfeaud, nlfe, 8);
        const index = gb.bits(8);
        if (index >= tb.scale_factor_quant7.length) throw new Error("Invalid LFE scale factor index");
        // 7-bit RMS table, then quantizer step size 0.035 = 4697620/(1<<27).
        const scale = mul23(4697620, tb.scale_factor_quant7[index]);
        for (let n = 0; n < nlfe; n++) S.lfe[S.lfe_pos++] = clip23(Math.floor((lfeaud[n] * scale) / 16));
    }
    // Audio data
    let ofs = sub_pos;
    for (let ssf = 0; ssf < S.nsubsubframes[sf]; ssf++) {
        for (let ch = 0; ch < nch; ch++) {
            for (let b = 0; b < S.subband_vq_start[ch]; b++) {
                const abits = S.bit_allocation[ch][b];
                const ret = extractAudio(S, audio, abits, ch);
                const step_size = S.h.bit_rate === 3 ? tb.lossless_quant[abits] : tb.lossy_quant[abits];
                const trans = S.transition_mode[sf][ch][b];
                let scale = (trans === 0 || ssf < trans) ? S.scale_factors[ch][b][0] : S.scale_factors[ch][b][1];
                if (ret > 0) { const adj = S.scale_factor_adj[ch][abits - 1]; scale = clip23(Math.floor((adj * scale) / P2(22))); }
                dequantize(st.subband[ch][b], ADPCM_COEFFS + ofs, audio, step_size, scale, 0);
            }
        }
        if ((ssf === S.nsubsubframes[sf] - 1 || S.h.sync_ssf) && gb.bits(16) !== 0xffff) throw new Error("DSYNC fail sf=" + sf + " ssf=" + ssf);
        ofs += SUBBAND_SAMPLES;
    }
    // Inverse ADPCM
    for (let ch = 0; ch < nch; ch++) {
        for (let b = 0; b < S.nsubbands[ch]; b++) {
            if (S.prediction_mode[ch][b]) {
                const predId = S.prediction_vq_index[ch][b]; const buf = st.subband[ch][b];
                for (let j = 0; j < nsamples; j++) { const x = adpcmPredict(predId, buf, ADPCM_COEFFS + sub_pos + j); buf[ADPCM_COEFFS + sub_pos + j] = clip23(buf[ADPCM_COEFFS + sub_pos + j] + x); }
            }
        }
    }
    // Joint subband coding
    for (let ch = 0; ch < nch; ch++) {
        const src = S.joint_intensity_index[ch] - 1;
        if (src >= 0) {
            for (let b = S.nsubbands[ch]; b < S.nsubbands[src]; b++) {
                const scale = S.joint_scale_factors[ch][b]; const dst = st.subband[ch][b], srcb = st.subband[src][b];
                for (let n = 0; n < nsamples; n++) dst[ADPCM_COEFFS + sub_pos + n] = clip23(mul17(srcb[ADPCM_COEFFS + sub_pos + n], scale));
            }
        }
    }
    return ofs;
}

const OUT_SCALE = 1 / Math.pow(2, 23);

// Canonical channel permutation (decode order -> WAV/Web-Audio speaker order:
// FL, FR, FC, LFE, SL, SR, ...). Unknown speakers keep their relative order
// after the known ones. Returns the index permutation.
function canonicalOrder(spk) {
    return spk.map((_, ch) => ch).sort((x, y) => {
        const rx = SPK_RANK[spk[x]] ?? (100 + x), ry = SPK_RANK[spk[y]] ?? (100 + y);
        return rx - ry;
    });
}

function isSync(d, p) {
    return d[p] === 0x7f && d[p + 1] === 0xfe && d[p + 2] === 0x80 && d[p + 3] === 0x01;
}

function asU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
}

// Streaming decoder: holds inter-frame state (ADPCM/QMF/LFE history) so frames
// must be fed in order. One DTS Core frame in -> one block of PCM out.
class DcaDecoder {
    constructor() { this.st = {}; }
    // Decode a single core frame (must start with the 0x7FFE8001 sync). Returns
    // { sampleRate, channels, layout, samples, frameSize, pcm:[Float32Array...] }
    // with channels already in canonical speaker order. `frameSize` is the byte
    // length consumed, so the caller can advance past trailing extension data.
    decodeFrame(bytes) {
        const data = asU8(bytes);
        if (!isSync(data, 0)) throw new Error("not a DTS core frame (bad sync)");
        const r = decodeFrame(new BitReader(data), this.st);
        const order = canonicalOrder(r.spk);
        const pcm = order.map(ch => {
            const src = r.pcm[ch], out = new Float32Array(src.length);
            for (let i = 0; i < src.length; i++) out[i] = src[i] * OUT_SCALE;
            return out;
        });
        return {
            sampleRate: r.sampleRate, channels: r.nch, layout: order.map(ch => r.spk[ch]),
            samples: r.nsamples, frameSize: r.frame_size, pcm,
        };
    }
}

// Batch: decode a whole buffer of concatenated DTS core frames into one
// Float32Array per channel (canonical speaker order). Stops at the first
// non-sync position (e.g. trailing/extension data we don't decode).
function decodeFile(bytes) {
    const data = asU8(bytes);
    const dec = new DcaDecoder();
    const chans = []; let nch = 0, sampleRate = 0, layout = [];
    let pos = 0;
    while (pos + 4 <= data.length && isSync(data, pos)) {
        const r = dec.decodeFrame(data.subarray(pos));
        nch = r.channels; sampleRate = r.sampleRate; layout = r.layout;
        for (let ch = 0; ch < nch; ch++) { if (!chans[ch]) chans[ch] = []; chans[ch].push(r.pcm[ch]); }
        pos += r.frameSize;
    }
    const pcm = [];
    for (let ch = 0; ch < nch; ch++) {
        let total = 0; for (const b of chans[ch]) total += b.length;
        const a = new Float32Array(total); let o = 0;
        for (const blk of chans[ch]) { a.set(blk, o); o += blk.length; }
        pcm.push(a);
    }
    return { sampleRate, channels: nch, pcm, layout };
}

module.exports = { decodeFile, DcaDecoder, getArraySigned };
