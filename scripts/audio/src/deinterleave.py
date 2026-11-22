import argparse
import os
import sys
import time

import av

COPIED_STREAM_TYPES = ("video", "audio", "subtitle")


def copy_packets(source_path, output, stream_map, want_audio):
    count = 0
    size = 0
    with av.open(source_path) as source:
        wanted = [stream for stream in source.streams if stream.index in stream_map and (stream.type == "audio") == want_audio]
        if not wanted:
            return count, size
        for packet in source.demux(wanted):
            if packet.dts is None:
                continue
            packet.stream = stream_map[packet.stream.index]
            count += 1
            size += packet.size
            output.mux(packet)
    return count, size


def main():
    parser = argparse.ArgumentParser(description="Rewrite a video so its audio is one contiguous run after all the video, instead of interleaved with it. Streams are copied, not re-encoded.")
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    if os.path.exists(args.output):
        print(f"[deinterleave] refusing to overwrite existing file {args.output}", flush=True)
        return 1
    started = time.perf_counter()
    with av.open(args.input) as source, av.open(args.output, "w", format="matroska") as output:
        stream_map = {}
        for stream in source.streams:
            if stream.type not in COPIED_STREAM_TYPES:
                print(f"[deinterleave] not copying stream {stream.index} of type {stream.type}", flush=True)
                continue
            stream_map[stream.index] = output.add_stream_from_template(stream)
        output.metadata.update(source.metadata)
        other_count, other_bytes = copy_packets(args.input, output, stream_map, False)
        print(f"[deinterleave] wrote {other_count} video and subtitle packets, {other_bytes / 1e6:.1f} MB, after {time.perf_counter() - started:.1f}s", flush=True)
        audio_count, audio_bytes = copy_packets(args.input, output, stream_map, True)
        print(f"[deinterleave] wrote {audio_count} audio packets, {audio_bytes / 1e6:.1f} MB, after {time.perf_counter() - started:.1f}s", flush=True)
    print(f"[deinterleave] {args.input} ({os.path.getsize(args.input) / 1e6:.1f} MB) -> {args.output} ({os.path.getsize(args.output) / 1e6:.1f} MB) in {time.perf_counter() - started:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
