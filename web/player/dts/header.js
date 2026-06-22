const { SAMPLE_RATES, BIT_RATES, CHANNELS, BITS_PER_SAMPLE } = require("./tables_hdr");
const DCA_SYNC = 0x7FFE8001;

// 5.3.1 Primary coding header / frame header. Returns header object.
function parseFrameHeader(gb) {
    if (gb.bits(32) !== DCA_SYNC) throw new Error("bad sync");
    const h = {};
    h.normal_frame = gb.bit();
    h.deficit_samples = gb.bits(5) + 1;        // must be 32
    h.crc_present = gb.bit();
    h.npcmblocks = gb.bits(7) + 1;             // multiple of 8
    h.frame_size = gb.bits(14) + 1;            // bytes
    h.audio_mode = gb.bits(6);
    h.sr_code = gb.bits(4);
    h.br_code = gb.bits(5);
    gb.bit();                                   // reserved
    h.drc_present = gb.bit();
    h.ts_present = gb.bit();
    h.aux_present = gb.bit();
    h.hdcd_master = gb.bit();
    h.ext_audio_type = gb.bits(3);
    h.ext_audio_present = gb.bit();
    h.sync_ssf = gb.bit();
    h.lfe_present = gb.bits(2);
    h.predictor_history = gb.bit();
    if (h.crc_present) gb.skip(16);
    h.filter_perfect = gb.bit();
    h.encoder_rev = gb.bits(4);
    h.copy_hist = gb.bits(2);
    h.pcmr_code = gb.bits(3);
    h.sumdiff_front = gb.bit();
    h.sumdiff_surround = gb.bit();
    h.dn_code = gb.bits(4);
    // derived
    h.sample_rate = SAMPLE_RATES[h.sr_code];
    h.bit_rate = BIT_RATES[h.br_code];
    h.nchannels = CHANNELS[h.audio_mode];
    h.source_pcm_res = BITS_PER_SAMPLE[h.pcmr_code];
    return h;
}
module.exports = { parseFrameHeader, DCA_SYNC };
