from __future__ import annotations

import http.client
import json
import queue
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

AUDIO_SRC_DIR = Path(__file__).resolve().parent.parent.parent / "audio" / "src"
if str(AUDIO_SRC_DIR) not in sys.path:
    sys.path.append(str(AUDIO_SRC_DIR))

import extract as audio_extract

DEFAULT_FASTVOICE_URL = "http://127.0.0.1:6764"
DEFAULT_AUDIO_WORKERS = 8
SAMPLE_RATE = audio_extract.OUTPUT_SAMPLE_RATE
SEGMENT_SECONDS = 600
CONTEXT_SECONDS = 2
SEGMENT_SAMPLES = SEGMENT_SECONDS * SAMPLE_RATE
CONTEXT_SAMPLES = CONTEXT_SECONDS * SAMPLE_RATE
QUEUE_MAX_FILES = 2
STATUS_TIMEOUT_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 900
BUSY_POLL_MIN_SECONDS = 1.0
BUSY_POLL_MAX_SECONDS = 15.0
UNREACHABLE_RETRY_SECONDS = 30.0
WAIT_LOG_INTERVAL_SECONDS = 300.0
SERVER_ERROR_ATTEMPTS = 3
RESULT_NAME_FMT = "_transcript_result_{idx:06d}.json"
LOG_PREFIX = "[transcript]"
AUDIO_STORAGE = audio_extract.STORAGE_PRESETS[audio_extract.DEFAULT_STORAGE]


def log(text: str) -> None:
    stamp = time.strftime("%H:%M:%S")
    print(f"{LOG_PREFIX} {stamp} {text}", flush=True)


class ServerError(Exception):
    pass


class FastvoiceClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = ""
        self.waited_seconds = 0.0

    def _open(self, request: urllib.request.Request, timeout: float) -> dict:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            raise ServerError(f"fastvoice answered HTTP {err.code} for {request.full_url}: {detail}") from err

    def status_once(self) -> dict:
        return self._open(urllib.request.Request(f"{self.base_url}/status"), STATUS_TIMEOUT_SECONDS)

    def _retry_unreachable(self, action, what: str):
        first_failure = None
        last_log = 0.0
        while True:
            try:
                value = action()
                if first_failure is not None:
                    waited = time.monotonic() - first_failure
                    self.waited_seconds += waited
                    log(f"fastvoice at {self.base_url} is reachable again after {waited:.0f}s; continuing {what}")
                return value
            except (urllib.error.URLError, ConnectionError, TimeoutError, http.client.HTTPException) as err:
                now = time.monotonic()
                if first_failure is None:
                    first_failure = now
                if now - last_log >= WAIT_LOG_INTERVAL_SECONDS:
                    last_log = now
                    log(f"fastvoice at {self.base_url} is not reachable ({err!r}) while {what}; unreachable for {now - first_failure:.0f}s so far, retrying every {UNREACHABLE_RETRY_SECONDS:.0f}s")
                time.sleep(UNREACHABLE_RETRY_SECONDS)

    def wait_until_idle(self, what: str) -> None:
        started = time.monotonic()
        last_log = 0.0
        while True:
            status = self._retry_unreachable(self.status_once, what)
            if not status.get("busy"):
                waited = time.monotonic() - started
                self.waited_seconds += waited
                if last_log:
                    log(f"fastvoice is idle again after {waited:.0f}s; continuing {what}")
                return
            now = time.monotonic()
            if now - last_log >= WAIT_LOG_INTERVAL_SECONDS:
                last_log = now
                log(f"fastvoice is busy ({status.get('busyReason')}); waited {now - started:.0f}s so far before {what}")
            time.sleep(min(BUSY_POLL_MAX_SECONDS, max(BUSY_POLL_MIN_SECONDS, float(status.get("retryAfterSeconds") or 0))))

    def _post_segment(self, segment: np.ndarray, context: int, final: bool, what: str) -> dict:
        body = segment.astype("<f4", copy=False).tobytes()
        url = f"{self.base_url}/transcribe?context={context}&final={1 if final else 0}"
        attempts = 0
        while True:
            request = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/octet-stream"})
            try:
                return self._retry_unreachable(lambda: self._open(request, REQUEST_TIMEOUT_SECONDS), what)
            except ServerError:
                attempts += 1
                if attempts >= SERVER_ERROR_ATTEMPTS:
                    raise

    def transcribe(self, pcm: np.ndarray, what: str) -> dict:
        total = len(pcm)
        position = 0
        words: list[str] = []
        starts_ms: list[int] = []
        ends_ms: list[int] = []
        model_seconds = 0.0
        windows = 0
        while position < total:
            segment_start = max(0, position - CONTEXT_SAMPLES)
            segment_end = min(total, segment_start + SEGMENT_SAMPLES)
            final = segment_end == total
            response = self._post_segment(pcm[segment_start:segment_end], position - segment_start, final, what)
            offset_ms = segment_start * 1000.0 / SAMPLE_RATE
            for word in response["words"]:
                words.append(str(word["word"]))
                starts_ms.append(int(round(offset_ms + float(word["start"]) * 1000.0)))
                ends_ms.append(int(round(offset_ms + float(word["end"]) * 1000.0)))
            model_seconds += float(response.get("decodeSeconds") or 0)
            windows += int(response.get("windows") or 0)
            new_position = segment_start + int(response["completedSamples"])
            if response.get("busy"):
                position = max(position, new_position)
                self.wait_until_idle(what)
                continue
            if new_position <= position:
                raise RuntimeError(f"fastvoice made no progress at sample {position} of {total} (segment {segment_start}..{segment_end}, final={final}, completedSamples={response['completedSamples']})")
            position = new_position
        return {"words": words, "startsMs": starts_ms, "endsMs": ends_ms, "modelSeconds": model_seconds, "windows": windows}


class TranscriptPipeline:
    def __init__(self, server, video_root: Path, tmp_dir: Path, fastvoice_url: str, audio_workers: int) -> None:
        self.server = server
        self.video_root = video_root
        self.tmp_dir = tmp_dir
        self.client = FastvoiceClient(fastvoice_url)
        self.audio_workers = audio_workers
        self.enabled = False
        self.handled: set[str] = set()
        self.deferred = 0
        self.done = 0
        self.failed = 0
        self.no_audio = 0
        self.words = 0
        self.audio_seconds = 0.0
        self._slots = threading.BoundedSemaphore(QUEUE_MAX_FILES)
        self._queue: "queue.Queue" = queue.Queue()
        self._pool = None
        self._pool_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._result_index = 0
        self._thread: threading.Thread | None = None

    def start(self) -> bool:
        try:
            status = self.client.status_once()
        except Exception as err:
            log(f"TRANSCRIPTS DISABLED FOR THIS RUN: the fastvoice batch API at {self.client.base_url} did not answer ({err!r}). Start fastvoice (yarn voice in D:/repos/fastvoice) and run the parse again; files without a transcript are picked up then.")
            return False
        if int(status.get("sampleRate") or 0) != SAMPLE_RATE:
            log(f"TRANSCRIPTS DISABLED FOR THIS RUN: fastvoice at {self.client.base_url} expects {status.get('sampleRate')} Hz audio, this script produces {SAMPLE_RATE} Hz")
            return False
        self.client.model = str(status.get("model") or "")
        self.enabled = True
        self._thread = threading.Thread(target=self._transcriber_loop, daemon=True)
        self._thread.start()
        log(f"fastvoice batch API at {self.client.base_url}: model {self.client.model}, window {status.get('windowSeconds')}s, runs after {status.get('idleSeconds')}s without typing, currently {'busy: ' + str(status.get('busyReason')) if status.get('busy') else 'idle'}")
        return True

    def _audio_pool(self):
        with self._pool_lock:
            if self._pool is None:
                started = time.monotonic()
                self._pool = audio_extract.make_pool(self.audio_workers, AUDIO_STORAGE["io_streams"])
                log(f"started {self.audio_workers} audio decode processes in {time.monotonic() - started:.1f}s")
            return self._pool

    def _write(self, payload: dict) -> None:
        with self._state_lock:
            self._result_index += 1
            index = self._result_index
        path = self.tmp_dir / RESULT_NAME_FMT.format(idx=index)
        path.write_text(json.dumps(payload), encoding="utf-8")
        try:
            self.server.write_transcript(path)
        finally:
            path.unlink(missing_ok=True)

    def _write_error(self, item: dict, error: str) -> None:
        with self._state_lock:
            self.failed += 1
        try:
            self._write({"fileKey": item["key"], "error": error, "model": self.client.model})
        except Exception as err:
            log(f"could not record the transcript error for {item['relativePath']}: {err!r}")

    def _extract(self, item: dict):
        import av
        path = self.video_root / item["relativePath"]
        started = time.monotonic()
        if not path.is_file():
            log(f"skip {item['relativePath']}: file missing")
            return None
        try:
            with av.open(str(path)) as container:
                has_audio = len(container.streams.audio) > 0
            if not has_audio:
                with self._state_lock:
                    self.no_audio += 1
                self._write({"fileKey": item["key"], "noAudio": True, "words": [], "startsMs": [], "endsMs": [], "audioSeconds": 0, "extractionMs": int((time.monotonic() - started) * 1000), "model": self.client.model})
                return None
            result = audio_extract.extract(str(path), self._audio_pool(), self.audio_workers, AUDIO_STORAGE["read_chunk"], AUDIO_STORAGE["access"], AUDIO_STORAGE["io_streams"])
            try:
                pcm = np.array(result.pcm, dtype=np.float32)
                method = result.method
            finally:
                result.close()
        except Exception:
            error = traceback.format_exc()
            log(f"audio extraction failed for {item['relativePath']}: {error}")
            self._write_error(item, f"audio extraction failed: {error}")
            return None
        return {"item": item, "pcm": pcm, "method": method, "extractSeconds": time.monotonic() - started}

    def _enqueue(self, item: dict) -> None:
        with self._state_lock:
            self.handled.add(item["key"])
        job = None
        try:
            job = self._extract(item)
        finally:
            if job is None:
                self._slots.release()
        if job is not None:
            self._queue.put(job)

    def offer(self, item: dict) -> bool:
        if not self.enabled:
            return False
        if not self._slots.acquire(blocking=False):
            with self._state_lock:
                self.deferred += 1
            return False
        self._enqueue(item)
        return True

    def submit(self, item: dict) -> None:
        if not self.enabled:
            return
        self._slots.acquire()
        self._enqueue(item)

    def _transcriber_loop(self) -> None:
        while True:
            job = self._queue.get()
            if job is None:
                return
            item = job["item"]
            rel = item["relativePath"]
            started = time.monotonic()
            waited_before = self.client.waited_seconds
            try:
                audio_seconds = len(job["pcm"]) / SAMPLE_RATE
                result = self.client.transcribe(job["pcm"], f"transcribing {rel}")
                waited = self.client.waited_seconds - waited_before
                elapsed = time.monotonic() - started
                self._write({
                    "fileKey": item["key"],
                    "words": result["words"],
                    "startsMs": result["startsMs"],
                    "endsMs": result["endsMs"],
                    "audioSeconds": audio_seconds,
                    "extractionMs": int((job["extractSeconds"] + elapsed - waited) * 1000),
                    "model": self.client.model,
                })
                with self._state_lock:
                    self.done += 1
                    self.words += len(result["words"])
                    self.audio_seconds += audio_seconds
                    done = self.done
                log(f"done #{done} {rel}: {len(result['words'])} words from {audio_seconds:.0f}s of audio; audio read {job['extractSeconds']:.1f}s ({job['method']}), fastvoice {elapsed - waited:.1f}s in {result['windows']} windows ({result['modelSeconds']:.1f}s model time), waited {waited:.0f}s for fastvoice to be idle")
            except Exception:
                error = traceback.format_exc()
                log(f"transcription failed for {rel}: {error}")
                self._write_error(item, f"transcription failed: {error}")
            finally:
                job["pcm"] = None
                self._slots.release()

    def finish(self) -> None:
        if not self.enabled or self._thread is None:
            return
        self._queue.put(None)
        self._thread.join()
        if self._pool is not None:
            self._pool.shutdown()
        log(f"finished: {self.done} transcribed ({self.words} words, {self.audio_seconds / 3600:.1f}h of audio), {self.no_audio} without an audio track, {self.failed} failed")
