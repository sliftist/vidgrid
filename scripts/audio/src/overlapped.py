import ctypes
import mmap
import time
from ctypes import wintypes

GENERIC_READ = 0x80000000
FILE_SHARE_ALL = 7
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
FILE_FLAG_NO_BUFFERING = 0x20000000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
ERROR_IO_PENDING = 997
WAIT_FOREVER_MS = 0xFFFFFFFF
ALIGN_BYTES = 4096
REAP_BATCH = 256


class Overlapped(ctypes.Structure):
    _fields_ = [("internal", ctypes.c_size_t), ("internal_high", ctypes.c_size_t), ("offset", wintypes.DWORD), ("offset_high", wintypes.DWORD), ("event", ctypes.c_void_p)]


class OverlappedEntry(ctypes.Structure):
    _fields_ = [("key", ctypes.c_size_t), ("overlapped", ctypes.c_void_p), ("internal", ctypes.c_size_t), ("transferred", wintypes.DWORD)]


def load_kernel32():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.CreateIoCompletionPort.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
    kernel32.CreateIoCompletionPort.restype = ctypes.c_void_p
    kernel32.ReadFile.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.c_void_p]
    kernel32.ReadFile.restype = wintypes.BOOL
    kernel32.GetQueuedCompletionStatusEx.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.ULONG, ctypes.c_void_p, wintypes.DWORD, wintypes.BOOL]
    kernel32.GetQueuedCompletionStatusEx.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = wintypes.BOOL
    return kernel32


class RangeData:
    def __init__(self, slab, ranges, aligned_starts, slots):
        self.slab = slab
        self.ranges = ranges
        self.aligned_starts = aligned_starts
        self.slots = slots

    def slice_spans(self, spans):
        frames = []
        at = 0
        range_end = self.ranges[0][1]
        shift = self.slots[0] - self.aligned_starts[0]
        slab = self.slab
        for span in spans:
            offset = span[0]
            while offset >= range_end:
                at += 1
                range_end = self.ranges[at][1]
                shift = self.slots[at] - self.aligned_starts[at]
            local = offset + shift
            frames.append(slab[local:local + span[1]])
        return frames

    def close(self):
        self.slab.close()


def read_ranges(path, ranges, queue_depth):
    kernel32 = load_kernel32()
    started = time.perf_counter()
    count = len(ranges)
    aligned_starts = []
    sizes = []
    slots = []
    total = 0
    for range_start, range_end in ranges:
        aligned_start = range_start // ALIGN_BYTES * ALIGN_BYTES
        aligned_end = (range_end + ALIGN_BYTES - 1) // ALIGN_BYTES * ALIGN_BYTES
        aligned_starts.append(aligned_start)
        sizes.append(aligned_end - aligned_start)
        slots.append(total)
        total += aligned_end - aligned_start
    slab = mmap.mmap(-1, max(total, ALIGN_BYTES))
    anchor = ctypes.c_char.from_buffer(slab)
    base = ctypes.addressof(anchor)
    overlapped = (Overlapped * count)()
    overlapped_base = ctypes.addressof(overlapped)
    overlapped_size = ctypes.sizeof(Overlapped)
    entries = (OverlappedEntry * REAP_BATCH)()
    removed = wintypes.ULONG(0)
    handle = kernel32.CreateFileW(path, GENERIC_READ, FILE_SHARE_ALL, None, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | FILE_FLAG_NO_BUFFERING, None)
    if handle is None or handle == INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    port = None
    stats = {"reads": count, "read_bytes": total, "completed_inline": 0, "peak_in_flight": 0, "queue_depth": queue_depth}
    try:
        port = kernel32.CreateIoCompletionPort(handle, None, 0, 0)
        if not port:
            raise ctypes.WinError(ctypes.get_last_error())
        submitted = 0
        finished = 0
        while finished < count:
            while submitted < count and submitted - finished < queue_depth:
                entry = overlapped[submitted]
                entry.offset = aligned_starts[submitted] & 0xFFFFFFFF
                entry.offset_high = aligned_starts[submitted] >> 32
                ok = kernel32.ReadFile(handle, base + slots[submitted], sizes[submitted], None, ctypes.byref(entry))
                if ok:
                    stats["completed_inline"] += 1
                else:
                    error = ctypes.get_last_error()
                    if error != ERROR_IO_PENDING:
                        raise ctypes.WinError(error)
                submitted += 1
            stats["peak_in_flight"] = max(stats["peak_in_flight"], submitted - finished)
            if not kernel32.GetQueuedCompletionStatusEx(port, entries, REAP_BATCH, ctypes.byref(removed), WAIT_FOREVER_MS, False):
                raise ctypes.WinError(ctypes.get_last_error())
            for i in range(removed.value):
                done = entries[i]
                index = (done.overlapped - overlapped_base) // overlapped_size
                needed = ranges[index][1] - aligned_starts[index]
                if done.internal != 0 or done.transferred < needed:
                    raise OSError(f"read {index} at {aligned_starts[index]} failed: status 0x{done.internal:08x}, got {done.transferred} of {needed} bytes")
            finished += removed.value
    finally:
        if port:
            kernel32.CloseHandle(port)
        kernel32.CloseHandle(handle)
        del anchor
    stats["seconds"] = time.perf_counter() - started
    return RangeData(slab, ranges, aligned_starts, slots), stats
