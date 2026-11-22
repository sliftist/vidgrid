import argparse
import sys
import time

import av
import numpy as np

import extract
import mkv
import worker

DEFAULT_MAX_FRAMES = 20000


def load_frames(path):
    plan = extract.make_plan(path, 1)
    frames = []
    with mkv.open_for_read(path, "sequential") as f:
        mkv.scan_audio(f, plan.info.first_cluster_pos, plan.info.segment_end, plan.info.file_size, plan.track.number, 1 << 20, 0, lambda batch, _ts: frames.extend(batch))
    return plan, frames


def timed(label, fn, audio_seconds):
    started = time.perf_counter()
    value = fn()
    seconds = time.perf_counter() - started
    print(f"{label}: {seconds:.3f}s = {audio_seconds / seconds:.0f}x realtime", flush=True)
    return value


def main():
    parser = argparse.ArgumentParser(description="Time each step of the in-process AAC decode on one file, single process.")
    parser.add_argument("input")
    parser.add_argument("--max-frames", type=int, default=DEFAULT_MAX_FRAMES, help="only time this many AAC frames, taken from the middle of the file")
    args = parser.parse_args()
    plan, frames = load_frames(args.input)
    if len(frames) > args.max_frames:
        middle = (len(frames) - args.max_frames) // 2
        frames = frames[middle:middle + args.max_frames]
    extradata = worker.audio_specific_config(plan.track, plan.config)
    audio_seconds = float(len(frames) * mkv.frame_duration(plan.config))
    print(f"{len(frames)} frames, {audio_seconds:.1f}s of audio, {sum(len(frame) for frame in frames) / 1e6:.1f} MB", flush=True)

    def make_context():
        context = av.CodecContext.create("aac", "r")
        context.extradata = extradata
        context.thread_count = 1
        return context

    def decode_only():
        context = make_context()
        count = 0
        for data in frames:
            for _frame in context.decode(av.Packet(data)):
                count += 1
        return count

    def decode_keep():
        context = make_context()
        kept = []
        for data in frames:
            kept.extend(context.decode(av.Packet(data)))
        return kept

    timed("packets only (no decode)", lambda: [av.Packet(data) for data in frames], audio_seconds)
    timed("decode, frames dropped", decode_only, audio_seconds)
    decoded = timed("decode, frames kept", decode_keep, audio_seconds)
    print(f"decoded frame: {decoded[0].format.name} {decoded[0].layout.name} {decoded[0].sample_rate} Hz {decoded[0].samples} samples", flush=True)
    arrays = timed("to_ndarray per frame", lambda: [frame.to_ndarray() for frame in decoded], audio_seconds)
    block = timed("concatenate", lambda: np.concatenate(arrays, axis=1), audio_seconds)

    def resample_per_frame():
        resampler = av.AudioResampler(format="flt", layout="mono", rate=worker.OUTPUT_SAMPLE_RATE)
        out = []
        for frame in decoded:
            out.extend(resampler.resample(frame))
        out.extend(resampler.resample(None))
        return out

    def resample_block():
        resampler = av.AudioResampler(format="flt", layout="mono", rate=worker.OUTPUT_SAMPLE_RATE)
        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(block), format=decoded[0].format.name, layout=decoded[0].layout.name)
        frame.sample_rate = decoded[0].sample_rate
        out = resampler.resample(frame)
        out.extend(resampler.resample(None))
        return out

    timed("resample, one call per decoded frame", resample_per_frame, audio_seconds)
    timed("resample, one big frame", resample_block, audio_seconds)
    def staged(stage, batch_frames):
        context = make_context()
        fifo = av.AudioFifo()
        downmix = None
        resampler = av.AudioResampler(format="flt", layout="mono", rate=worker.OUTPUT_SAMPLE_RATE)
        pending = 0
        total = 0
        for data in frames:
            for frame in context.decode(av.Packet(data)):
                if downmix is None:
                    downmix = av.AudioResampler(format="fltp", layout="mono", rate=frame.sample_rate)
                frame.pts = None
                fifo.write(frame)
                pending += 1
            if pending >= batch_frames:
                pending = 0
                if stage == "write":
                    fifo.read()
                    continue
                block = fifo.read()
                if stage == "read":
                    continue
                for mono in downmix.resample(block):
                    if stage == "downmix":
                        continue
                    for resampled in resampler.resample(mono):
                        if stage == "resample":
                            continue
                        total += resampled.to_ndarray().shape[1]
        return total

    for batch_frames in (8, 32, 128):
        for stage in ("read", "downmix", "resample", "ndarray"):
            timed(f"batch {batch_frames}: decode + fifo up to {stage}", lambda: staged(stage, batch_frames), audio_seconds)
    timed("worker.decode_to_pcm (whole pipeline)", lambda: worker.decode_to_pcm(frames, extradata, plan.delay), audio_seconds)


if __name__ == "__main__":
    sys.exit(main())
