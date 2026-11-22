import argparse
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

import numpy as np

import extract
import mkv
import worker

VIDEO_EXTENSIONS = (".mkv",)
HEADER_PROBE_THREADS = 16
VERIFY_EDGE_SECONDS = 0.05
DEFAULT_READ_GAP_BYTES = 256
DIAGNOSE_THRESHOLD = 1e-3
DISK_STREAM_COUNTS = [1, 4, 16, 32]
DISK_READ_CHUNK = 4 * 1024 * 1024


def walk_videos(root, limit):
    found = []
    if os.path.isfile(root):
        return [root]
    for folder, _dirs, names in os.walk(root):
        for name in names:
            if name.lower().endswith(VIDEO_EXTENSIONS):
                found.append(os.path.join(folder, name))
                if limit and len(found) >= limit:
                    return found
    return found


def probe(path):
    try:
        info = mkv.parse_header(path)
        track = mkv.pick_audio_track(info)
        return path, info, track, None
    except Exception as err:
        return path, None, None, err


def select_aac(paths):
    chosen = []
    with ThreadPoolExecutor(max_workers=HEADER_PROBE_THREADS) as pool:
        for path, info, track, err in pool.map(probe, paths):
            if err is not None or track is None:
                continue
            if track.codec_id.startswith(extract.AAC_CODEC_PREFIX):
                chosen.append(path)
    return chosen


def describe(path):
    info = mkv.parse_header(path)
    track = mkv.pick_audio_track(info)
    config = mkv.parse_aac_config(track)
    return info, track, config


def compare(fast, reference):
    n = min(len(fast), len(reference))
    edge = int(VERIFY_EDGE_SECONDS * extract.OUTPUT_SAMPLE_RATE)
    if n <= 2 * edge:
        return {"length_diff": len(fast) - len(reference), "max_diff": float("nan"), "rms_diff": float("nan"), "rms_reference": float("nan")}
    a = fast[edge:n - edge].astype(np.float64)
    b = reference[edge:n - edge].astype(np.float64)
    diff = a - b
    worst = int(np.argmax(np.abs(diff)))
    return {
        "length_diff": len(fast) - len(reference),
        "max_diff": float(np.max(np.abs(diff))),
        "max_diff_at_seconds": (worst + edge) / extract.OUTPUT_SAMPLE_RATE,
        "rms_diff": float(np.sqrt(np.mean(diff * diff))),
        "rms_reference": float(np.sqrt(np.mean(b * b))),
    }


def run_fast(path, pool, args):
    result = extract.extract_fast(path, pool, args.tasks or args.workers, args.read_chunk, args.access, args.io_streams)
    stats = result.task_stats
    summary = {
        "seconds": result.seconds,
        "header_seconds": result.header_seconds,
        "audio_seconds": result.audio_seconds,
        "read_bytes": sum(s["read_bytes"] for s in stats),
        "read_calls": sum(s["read_calls"] for s in stats),
        "payload_bytes": sum(s["payload_bytes"] for s in stats),
        "frames": sum(s["frames"] for s in stats),
        "slowest_task": max(s["seconds"] for s in stats),
        "slowest_scan": max(s.get("scan_seconds", 0.0) for s in stats),
    }
    return result, summary


def run_walk_only(path, pool, args, want_spans):
    started = time.perf_counter()
    plan = extract.make_plan(path, args.tasks or args.workers)
    tasks = []
    for i, (range_start, range_end) in enumerate(plan.ranges):
        tasks.append({
            "index": i,
            "path": path,
            "file_size": plan.info.file_size,
            "start": range_start,
            "end": range_end,
            "track_number": plan.track.number,
            "read_chunk": args.read_chunk,
            "access": args.access,
            "want_spans": want_spans,
        })
    stats = list(pool.map(worker.run_scan_task, tasks))
    seconds = time.perf_counter() - started
    spans = []
    for stat in stats:
        spans.extend(stat["spans"])
    return plan, stats, spans, seconds


def coalesce(spans, gap):
    ranges = []
    start = None
    end = None
    for span in spans:
        offset = span[0]
        size = span[1]
        if start is not None and offset - end <= gap:
            end = offset + size
            continue
        if start is not None:
            ranges.append((start, end))
        start = offset
        end = offset + size
    if start is not None:
        ranges.append((start, end))
    return ranges


def run_ideal(pool, args, plan, spans):
    started = time.perf_counter()
    task_count = args.tasks or args.workers
    postroll = worker.postroll_frame_count(plan.config)
    per_group = (len(spans) + task_count - 1) // task_count
    starts = []
    for nominal in range(0, len(spans), per_group):
        at = nominal
        while at < len(spans) and spans[at][3] != 0:
            at += 1
        if at < len(spans) and (not starts or at > starts[-1]):
            starts.append(at)
    shm_samples = extract.estimate_samples(plan)
    shm = extract.shared_memory.SharedMemory(create=True, size=shm_samples * extract.OUTPUT_BYTES_PER_SAMPLE)
    try:
        tasks = []
        for i, group_start in enumerate(starts):
            group_end = starts[i + 1] if i + 1 < len(starts) else len(spans)
            own = spans[group_start:group_end]
            after = spans[group_end:group_end + postroll]
            task = extract.range_task(plan, 0, shm.name, shm_samples, args.read_chunk, args.access)
            task.update({
                "index": i,
                "is_first": i == 0,
                "own_count": len(own),
                "spans": [(span[0], span[1]) for span in own + after],
                "ranges": coalesce(own + after, args.read_gap),
                "first_timestamp": own[0][2],
                "next_timestamp": after[0][2] if after else None,
            })
            tasks.append(task)
        plan_seconds = time.perf_counter() - started
        stats = list(pool.map(worker.run_known_spans_task, tasks))
        result = extract.finish(plan, shm, stats, "ideal", started, plan_seconds)
        return result, stats
    except BaseException:
        shm.close()
        shm.unlink()
        raise


def run_disk(path, pool, args, size):
    for streams in DISK_STREAM_COUNTS:
        if streams > args.workers:
            continue
        tasks = []
        for i in range(streams):
            tasks.append({"path": path, "access": args.access, "start": size * i // streams, "end": size * (i + 1) // streams, "read_chunk": DISK_READ_CHUNK})
        started = time.perf_counter()
        stats = list(pool.map(worker.run_raw_read_task, tasks))
        seconds = time.perf_counter() - started
        total = sum(s["bytes"] for s in stats)
        print(f"    raw read of the whole file, {streams} parallel stream(s), {DISK_READ_CHUNK // (1024 * 1024)} MB reads, access {args.access}: {seconds:.2f}s = {total / seconds / 1e6:.0f} MB/s", flush=True)


def megabytes(n):
    return f"{n / 1e6:.1f} MB"


def bench_file(path, pool, args):
    info, track, config = describe(path)
    size = info.file_size
    print(f"\n=== {os.path.basename(path)}", flush=True)
    print(f"    {megabytes(size)}, {info.duration_seconds or 0:.0f}s, AAC {config.output_sample_rate} Hz {track.channels}ch, {len(info.cluster_positions)} indexed clusters", flush=True)

    modes = args.modes
    reference = None
    if "disk" in modes:
        run_disk(path, pool, args, size)

    def get_reference(plan):
        nonlocal reference
        if reference is None:
            reference = extract.extract_ffmpeg(path, skip_seconds=float(plan.delay))
            print(f"    ffmpeg whole file: {reference.seconds:.3f}s = {reference.audio_seconds / reference.seconds:.0f}x realtime", flush=True)
        return reference

    def report_check(label, pcm, plan, stats=None):
        reference_pcm = get_reference(plan).pcm
        check = compare(pcm[plan.base_offset:], reference_pcm)
        print(f"    {label} vs ffmpeg: length {check['length_diff']:+d} samples, max sample difference {check['max_diff']:.2e} at {check.get('max_diff_at_seconds', 0):.3f}s, rms difference {check['rms_diff']:.2e} (signal rms {check['rms_reference']:.2e})", flush=True)
        if args.diagnose and stats:
            n = min(len(pcm) - plan.base_offset, len(reference_pcm))
            diff = np.abs(pcm[plan.base_offset:plan.base_offset + n].astype(np.float64) - reference_pcm[:n])
            for stat in sorted(stats, key=lambda s: s["index"]):
                start = stat["array_index"] - plan.base_offset
                end = min(n, start + stat["samples"])
                if end <= start:
                    continue
                piece = diff[start:end]
                bad = np.flatnonzero(piece > DIAGNOSE_THRESHOLD)
                where = "none" if len(bad) == 0 else f"{len(bad)} samples, first at +{bad[0]} last at +{bad[-1]} of {len(piece)}"
                print(f"      range {stat['index']}: starts at sample {start} (frame {stat.get('first_index')}, {stat['frames']} frames), max difference {piece.max():.2e}, above {DIAGNOSE_THRESHOLD}: {where}", flush=True)

    if "fast" in modes:
        for run in range(args.repeat):
            result, summary = run_fast(path, pool, args)
            stats = result.task_stats
            label = "fast, first run" if run == 0 and args.repeat > 1 else "fast"
            print(f"    {label}: {summary['seconds']:.3f}s wall = {summary['audio_seconds'] / summary['seconds']:.0f}x realtime; header {summary['header_seconds'] * 1000:.0f}ms; per range: container walk max {summary['slowest_scan']:.3f}s / sum {sum(s['scan_seconds'] for s in stats):.3f}s, decode max {max(s['decode_seconds'] for s in stats):.3f}s / sum {sum(s['decode_seconds'] for s in stats):.3f}s; read {megabytes(summary['read_bytes'])} in {summary['read_calls']} reads = {summary['read_bytes'] / size * 100:.1f}% of the file; audio payload {megabytes(summary['payload_bytes'])}, {summary['frames']} frames", flush=True)
            if run == args.repeat - 1 and "ffmpeg" in modes:
                report_check("fast", result.pcm, extract.make_plan(path, 1), stats)
            result.close()
    elif "ffmpeg" in modes:
        get_reference(extract.make_plan(path, 1))

    if "walk" in modes or "ideal" in modes:
        for run in range(args.repeat if "walk" in modes else 1):
            plan, stats, spans, seconds = run_walk_only(path, pool, args, "ideal" in modes)
            read_bytes = sum(s["read_bytes"] for s in stats)
            read_calls = sum(s["read_calls"] for s in stats)
            print(f"    container walk only (no decode): {seconds:.3f}s wall; per range max {max(s['seconds'] for s in stats):.3f}s / sum {sum(s['seconds'] for s in stats):.3f}s; read {megabytes(read_bytes)} in {read_calls} reads", flush=True)
        if "ideal" in modes:
            for run in range(args.repeat):
                result, stats = run_ideal(pool, args, plan, spans)
                read_bytes = sum(s["read_bytes"] for s in stats)
                read_sum = sum(s["read_seconds"] for s in stats)
                print(f"    ideal (exact byte ranges known ahead of time): {result.seconds:.3f}s wall = {result.audio_seconds / result.seconds:.0f}x realtime; per range: read max {max(s['read_seconds'] for s in stats):.3f}s / sum {read_sum:.3f}s ({megabytes(read_bytes)} in {sum(s['read_calls'] for s in stats)} reads), slice frames sum {sum(s['slice_seconds'] for s in stats):.3f}s, decode max {max(s['decode_seconds'] for s in stats):.3f}s / sum {sum(s['decode_seconds'] for s in stats):.3f}s", flush=True)
                if run == args.repeat - 1 and "ffmpeg" in modes:
                    report_check("ideal", result.pcm, plan)
                result.close()


def main():
    parser = argparse.ArgumentParser(description="Benchmark audio extraction on MKV/AAC files.")
    parser.add_argument("inputs", nargs="+", help="files or folders")
    parser.add_argument("--workers", type=int, default=extract.DEFAULT_WORKERS)
    parser.add_argument("--tasks", type=int, default=0, help="byte ranges per file (default: one per worker)")
    parser.add_argument("--read-chunk", type=int, nargs="+", default=None, help="override the preset: bytes per read while walking the container; several values run the benchmark once per value")
    parser.add_argument("--read-gap", type=int, default=DEFAULT_READ_GAP_BYTES, help="ideal mode: merge audio byte ranges closer than this")
    extract.add_storage_arguments(parser)
    parser.add_argument("--modes", nargs="+", default=["fast", "ffmpeg", "walk", "ideal"], choices=["fast", "ffmpeg", "walk", "ideal", "disk"])
    parser.add_argument("--repeat", type=int, default=2, help="runs of each timed mode; the first run of a file is the cold-cache one")
    parser.add_argument("--diagnose", action="store_true", help="when checking against ffmpeg, list where each range differs")
    parser.add_argument("--limit", type=int, default=0, help="stop after this many AAC files")
    parser.add_argument("--skip", type=int, default=0, help="skip this many AAC files first")
    parser.add_argument("--walk-limit", type=int, default=0, help="stop looking for files after this many .mkv files")
    args = parser.parse_args()
    preset = extract.resolve_storage(args)
    if args.read_chunk is None:
        args.read_chunk = [preset["read_chunk"]]

    paths = []
    for root in args.inputs:
        paths.extend(walk_videos(root, args.walk_limit))
    chosen = select_aac(paths)
    print(f"{len(paths)} .mkv files, {len(chosen)} with an AAC default audio track", flush=True)
    chosen = chosen[args.skip:]
    if args.limit:
        chosen = chosen[:args.limit]

    read_chunks = args.read_chunk
    pool_started = time.perf_counter()
    pool = extract.make_pool(args.workers, args.io_streams)
    print(f"started {args.workers} worker processes in {time.perf_counter() - pool_started:.2f}s; storage preset {args.storage}: read chunk {read_chunks} bytes, concurrent readers {args.io_streams or 'unlimited'}, access {args.access}", flush=True)
    try:
        for path in chosen:
            for read_chunk in read_chunks:
                args.read_chunk = read_chunk
                if len(read_chunks) > 1:
                    print(f"\n--- read chunk {read_chunk} bytes", flush=True)
                try:
                    bench_file(path, pool, args)
                except Exception:
                    print(f"    FAILED {path}: {traceback.format_exc()}", flush=True)
    finally:
        pool.shutdown()


if __name__ == "__main__":
    sys.exit(main())
