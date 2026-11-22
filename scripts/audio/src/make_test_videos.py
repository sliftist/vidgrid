import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from extract import find_ffmpeg

DEFAULT_OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test-videos")
PARALLEL_ENCODES = 4
VIDEO_FRAME_RATE = 24

TEST_VIDEOS = [
    {"name": "stereo_48k_60s", "seconds": 60, "size": "640x360", "video_bitrate": "1M", "sample_rate": 48000, "channels": 2, "audio_bitrate": "128k"},
    {"name": "stereo_48k_20m_4mbps", "seconds": 1200, "size": "1280x720", "video_bitrate": "4M", "sample_rate": 48000, "channels": 2, "audio_bitrate": "160k"},
    {"name": "surround_48k_10m", "seconds": 600, "size": "1280x720", "video_bitrate": "3M", "sample_rate": 48000, "channels": 6, "audio_bitrate": "384k"},
    {"name": "stereo_44k_5m", "seconds": 300, "size": "640x360", "video_bitrate": "1M", "sample_rate": 44100, "channels": 2, "audio_bitrate": "128k"},
    {"name": "mono_22k_5m", "seconds": 300, "size": "640x360", "video_bitrate": "1M", "sample_rate": 22050, "channels": 1, "audio_bitrate": "48k"},
    {"name": "stereo_48k_90m_6mbps", "seconds": 5400, "size": "1920x1080", "video_bitrate": "6M", "sample_rate": 48000, "channels": 2, "audio_bitrate": "160k"},
]


def audio_source(spec):
    rate = spec["sample_rate"]
    seconds = spec["seconds"]
    voices = []
    for channel in range(spec["channels"]):
        base = 180 + 70 * channel
        voices.append(f"0.25*sin(2*PI*({base}+40*sin(2*PI*0.13*t))*t)*(0.6+0.4*sin(2*PI*{0.7 + 0.2 * channel}*t))+0.08*sin(2*PI*{900 + 150 * channel}*t)")
    return f"aevalsrc={'|'.join(voices)}:s={rate}:d={seconds}"


def build_command(ffmpeg, spec, out_path):
    video = f"testsrc2=s={spec['size']}:r={VIDEO_FRAME_RATE}:d={spec['seconds']},noise=alls=30:allf=t"
    return [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", video,
        "-f", "lavfi", "-i", audio_source(spec),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-b:v", spec["video_bitrate"], "-maxrate", spec["video_bitrate"], "-bufsize", spec["video_bitrate"],
        "-c:a", "aac", "-b:a", spec["audio_bitrate"], "-ar", str(spec["sample_rate"]), "-ac", str(spec["channels"]),
        "-shortest", out_path,
    ]


def make_one(ffmpeg, spec, out_dir, force):
    out_path = os.path.join(out_dir, spec["name"] + ".mkv")
    if os.path.exists(out_path) and not force:
        return f"{spec['name']}: already exists ({os.path.getsize(out_path) / 1e6:.0f} MB), kept"
    started = time.perf_counter()
    done = subprocess.run(build_command(ffmpeg, spec, out_path), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if done.returncode != 0:
        raise RuntimeError(f"ffmpeg failed making {spec['name']}: {done.stderr.decode('utf-8', 'replace')}")
    return f"{spec['name']}: {os.path.getsize(out_path) / 1e6:.0f} MB in {time.perf_counter() - started:.1f}s"


def main():
    parser = argparse.ArgumentParser(description="Generate MKV/AAC test videos with ffmpeg.")
    parser.add_argument("--out", default=DEFAULT_OUT_DIR)
    parser.add_argument("--force", action="store_true", help="re-encode files that already exist")
    parser.add_argument("--only", nargs="*", help="names of the test videos to make (default: all)")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    ffmpeg = find_ffmpeg()
    specs = [spec for spec in TEST_VIDEOS if not args.only or spec["name"] in args.only]
    with ThreadPoolExecutor(max_workers=PARALLEL_ENCODES) as pool:
        for line in pool.map(lambda spec: make_one(ffmpeg, spec, args.out, args.force), specs):
            print(line, flush=True)
    print(f"test videos are in {args.out}")


if __name__ == "__main__":
    sys.exit(main())
