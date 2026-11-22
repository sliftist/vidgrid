import math
import subprocess
import time
from fractions import Fraction
from multiprocessing import shared_memory

import av
import numpy as np

import mkv

OUTPUT_SAMPLE_RATE = 16000
OUTPUT_BYTES_PER_SAMPLE = 4
GRID_ALIGN_SAMPLES = 640
OWNERSHIP_DELAY_SAMPLES = 640
RESAMPLER_MARGIN_SECONDS = Fraction(5, 1000)
DECODE_BATCH_FRAMES = 16
DECODE_BATCH_BYTES = 128 * 1024
WARM_UP_SECONDS = 0.3
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def aligned_start_index(first_frame_index, grid_origin, config):
    duration = mkv.frame_duration(config)
    earliest = first_frame_index * duration + duration + RESAMPLER_MARGIN_SECONDS
    return max(0, math.ceil((earliest - grid_origin) * OUTPUT_SAMPLE_RATE / GRID_ALIGN_SAMPLES) * GRID_ALIGN_SAMPLES)


def postroll_frame_count(config):
    duration = mkv.frame_duration(config)
    cover = duration + 2 * RESAMPLER_MARGIN_SECONDS + Fraction(GRID_ALIGN_SAMPLES + OWNERSHIP_DELAY_SAMPLES, OUTPUT_SAMPLE_RATE)
    return math.ceil(cover / duration) + 1


def plan_range(first_frame_index, frame_count, next_frame_index, is_first, grid_origin, config):
    duration = mkv.frame_duration(config)
    local_zero = first_frame_index * duration
    if is_first:
        aligned = 0
        owned_start = 0
        local_start = max(Fraction(0), grid_origin - local_zero)
    else:
        aligned = aligned_start_index(first_frame_index, grid_origin, config)
        owned_start = aligned + OWNERSHIP_DELAY_SAMPLES
        local_start = grid_origin + Fraction(aligned, OUTPUT_SAMPLE_RATE) - local_zero
    contiguous = next_frame_index is not None and next_frame_index == first_frame_index + frame_count
    if next_frame_index is None:
        owned_end = None
    elif contiguous:
        owned_end = aligned_start_index(next_frame_index, grid_origin, config) + OWNERSHIP_DELAY_SAMPLES
    else:
        owned_end = max(0, math.ceil(((first_frame_index + frame_count) * duration - grid_origin) * OUTPUT_SAMPLE_RATE))
    return {"aligned": aligned, "owned_start": owned_start, "owned_end": owned_end, "local_start": local_start, "contiguous": contiguous}


def audio_specific_config(track, config):
    if len(track.codec_private) >= 2:
        return track.codec_private
    value = ((config.profile + 1) << 11) | (config.sample_rate_index << 7) | (config.channel_config << 3)
    return value.to_bytes(2, "big")


def decode_to_pcm(frames, extradata, local_start):
    context = av.CodecContext.create("aac", "r")
    context.extradata = extradata
    context.thread_count = 1
    fifo = av.AudioFifo()
    resampler = av.AudioResampler(format="flt", layout="mono", rate=OUTPUT_SAMPLE_RATE)
    state = {"downmix": None, "skip": None, "frames": 0}
    outputs = []

    def drain():
        if state["skip"]:
            drop = min(state["skip"], fifo.samples)
            if drop:
                fifo.read(drop)
                state["skip"] -= drop
        block = fifo.read()
        state["frames"] = 0
        if block is None:
            return
        for mono in state["downmix"].resample(block):
            for resampled in resampler.resample(mono):
                outputs.append(resampled.to_ndarray().reshape(-1).copy())

    packet_type = av.Packet
    decode = context.decode
    write = fifo.write
    batch_frames = DECODE_BATCH_FRAMES
    for data in frames:
        for frame in decode(packet_type(data)):
            if state["downmix"] is None:
                state["downmix"] = av.AudioResampler(format="fltp", layout="mono", rate=frame.sample_rate)
                state["skip"] = round(local_start * frame.sample_rate)
                frame_bytes = frame.samples * frame.layout.nb_channels * OUTPUT_BYTES_PER_SAMPLE
                batch_frames = max(1, DECODE_BATCH_BYTES // max(1, frame_bytes))
            frame.pts = None
            write(frame)
            state["frames"] += 1
        if state["frames"] >= batch_frames:
            drain()
    for frame in decode(None):
        frame.pts = None
        write(frame)
    if state["downmix"] is None:
        return np.zeros(0, dtype=np.float32)
    drain()
    for mono in state["downmix"].resample(None):
        for resampled in resampler.resample(mono):
            outputs.append(resampled.to_ndarray().reshape(-1).copy())
    for resampled in resampler.resample(None):
        outputs.append(resampled.to_ndarray().reshape(-1).copy())
    if not outputs:
        return np.zeros(0, dtype=np.float32)
    return outputs[0] if len(outputs) == 1 else np.concatenate(outputs)


def write_pcm(shm_name, shm_samples, array_index, pcm):
    count = min(len(pcm), shm_samples - array_index)
    if count <= 0:
        return 0
    shm = shared_memory.SharedMemory(name=shm_name)
    try:
        target = np.frombuffer(shm.buf, dtype=np.float32, count=shm_samples)
        target[array_index:array_index + count] = pcm[:count]
        del target
    finally:
        shm.close()
    return count


class NoGate:
    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


IO_GATES = []


def init_worker(gates):
    global IO_GATES
    IO_GATES = list(gates or [])


def io_gate(task):
    if not IO_GATES:
        return NoGate()
    return IO_GATES[task.get("lane", 0) % len(IO_GATES)]


def warm_up(_index):
    time.sleep(WARM_UP_SECONDS)
    return True


def decode_and_store(task, frames, first_timestamp, next_timestamp, stats):
    config = task["config"]
    scale = task["timestamp_scale_ns"]
    first_index = mkv.timestamp_to_frame_index(first_timestamp, scale, config)
    next_index = None if next_timestamp is None else mkv.timestamp_to_frame_index(next_timestamp, scale, config)
    own_count = stats["frames"]
    plan = plan_range(first_index, own_count, next_index, task["is_first"], task["grid_origin"], config)
    if next_index is not None and not plan["contiguous"]:
        frames = frames[:own_count]
        stats["gap_frames"] = next_index - (first_index + own_count)
    if task["stripped_header"]:
        stripped = task["stripped_header"]
        frames = [stripped + frame for frame in frames]
    decode_started = time.perf_counter()
    pcm = decode_to_pcm(frames, task["extradata"], plan["local_start"])
    stats["decode_seconds"] = time.perf_counter() - decode_started
    skip = plan["owned_start"] - plan["aligned"]
    end = None if plan["owned_end"] is None else plan["owned_end"] - plan["aligned"]
    owned = pcm[skip:end]
    array_index = task["base_offset"] + plan["owned_start"]
    stats["first_index"] = first_index
    stats["array_index"] = array_index
    stats["samples"] = write_pcm(task["shm_name"], task["shm_samples"], array_index, owned)


def run_range_task(task):
    started = time.perf_counter()
    config = task["config"]
    stats = {"index": task["index"], "read_calls": 0, "read_bytes": 0, "payload_bytes": 0, "frames": 0, "samples": 0, "array_index": 0, "scan_seconds": 0.0, "decode_seconds": 0.0, "gap_frames": 0}
    frames = []
    next_timestamp = None
    with io_gate(task), mkv.open_for_read(task["path"], task["access"]) as f:
        stats["gate_wait_seconds"] = time.perf_counter() - started
        scanned = mkv.scan_audio(f, task["start"], task["end"], task["file_size"], task["track_number"], task["read_chunk"], 0, lambda batch, _ts: frames.extend(batch))
        stats["read_calls"] += scanned.read_calls
        stats["read_bytes"] += scanned.read_bytes
        stats["payload_bytes"] = scanned.payload_bytes
        stats["frames"] = scanned.frame_count
        if scanned.frame_count and task["post_end"] is not None:
            after = mkv.scan_audio(f, task["end"], task["post_end"], task["file_size"], task["track_number"], task["read_chunk"], postroll_frame_count(config), lambda batch, _ts: frames.extend(batch))
            stats["read_calls"] += after.read_calls
            stats["read_bytes"] += after.read_bytes
            next_timestamp = after.first_timestamp
    stats["scan_seconds"] = time.perf_counter() - started - stats["gate_wait_seconds"]
    if scanned.frame_count:
        decode_and_store(task, frames, scanned.first_timestamp, next_timestamp, stats)
    stats["seconds"] = time.perf_counter() - started
    return stats


def run_scan_task(task):
    spans = []
    with io_gate(task), mkv.open_for_read(task["path"], task["access"]) as f:
        started = time.perf_counter()
        scanned = mkv.scan_audio(f, task["start"], task["end"], task["file_size"], task["track_number"], task["read_chunk"], 0, lambda batch, _ts: None, spans.extend if task["want_spans"] else None)
    return {
        "index": task["index"],
        "frames": scanned.frame_count,
        "read_calls": scanned.read_calls,
        "read_bytes": scanned.read_bytes,
        "payload_bytes": scanned.payload_bytes,
        "first_timestamp": scanned.first_timestamp,
        "spans": spans,
        "seconds": time.perf_counter() - started,
    }


def run_raw_read_task(task):
    total = 0
    with mkv.open_for_read(task["path"], task["access"]) as f:
        started = time.perf_counter()
        pos = task["start"]
        while pos < task["end"]:
            f.seek(pos)
            got = len(f.read(min(task["read_chunk"], task["end"] - pos)))
            if got == 0:
                break
            total += got
            pos += got
    return {"bytes": total, "seconds": time.perf_counter() - started}


def run_frames_task(task):
    started = time.perf_counter()
    stats = {"index": task["index"], "read_calls": 0, "read_bytes": 0, "frames": task["own_count"], "samples": 0, "array_index": 0, "decode_seconds": 0.0, "gap_frames": 0}
    decode_and_store(task, task["frames"], task["first_timestamp"], task["next_timestamp"], stats)
    stats["seconds"] = time.perf_counter() - started
    return stats


def run_known_spans_task(task):
    started = time.perf_counter()
    stats = {"index": task["index"], "read_calls": 0, "read_bytes": 0, "frames": task["own_count"], "samples": 0, "array_index": 0, "decode_seconds": 0.0, "gap_frames": 0}
    ranges = task["ranges"]
    blobs = []
    with io_gate(task), mkv.open_for_read(task["path"], task["access"]) as f:
        read_started = time.perf_counter()
        for range_start, range_end in ranges:
            f.seek(range_start)
            blobs.append(f.read(range_end - range_start))
        stats["read_seconds"] = time.perf_counter() - read_started
    stats["read_calls"] = len(ranges)
    stats["read_bytes"] = sum(range_end - range_start for range_start, range_end in ranges)
    slice_started = time.perf_counter()
    frames = []
    at = 0
    range_start, range_end = ranges[0]
    blob = blobs[0]
    for offset, size in task["spans"]:
        while offset >= range_end:
            at += 1
            range_start, range_end = ranges[at]
            blob = blobs[at]
        local = offset - range_start
        frames.append(blob[local:local + size])
    stats["slice_seconds"] = time.perf_counter() - slice_started
    decode_and_store(task, frames, task["first_timestamp"], task["next_timestamp"], stats)
    stats["seconds"] = time.perf_counter() - started
    return stats
