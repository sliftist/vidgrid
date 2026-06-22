// Pure-JS DTS Coherent Acoustics (DCA) Core decoder, ported from FFmpeg's
// fixed-point decode path. Runs unchanged in the browser (typed arrays + Math
// only — no Node APIs). Verified bit-accurate vs ffmpeg across mono/stereo/5.1.
// Standalone source + tests live in /root/dca. See ./index.d.ts for the API.
module.exports = require("./dcacore");
