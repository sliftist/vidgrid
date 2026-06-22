const T = require("./_tables");
const reshape = (flat, cols) => { const r = []; for (let i = 0; i < flat.length; i += cols) r.push(flat.slice(i, i + cols)); return r; };

const group_size = T.ff_dca_quant_index_group_size;     // [10]
const bitalloc_sizes = T.ff_dca_bitalloc_sizes;         // [10]
const bitalloc_offsets = T.ff_dca_bitalloc_offsets;     // [10]
const bitalloc_12_vlc_bits = T.bitalloc_12_vlc_bits;    // [5]
const src = reshape(T.ff_dca_vlc_src_tables, 2);        // [N][2] = [symbol, length]
// reshape maxbits using group_size row lengths
const maxbits = []; { let k = 0; for (let i = 0; i < 10; i++) { maxbits.push(T.bitalloc_maxbits.slice(k, k + group_size[i])); k += group_size[i]; } }

// Build a VLC from [symbol,length] entries (FFmpeg canonical, MSB-first,
// VLC_INIT_STATIC_OVERLONG). `offset` is added to each decoded symbol.
function buildVLC(entries, offset) {
    let code = 0; const byLen = []; let maxlen = 0;
    const P = Math.pow;
    for (const [sym, len] of entries) {
        const codeval = Math.floor(code / P(2, 32 - len));
        if (!byLen[len]) byLen[len] = new Map();
        byLen[len].set(codeval, sym + offset);
        code += P(2, 32 - len);
        if (len > maxlen) maxlen = len;
    }
    return { byLen, maxlen };
}
function getVLC(gb, vlc) {
    let acc = 0, len = 0;
    while (len < vlc.maxlen) {
        acc = acc * 2 + gb.bit(); len++;
        const m = vlc.byLen[len];
        if (m !== undefined) { const s = m.get(acc); if (s !== undefined) return s; }
    }
    throw new Error("VLC decode fail (overran maxlen " + vlc.maxlen + ")");
}

// Build all core VLCs in FFmpeg's exact consumption order.
let p = 0; const take = (n) => { const g = src.slice(p, p + n); p += n; return g; };
const vlc_quant_index = [];
for (let i = 0; i < 10; i++) { vlc_quant_index[i] = []; for (let j = 0; j < group_size[i]; j++) vlc_quant_index[i][j] = buildVLC(take(bitalloc_sizes[i]), bitalloc_offsets[i]); }
const vlc_bit_allocation = []; for (let i = 0; i < 5; i++) vlc_bit_allocation[i] = buildVLC(take(12), 1);
const vlc_scale_factor = []; for (let i = 0; i < 5; i++) vlc_scale_factor[i] = buildVLC(take(129), -64);
const vlc_transition_mode = []; for (let i = 0; i < 4; i++) vlc_transition_mode[i] = buildVLC(take(4), 0);

module.exports = {
    getVLC,
    vlc_quant_index, vlc_bit_allocation, vlc_scale_factor, vlc_transition_mode,
    quant_index_sel_nbits: T.ff_dca_quant_index_sel_nbits,
    quant_index_group_size: group_size,
    scale_factor_adj: T.ff_dca_scale_factor_adj,
    quant_levels: T.ff_dca_quant_levels,
    lossy_quant: T.ff_dca_lossy_quant,
    lossless_quant: T.ff_dca_lossless_quant,
    scale_factor_quant6: T.ff_dca_scale_factor_quant6,
    scale_factor_quant7: T.ff_dca_scale_factor_quant7,
    joint_scale_factors: T.ff_dca_joint_scale_factors,
    high_freq_vq: reshape(T.ff_dca_high_freq_vq, 32),
    adpcm_vb: reshape(T.ff_dca_adpcm_vb, 4),
    fir_perfect: T.ff_dca_fir_32bands_perfect_fixed,
    fir_nonperfect: T.ff_dca_fir_32bands_nonperfect_fixed,
    block_code_nbits: [7, 10, 12, 13, 15, 17, 19],
    lfe_fir_64: T.ff_dca_lfe_fir_64_fixed,
    lfe_fir_64_float: T.ff_dca_lfe_fir_64_float,
    lfe_fir_128_float: T.ff_dca_lfe_fir_128_float,
};
