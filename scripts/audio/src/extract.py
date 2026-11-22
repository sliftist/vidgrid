import argparse
import bisect
import math
import multiprocessing
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from fractions import Fraction
from multiprocessing import shared_memory

import numpy as np

import mkv
import worker

OUTPUT_SAMPLE_RATE = worker.OUTPUT_SAMPLE_RATE
OUTPUT_BYTES_PER_SAMPLE = worker.OUTPUT_BYTES_PER_SAMPLE
DEFAULT_WORKERS = os.cpu_count() or 8
STORAGE_PRESETS = {
    "hdd": {"read_chunk": 4 * 1024 * 1024, "io_streams": 4, "access": "sequential"},
    "ssd": {"read_chunk": 1024 * 1024, "io_streams": 0, "access": "random"},
    "cached": {"read_chunk": 4096, "io_streams": 0, "access": "random"},
}
DEFAULT_STORAGE = "hdd"
DEFAULT_READ_CHUNK = STORAGE_PRESETS[DEFAULT_STORAGE]["read_chunk"]
DEFAULT_ACCESS = STORAGE_PRESETS[DEFAULT_STORAGE]["access"]
ACCESS_CHOICES = ["random", "sequential", "default", "direct"]
SHM_SLACK_SECONDS = 4
FIRST_FRAME_READ_CHUNK = 65536
TIMELINE_MISMATCH_WARN_SECONDS = 0.1
AAC_CODEC_PREFIX = "A_AAC"
MIN_ASSUMED_BYTES_PER_SECOND = 4000


class Unsupported(Exception):
    pass


@dataclass
class Plan:
    info: mkv.MkvInfo
    track: mkv.AudioTrack
    config: mkv.AacConfig
    first_frame_index: int
    grid_origin: Fraction
    delay: Fraction
    base_offset: int
    ranges: list[tuple[int, int]]


@dataclass
class Extraction:
    path: str
    pcm: np.ndarray
    shm: shared_memory.SharedMemory | None
    method: str
    seconds: float
    header_seconds: float = 0.0
    task_stats: list[dict] = field(default_factory=list)

    @property
    def audio_seconds(self):
        return len(self.pcm) / OUTPUT_SAMPLE_RATE

    def close(self):
        self.pcm = np.zeros(0, dtype=np.float32)
        if self.shm is not None:
            self.shm.close()
            self.shm.unlink()
            self.shm = None


def find_ffmpeg():
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError("ffmpeg was not found on PATH")
    return found


def make_pool(workers, io_streams=0):
    gates = [multiprocessing.Lock() for _ in range(io_streams)]
    pool = ProcessPoolExecutor(max_workers=workers, initializer=worker.init_worker, initargs=(gates,))
    list(pool.map(worker.warm_up, range(workers)))
    return pool


def split_ranges(info, task_count):
    positions = info.cluster_positions
    start = positions[0]
    end = info.segment_end
    boundaries = [start]
    for k in range(1, task_count):
        target = start + (end - start) * k // task_count
        at = bisect.bisect_left(positions, target)
        if at >= len(positions):
            continue
        candidate = positions[at]
        if candidate > boundaries[-1]:
            boundaries.append(candidate)
    ranges = []
    for i, boundary in enumerate(boundaries):
        range_end = boundaries[i + 1] if i + 1 < len(boundaries) else end
        ranges.append((boundary, range_end))
    return ranges


def resync_cluster_positions(info, task_count):
    positions = [info.first_cluster_pos]
    span = info.segment_end - info.first_cluster_pos
    with mkv.open_for_read(info.path, "random") as f:
        for k in range(1, task_count):
            target = info.first_cluster_pos + span * k // task_count
            found = mkv.find_cluster_near(f, target, info.segment_end)
            if found is not None and found > positions[-1]:
                positions.append(found)
    return positions


def make_plan(path, task_count):
    info = mkv.parse_header(path)
    track = mkv.pick_audio_track(info)
    if track is None:
        raise Unsupported("no audio track")
    if not track.codec_id.startswith(AAC_CODEC_PREFIX):
        raise Unsupported(f"audio codec {track.codec_id} is not AAC")
    if track.unsupported_encoding:
        raise Unsupported("audio track uses a content encoding other than header stripping")
    try:
        config = mkv.parse_aac_config(track)
    except mkv.MkvError as err:
        raise Unsupported(str(err)) from err
    if len(info.cluster_positions) < 2 and task_count > 1:
        resynced = resync_cluster_positions(info, task_count)
        print(f"[audio] {os.path.basename(path)}: no Cues index, found {len(resynced)} cluster starts by searching for the cluster marker at {task_count} evenly spaced offsets", flush=True)
        info.cluster_positions = resynced
    first = []
    with mkv.open_for_read(path, "random") as f:
        scanned = mkv.scan_audio(f, info.first_cluster_pos, info.segment_end, info.file_size, track.number, FIRST_FRAME_READ_CHUNK, 1, lambda frames, _ts: first.extend(frames))
    if scanned.first_timestamp is None:
        raise Unsupported("audio track has no frames")
    first_frame_index = mkv.timestamp_to_frame_index(scanned.first_timestamp, info.timestamp_scale_ns, config)
    duration = mkv.frame_duration(config)
    delay = Fraction(round(Fraction(track.codec_delay_ns, mkv.NS_PER_SECOND) * config.output_sample_rate), config.output_sample_rate)
    grid_origin = first_frame_index * duration + delay
    base_offset = max(0, round(first_frame_index * duration * OUTPUT_SAMPLE_RATE))
    ranges = split_ranges(info, task_count)
    return Plan(info=info, track=track, config=config, first_frame_index=first_frame_index, grid_origin=grid_origin, delay=delay, base_offset=base_offset, ranges=ranges)


def range_task(plan, index, shm_name, shm_samples, read_chunk, access):
    range_start, range_end = plan.ranges[index]
    is_last = index == len(plan.ranges) - 1
    return {
        "index": index,
        "path": plan.info.path,
        "file_size": plan.info.file_size,
        "start": range_start,
        "end": range_end,
        "post_end": None if is_last else plan.ranges[index + 1][1],
        "is_first": index == 0,
        "track_number": plan.track.number,
        "stripped_header": plan.track.stripped_header,
        "extradata": worker.audio_specific_config(plan.track, plan.config),
        "config": plan.config,
        "timestamp_scale_ns": plan.info.timestamp_scale_ns,
        "grid_origin": plan.grid_origin,
        "base_offset": plan.base_offset,
        "shm_name": shm_name,
        "shm_samples": shm_samples,
        "read_chunk": read_chunk,
        "access": access,
    }


def finish(plan, shm, stats, method, started, header_seconds):
    path = plan.info.path
    total = 0
    for stat in stats:
        if stat["samples"]:
            total = max(total, stat["array_index"] + stat["samples"])
    pcm = np.frombuffer(shm.buf, dtype=np.float32, count=total)
    gaps = [(stat["index"], stat["gap_frames"]) for stat in stats if stat["gap_frames"]]
    if gaps:
        print(f"[audio] {os.path.basename(path)}: the audio timestamps are not continuous at {len(gaps)} of {len(stats)} range boundaries (range index, frames missing or overlapping): {gaps}; those ranges were decoded without overlap into their neighbour", flush=True)
    frames = sum(stat["frames"] for stat in stats)
    decoded_seconds = float(frames * mkv.frame_duration(plan.config))
    timeline_seconds = (total - plan.base_offset) / OUTPUT_SAMPLE_RATE + float(plan.delay)
    if abs(decoded_seconds - timeline_seconds) > TIMELINE_MISMATCH_WARN_SECONDS:
        print(f"[audio] {os.path.basename(path)}: decoded {frames} AAC frames = {decoded_seconds:.3f}s of audio, but the block timestamps place it across {timeline_seconds:.3f}s; the track has gaps or overlaps of {timeline_seconds - decoded_seconds:+.3f}s in total", flush=True)
    return Extraction(path=path, pcm=pcm, shm=shm, method=method, seconds=time.perf_counter() - started, header_seconds=header_seconds, task_stats=stats)


def estimate_samples(plan):
    info = plan.info
    if info.duration_seconds:
        seconds = info.duration_seconds
    else:
        seconds = (info.segment_end - info.first_cluster_pos) / MIN_ASSUMED_BYTES_PER_SECOND
        print(f"[audio] {os.path.basename(info.path)}: no Duration in the file header, reserving room for {seconds:.0f}s of audio from the file size", flush=True)
    return int(math.ceil((seconds + SHM_SLACK_SECONDS) * OUTPUT_SAMPLE_RATE))


def spread_order(count, io_streams):
    if io_streams <= 0 or io_streams >= count:
        return list(range(count))
    stride = -(-count // io_streams)
    return [i for offset in range(stride) for i in range(offset, count, stride)]


def extract_fast(path, pool, task_count, read_chunk=DEFAULT_READ_CHUNK, access=DEFAULT_ACCESS, io_streams=0):
    started = time.perf_counter()
    plan = make_plan(path, task_count)
    header_seconds = time.perf_counter() - started
    shm_samples = estimate_samples(plan)
    shm = shared_memory.SharedMemory(create=True, size=shm_samples * OUTPUT_BYTES_PER_SAMPLE)
    try:
        count = len(plan.ranges)
        tasks = [range_task(plan, i, shm.name, shm_samples, read_chunk, access) for i in spread_order(count, io_streams)]
        for task in tasks:
            task["lane"] = task["index"] * io_streams // count if io_streams > 0 else 0
        stats = list(pool.map(worker.run_range_task, tasks))
        return finish(plan, shm, stats, "fast", started, header_seconds)
    except BaseException:
        shm.close()
        shm.unlink()
        raise


def extract_ffmpeg(path, ffmpeg=None, skip_seconds=0.0):
    started = time.perf_counter()
    ffmpeg = ffmpeg or find_ffmpeg()
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-vn", "-sn", "-dn"]
    if skip_seconds > 0:
        command += ["-af", f"asetpts=N/SR/TB,atrim=start={skip_seconds:.9f}"]
    command += ["-ac", "1", "-ar", str(OUTPUT_SAMPLE_RATE), "-f", "f32le", "pipe:1"]
    done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=worker.CREATE_NO_WINDOW)
    if done.returncode != 0:
        raise RuntimeError(f"ffmpeg exited with code {done.returncode} on {path}: {done.stderr.decode('utf-8', 'replace')}")
    pcm = np.frombuffer(done.stdout, dtype=np.float32)
    return Extraction(path=path, pcm=pcm, shm=None, method="ffmpeg", seconds=time.perf_counter() - started)


def extract(path, pool, task_count, read_chunk=DEFAULT_READ_CHUNK, access=DEFAULT_ACCESS, io_streams=0):
    try:
        return extract_fast(path, pool, task_count, read_chunk, access, io_streams)
    except (Unsupported, mkv.MkvError) as err:
        print(f"[audio] {os.path.basename(path)}: fast path not usable ({err}), decoding the whole file with ffmpeg instead", flush=True)
        return extract_ffmpeg(path)


def add_storage_arguments(parser):
    parser.add_argument("--storage", choices=sorted(STORAGE_PRESETS), default=DEFAULT_STORAGE, help="how to read the file: hdd = whole file in 4 MB reads on 4 streams spread across the file; ssd = 1 MB reads on every worker; cached = 4 KB reads that skip over the video (fastest when the file is already in the OS cache)")
    parser.add_argument("--io-streams", type=int, default=None, help="override the preset: at most this many workers read the file at once (0 = no limit); decoding is never limited")
    parser.add_argument("--access", choices=ACCESS_CHOICES, default=None, help="override the preset: file open hint; direct bypasses the Windows file cache, so every run reads from the disk")


def resolve_storage(args):
    preset = STORAGE_PRESETS[args.storage]
    if args.io_streams is None:
        args.io_streams = preset["io_streams"]
    if args.access is None:
        args.access = preset["access"]
    return preset


def main():
    parser = argparse.ArgumentParser(description="Extract a video file's audio as 16 kHz mono float32 PCM.")
    parser.add_argument("input")
    parser.add_argument("--out", help="write raw f32le PCM here")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    parser.add_argument("--tasks", type=int, default=0, help="byte ranges to split the file into (default: one per worker)")
    parser.add_argument("--read-chunk", type=int, default=None, help="override the preset: bytes per read while walking the container")
    add_storage_arguments(parser)
    args = parser.parse_args()
    preset = resolve_storage(args)
    if args.read_chunk is None:
        args.read_chunk = preset["read_chunk"]
    pool = make_pool(args.workers, args.io_streams)
    try:
        result = extract(args.input, pool, args.tasks or args.workers, args.read_chunk, args.access, args.io_streams)
        print(f"{result.method}: {result.audio_seconds:.1f}s of audio in {result.seconds:.3f}s ({result.audio_seconds / result.seconds:.0f}x realtime)")
        if args.out:
            with open(args.out, "wb") as f:
                f.write(result.pcm.tobytes())
        result.close()
    finally:
        pool.shutdown()


if __name__ == "__main__":
    sys.exit(main())
