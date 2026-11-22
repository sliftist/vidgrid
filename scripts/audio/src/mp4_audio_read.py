import argparse
import os
import struct
import sys
import time

import overlapped

BOX_HEADER_BYTES = 16
MAX_READ_BYTES = 4 * 1024 * 1024
DEFAULT_QUEUE_DEPTH = 1024


def child_boxes(buf, start, end):
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from(">I4s", buf, pos)
        data_start = pos + 8
        if size == 1:
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            data_start = pos + 16
        elif size == 0:
            size = end - pos
        if size < 8 or pos + size > end:
            return
        yield kind, data_start, pos + size
        pos += size


def find_box(buf, start, end, *path):
    for wanted in path:
        found = None
        for kind, data_start, box_end in child_boxes(buf, start, end):
            if kind == wanted:
                found = (data_start, box_end)
                break
        if found is None:
            return None
        start, end = found
    return start, end


def read_moov(f, file_size):
    pos = 0
    reads = 0
    while pos + 8 <= file_size:
        f.seek(pos)
        head = f.read(BOX_HEADER_BYTES)
        reads += 1
        size, kind = struct.unpack_from(">I4s", head, 0)
        header = 8
        if size == 1:
            size = struct.unpack_from(">Q", head, 8)[0]
            header = 16
        elif size == 0:
            size = file_size - pos
        if kind == b"moov":
            f.seek(pos + header)
            return f.read(size - header), reads + 1
        pos += size
    raise ValueError("no moov box")


def audio_sample_ranges(moov):
    for kind, trak_start, trak_end in child_boxes(moov, 0, len(moov)):
        if kind != b"trak":
            continue
        hdlr = find_box(moov, trak_start, trak_end, b"mdia", b"hdlr")
        if hdlr is None or moov[hdlr[0] + 8:hdlr[0] + 12] != b"soun":
            continue
        stbl = find_box(moov, trak_start, trak_end, b"mdia", b"minf", b"stbl")
        stsz = find_box(moov, stbl[0], stbl[1], b"stsz")
        uniform, count = struct.unpack_from(">II", moov, stsz[0] + 4)
        sizes = [uniform] * count if uniform else list(struct.unpack_from(f">{count}I", moov, stsz[0] + 12))
        stco = find_box(moov, stbl[0], stbl[1], b"stco")
        if stco is not None:
            chunk_count = struct.unpack_from(">I", moov, stco[0] + 4)[0]
            chunk_offsets = struct.unpack_from(f">{chunk_count}I", moov, stco[0] + 8)
        else:
            co64 = find_box(moov, stbl[0], stbl[1], b"co64")
            chunk_count = struct.unpack_from(">I", moov, co64[0] + 4)[0]
            chunk_offsets = struct.unpack_from(f">{chunk_count}Q", moov, co64[0] + 8)
        stsc = find_box(moov, stbl[0], stbl[1], b"stsc")
        run_count = struct.unpack_from(">I", moov, stsc[0] + 4)[0]
        runs = [struct.unpack_from(">II", moov, stsc[0] + 8 + 12 * i) for i in range(run_count)]
        ranges = []
        sample = 0
        for i, (first_chunk, per_chunk) in enumerate(runs):
            last_chunk = runs[i + 1][0] if i + 1 < len(runs) else chunk_count + 1
            for chunk in range(first_chunk, last_chunk):
                chunk_size = sum(sizes[sample:sample + per_chunk])
                sample += per_chunk
                start = chunk_offsets[chunk - 1]
                if ranges and ranges[-1][1] == start and ranges[-1][1] - ranges[-1][0] < MAX_READ_BYTES:
                    ranges[-1] = (ranges[-1][0], start + chunk_size)
                else:
                    ranges.append((start, start + chunk_size))
        return ranges, count, chunk_count
    raise ValueError("no audio track")


def main():
    parser = argparse.ArgumentParser(description="Time reading only the audio bytes of an MP4, located from its sample tables, with the file cache bypassed.")
    parser.add_argument("input")
    parser.add_argument("--queue-depth", type=int, default=DEFAULT_QUEUE_DEPTH)
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()
    file_size = os.path.getsize(args.input)
    for _run in range(args.repeat):
        started = time.perf_counter()
        with open(args.input, "rb", buffering=0) as f:
            moov, index_reads = read_moov(f, file_size)
        index_seconds = time.perf_counter() - started
        ranges, sample_count, chunk_count = audio_sample_ranges(moov)
        parse_seconds = time.perf_counter() - started - index_seconds
        data, stats = overlapped.read_ranges(args.input, ranges, args.queue_depth)
        data.close()
        audio_bytes = sum(end - start for start, end in ranges)
        print(f"[mp4-audio-read] {os.path.basename(args.input)} ({file_size / 1e6:.1f} MB): index {len(moov) / 1e6:.1f} MB in {index_reads} reads {index_seconds:.3f}s (through the file cache), parse {parse_seconds:.3f}s; audio {audio_bytes / 1e6:.1f} MB = {sample_count} samples in {chunk_count} chunks, {len(ranges)} contiguous ranges spanning {ranges[0][0]}..{ranges[-1][1]}; read {stats['seconds']:.3f}s = {stats['read_bytes'] / stats['seconds'] / 1e6:.0f} MB/s, {stats['reads']} reads, peak in flight {stats['peak_in_flight']}, cache bypassed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
