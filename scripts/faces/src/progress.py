from __future__ import annotations

import threading


def fmt_span(secs: float) -> str:
    secs = int(max(0.0, secs))
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, seconds = divmod(rem, 60)
    if days:
        return f"{days}d{hours:02d}h"
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{seconds:02d}s"
    return f"{seconds}s"


def fmt_clock(secs: float) -> str:
    secs = int(max(0.0, secs))
    hours, rem = divmod(secs, 3600)
    minutes, seconds = divmod(rem, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}"


def fmt_media_hours(secs: float) -> str:
    return f"{max(0.0, secs) / 3600:,.1f}h"


def planned_seconds(item: dict) -> float:
    value = item.get("durationSec")
    if isinstance(value, (int, float)) and value > 0:
        return float(value)
    return 0.0


class PlanProgress:
    def __init__(self, items: list[dict], library_files: int, library_done: int) -> None:
        known = [seconds for seconds in (planned_seconds(item) for item in items) if seconds > 0]
        self.total_files = len(items)
        self.known_files = len(known)
        self.planned_seconds_total = sum(known)
        self.mean_known_seconds = sum(known) / len(known) if known else 0.0
        self.remaining_known_seconds = sum(known)
        self.remaining_unknown_files = len(items) - len(known)
        self.done_files = 0
        self.failed_files = 0
        self.done_media_seconds = 0.0
        self.library_files = library_files
        self.library_done = library_done
        self.lock = threading.Lock()

    def complete(self, item: dict, media_seconds: float | None = None, failed: bool = False) -> int:
        planned = planned_seconds(item)
        with self.lock:
            self.done_files += 1
            if failed:
                self.failed_files += 1
            if planned > 0:
                self.remaining_known_seconds = max(0.0, self.remaining_known_seconds - planned)
            else:
                self.remaining_unknown_files = max(0, self.remaining_unknown_files - 1)
            self.done_media_seconds += planned if media_seconds is None else media_seconds
            return self.done_files

    def plan_text(self, media_noun: str) -> str:
        text = f"{self.total_files:,} files"
        if self.known_files > 0:
            text += f", {fmt_media_hours(self.planned_seconds_total)} of {media_noun}"
        unknown = self.total_files - self.known_files
        if unknown > 0:
            text += f" ({unknown:,} with no known length"
            text += ", counted at the average of the others)" if self.known_files > 0 else ")"
        text += f"; library {self.library_done:,}/{self.library_files:,} files already done"
        return text

    def snapshot(self, work_seconds: float, partial_media_seconds: float = 0.0) -> dict:
        with self.lock:
            done_files = self.done_files
            failed_files = self.failed_files
            done_media = self.done_media_seconds + partial_media_seconds
            remaining_media = max(0.0, self.remaining_known_seconds + self.remaining_unknown_files * self.mean_known_seconds - partial_media_seconds)
        remaining_files = max(0, self.total_files - done_files)
        eta_seconds = None
        media_per_second = None
        if work_seconds > 0 and done_media > 0:
            media_per_second = done_media / work_seconds
        if remaining_files == 0:
            eta_seconds = 0.0
        elif media_per_second is not None and self.known_files > 0:
            eta_seconds = remaining_media / media_per_second
        elif work_seconds > 0 and done_files > 0:
            eta_seconds = remaining_files * work_seconds / done_files
        return {
            "doneFiles": done_files,
            "failedFiles": failed_files,
            "remainingFiles": remaining_files,
            "doneMediaSeconds": done_media,
            "totalMediaSeconds": done_media + remaining_media,
            "etaSeconds": eta_seconds,
            "mediaPerSecond": media_per_second,
        }

    def counts_text(self, snap: dict, media_noun: str) -> str:
        text = f"{snap['doneFiles']:,}/{self.total_files:,} files this run"
        if self.known_files > 0 and snap["totalMediaSeconds"] > 0:
            percent = 100.0 * snap["doneMediaSeconds"] / snap["totalMediaSeconds"]
            text += f", {fmt_media_hours(snap['doneMediaSeconds'])}/{fmt_media_hours(snap['totalMediaSeconds'])} of {media_noun} ({percent:.1f}%)"
        elif self.total_files > 0:
            text += f" ({100.0 * snap['doneFiles'] / self.total_files:.1f}%)"
        text += f"; library {min(self.library_files, self.library_done + snap['doneFiles']):,}/{self.library_files:,} files done"
        return text
