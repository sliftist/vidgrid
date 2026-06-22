# libav-6.8.8.0-xvid.* — how this WASM was built

`libav-6.8.8.0-xvid.{js,wasm.js,wasm.wasm}` in this folder is a **custom libav.js
(ffmpeg) WebAssembly build** containing the MPEG-4 Part 2 family of video
decoders. The browser's WebCodecs cannot decode MPEG-4 Part 2 (XviD/DivX), so
`web/player/Mp4vDecoder.ts` runs this WASM to decode `mp4v` video in AVIs.

No published `@libav.js/variant-*` ships the `mpeg4` decoder, so this is a
hand-rolled variant. To rebuild or change which codecs are included:

## Toolchain
- **emscripten** 6.0.0 (`emsdk`): `git clone https://github.com/emscripten-core/emsdk && cd emsdk && ./emsdk install latest && ./emsdk activate latest && source ./emsdk_env.sh`
- **libav.js**: `git clone https://github.com/Yahweasel/libav.js` (built at commit `192bc3a`)
- **ffmpeg 8.0** — auto-downloaded by the libav.js build.

## Build steps
```sh
cd libav.js
# 1. Define the variant (the array below = exactly which ffmpeg components to include)
cd configs && node mkconfig.js xvid '["avformat","avcodec","avfilter","swresample","swscale","video-filters","parser-mpeg4video","parser-h263","parser-mpegaudio","demuxer-avi","demuxer-mp3","decoder-mpeg4","decoder-h263","decoder-h263p","decoder-msmpeg4v1","decoder-msmpeg4v2","decoder-msmpeg4v3","decoder-mpeg1video","decoder-mpeg2video","decoder-msvideo1","decoder-cinepak","decoder-mp3","decoder-mp2","bsf-extract_extradata"]' && cd ..
# 2. Build (single-threaded wasm variant is what we use)
source /path/to/emsdk/emsdk_env.sh
make build-xvid -j8
# 3. Copy the outputs here
cp dist/libav-6.8.8.0-xvid.js dist/libav-6.8.8.0-xvid.wasm.js dist/libav-6.8.8.0-xvid.wasm.wasm  <vidgrid>/assets/
```

The decoder list covers MPEG-4 ASP (`mpeg4`), H.263, MS-MPEG4 v1/2/3 (old
DivX), MPEG-1/2, MS Video 1, Cinepak, plus MP3/MP2 (for parity / a Node
cross-check). `demuxer-avi`/`demuxer-mp3` let libav also demux directly — handy
for debugging, though in the app mediabunny does the demuxing.

To add a codec: add its `decoder-<name>` component to the `mkconfig.js` array,
rebuild, recopy, and (if needed) map its fourcc/codec in the mediabunny fork's
AVI demuxer (`src/avi/avi-demuxer.ts`).
