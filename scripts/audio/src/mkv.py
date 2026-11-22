import os
from dataclasses import dataclass, field
from fractions import Fraction

ID_EBML = 0x1A45DFA3
ID_SEGMENT = 0x18538067
ID_SEEK_HEAD = 0x114D9B74
ID_SEEK = 0x4DBB
ID_SEEK_ID = 0x53AB
ID_SEEK_POSITION = 0x53AC
ID_INFO = 0x1549A966
ID_TIMESTAMP_SCALE = 0x2AD7B1
ID_DURATION = 0x4489
ID_TRACKS = 0x1654AE6B
ID_TRACK_ENTRY = 0xAE
ID_TRACK_NUMBER = 0xD7
ID_TRACK_TYPE = 0x83
ID_FLAG_DEFAULT = 0x88
ID_CODEC_ID = 0x86
ID_CODEC_PRIVATE = 0x63A2
ID_CODEC_DELAY = 0x56AA
ID_LANGUAGE = 0x22B59C
ID_AUDIO = 0xE1
ID_SAMPLING_FREQUENCY = 0xB5
ID_OUTPUT_SAMPLING_FREQUENCY = 0x78B5
ID_CHANNELS = 0x9F
ID_CONTENT_ENCODINGS = 0x6D80
ID_CONTENT_ENCODING = 0x6240
ID_CONTENT_COMPRESSION = 0x5034
ID_CONTENT_COMP_ALGO = 0x4254
ID_CONTENT_COMP_SETTINGS = 0x4255
ID_CUES = 0x1C53BB6B
ID_CUE_POINT = 0xBB
ID_CUE_TRACK_POSITIONS = 0xB7
ID_CUE_CLUSTER_POSITION = 0xF1
ID_CLUSTER = 0x1F43B675

TRACK_TYPE_AUDIO = 2
COMP_ALGO_HEADER_STRIPPING = 3
DEFAULT_TIMESTAMP_SCALE_NS = 1_000_000
NS_PER_SECOND = 1_000_000_000
HEADER_READ_BYTES = 256 * 1024
ELEMENT_HEADER_MAX_BYTES = 12
WIN_GENERIC_READ = 0x80000000
WIN_FILE_SHARE_ALL = 7
WIN_OPEN_EXISTING = 3
WIN_FILE_FLAG_NO_BUFFERING = 0x20000000
WIN_FILE_FLAG_RANDOM_ACCESS = 0x10000000
WIN_INVALID_HANDLE_VALUE = 0xFFFFFFFFFFFFFFFF
DIRECT_ALIGN_BYTES = 4096
DIRECT_INITIAL_BUFFER_BYTES = 1024 * 1024
SCAN_MIN_AVAILABLE_BYTES = 20
FRAME_BATCH_BYTES = 65536
CLUSTER_ID_BYTES = b"\x1f\x43\xb6\x75"
RESYNC_READ_BYTES = 4 * 1024 * 1024
RESYNC_MAX_READS = 16
AAC_SAMPLES_PER_FRAME = 1024
AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
AOT_SBR = 5
AOT_PS = 29
AOT_ESCAPE = 31
SAMPLE_RATE_INDEX_EXPLICIT = 15
LACING_MASK = 0x06
LACING_XIPH = 0x02
LACING_FIXED = 0x04
LACING_EBML = 0x06
SIZE_MASKS = [0] + [(1 << (7 * n)) - 1 for n in range(1, 9)]


class MkvError(Exception):
    pass


@dataclass
class AudioTrack:
    number: int
    codec_id: str
    codec_private: bytes
    is_default: bool
    language: str
    sampling_frequency: float
    output_sampling_frequency: float
    channels: int
    codec_delay_ns: int
    stripped_header: bytes
    unsupported_encoding: bool


@dataclass
class AacConfig:
    profile: int
    sample_rate_index: int
    channel_config: int
    base_sample_rate: int
    output_sample_rate: int


@dataclass
class MkvInfo:
    path: str
    file_size: int
    segment_start: int
    segment_end: int
    timestamp_scale_ns: int
    duration_seconds: float | None
    first_cluster_pos: int
    cluster_positions: list[int]
    audio_tracks: list[AudioTrack] = field(default_factory=list)


def read_size(buf, off):
    b0 = buf[off]
    if b0 == 0:
        raise MkvError("invalid EBML size byte 0x00")
    n = 9 - b0.bit_length()
    value = int.from_bytes(buf[off:off + n], "big") & SIZE_MASKS[n]
    if value == SIZE_MASKS[n]:
        value = -1
    return value, n


def read_id(buf, off):
    b0 = buf[off]
    n = 9 - b0.bit_length()
    if n > 4:
        raise MkvError(f"invalid EBML id byte 0x{b0:02x}")
    return int.from_bytes(buf[off:off + n], "big"), n


def iter_children(data):
    off = 0
    end = len(data)
    while off < end:
        element_id, n = read_id(data, off)
        off += n
        size, n = read_size(data, off)
        off += n
        if size < 0:
            size = end - off
        yield element_id, data[off:off + size]
        off += size


def read_uint(data):
    return int.from_bytes(data, "big")


def read_float(data):
    import struct
    if len(data) == 4:
        return struct.unpack(">f", data)[0]
    if len(data) == 8:
        return struct.unpack(">d", data)[0]
    return 0.0


class DirectFile:
    def __init__(self, path):
        import ctypes
        import mmap
        import msvcrt
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.restype = ctypes.c_void_p
        kernel32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        handle = kernel32.CreateFileW(path, WIN_GENERIC_READ, WIN_FILE_SHARE_ALL, None, WIN_OPEN_EXISTING, WIN_FILE_FLAG_NO_BUFFERING | WIN_FILE_FLAG_RANDOM_ACCESS, None)
        if handle is None or handle == WIN_INVALID_HANDLE_VALUE:
            raise OSError(ctypes.get_last_error(), f"CreateFileW failed for {path}")
        self.raw = open(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb", buffering=0)
        self.mmap_module = mmap
        self.capacity = DIRECT_INITIAL_BUFFER_BYTES
        self.buffer = mmap.mmap(-1, self.capacity)
        self.pos = 0

    def seek(self, pos):
        self.pos = pos

    def read(self, n):
        aligned = self.pos - self.pos % DIRECT_ALIGN_BYTES
        lead = self.pos - aligned
        length = -(-(lead + n) // DIRECT_ALIGN_BYTES) * DIRECT_ALIGN_BYTES
        if length > self.capacity:
            self.buffer.close()
            self.capacity = length
            self.buffer = self.mmap_module.mmap(-1, self.capacity)
        self.raw.seek(aligned)
        view = memoryview(self.buffer)
        try:
            got = self.raw.readinto(view[:length]) or 0
            data = bytes(view[lead:min(got, lead + n)]) if got > lead else b""
        finally:
            view.release()
        self.pos += len(data)
        return data

    def close(self):
        self.raw.close()
        self.buffer.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def open_for_read(path, access):
    if access == "direct":
        return DirectFile(path)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if access == "random":
        flags |= getattr(os, "O_RANDOM", 0)
    elif access == "sequential":
        flags |= getattr(os, "O_SEQUENTIAL", 0)
    return open(os.open(path, flags), "rb", buffering=0)


def read_at(f, pos, n):
    f.seek(pos)
    return f.read(n)


def parse_track_entry(data):
    number = 0
    track_type = 0
    codec_id = ""
    codec_private = b""
    is_default = True
    language = "eng"
    sampling_frequency = 8000.0
    output_sampling_frequency = 0.0
    channels = 1
    codec_delay_ns = 0
    stripped_header = b""
    unsupported_encoding = False
    for element_id, payload in iter_children(data):
        if element_id == ID_TRACK_NUMBER:
            number = read_uint(payload)
        elif element_id == ID_TRACK_TYPE:
            track_type = read_uint(payload)
        elif element_id == ID_CODEC_ID:
            codec_id = payload.decode("ascii", "replace").rstrip("\x00")
        elif element_id == ID_CODEC_PRIVATE:
            codec_private = bytes(payload)
        elif element_id == ID_FLAG_DEFAULT:
            is_default = read_uint(payload) != 0
        elif element_id == ID_LANGUAGE:
            language = payload.decode("ascii", "replace").rstrip("\x00")
        elif element_id == ID_CODEC_DELAY:
            codec_delay_ns = read_uint(payload)
        elif element_id == ID_AUDIO:
            for audio_id, audio_payload in iter_children(payload):
                if audio_id == ID_SAMPLING_FREQUENCY:
                    sampling_frequency = read_float(audio_payload)
                elif audio_id == ID_OUTPUT_SAMPLING_FREQUENCY:
                    output_sampling_frequency = read_float(audio_payload)
                elif audio_id == ID_CHANNELS:
                    channels = read_uint(audio_payload)
        elif element_id == ID_CONTENT_ENCODINGS:
            for encoding_id, encoding_payload in iter_children(payload):
                if encoding_id != ID_CONTENT_ENCODING:
                    continue
                recognised = False
                for part_id, part_payload in iter_children(encoding_payload):
                    if part_id != ID_CONTENT_COMPRESSION:
                        continue
                    algo = 0
                    settings = b""
                    for comp_id, comp_payload in iter_children(part_payload):
                        if comp_id == ID_CONTENT_COMP_ALGO:
                            algo = read_uint(comp_payload)
                        elif comp_id == ID_CONTENT_COMP_SETTINGS:
                            settings = bytes(comp_payload)
                    if algo == COMP_ALGO_HEADER_STRIPPING:
                        stripped_header = settings
                        recognised = True
                if not recognised:
                    unsupported_encoding = True
    if track_type != TRACK_TYPE_AUDIO:
        return None
    return AudioTrack(
        number=number,
        codec_id=codec_id,
        codec_private=codec_private,
        is_default=is_default,
        language=language,
        sampling_frequency=sampling_frequency,
        output_sampling_frequency=output_sampling_frequency,
        channels=channels,
        codec_delay_ns=codec_delay_ns,
        stripped_header=stripped_header,
        unsupported_encoding=unsupported_encoding,
    )


def parse_cues(data, segment_start):
    positions = set()
    for element_id, payload in iter_children(data):
        if element_id != ID_CUE_POINT:
            continue
        for point_id, point_payload in iter_children(payload):
            if point_id != ID_CUE_TRACK_POSITIONS:
                continue
            for position_id, position_payload in iter_children(point_payload):
                if position_id == ID_CUE_CLUSTER_POSITION:
                    positions.add(segment_start + read_uint(position_payload))
    return positions


def parse_header(path):
    file_size = os.path.getsize(path)
    with open_for_read(path, "random") as f:
        head = f.read(HEADER_READ_BYTES)

        def get(pos, n):
            if pos + n <= len(head):
                return head[pos:pos + n]
            return read_at(f, pos, n)

        element_id, id_len = read_id(head, 0)
        if element_id != ID_EBML:
            raise MkvError("not an EBML file")
        size, size_len = read_size(head, id_len)
        pos = id_len + size_len + size
        element_id, id_len = read_id(get(pos, ELEMENT_HEADER_MAX_BYTES), 0)
        if element_id != ID_SEGMENT:
            raise MkvError("no Segment element after the EBML header")
        size, size_len = read_size(get(pos + id_len, 8), 0)
        segment_start = pos + id_len + size_len
        segment_end = file_size if size < 0 else min(file_size, segment_start + size)

        timestamp_scale_ns = DEFAULT_TIMESTAMP_SCALE_NS
        duration_ticks = None
        audio_tracks = []
        seek_positions = {}
        cue_positions = None
        first_cluster_pos = None
        seen = set()

        def handle(element_id, payload):
            nonlocal timestamp_scale_ns, duration_ticks, cue_positions
            seen.add(element_id)
            if element_id == ID_SEEK_HEAD:
                for seek_id, seek_payload in iter_children(payload):
                    if seek_id != ID_SEEK:
                        continue
                    target_id = 0
                    target_pos = 0
                    for entry_id, entry_payload in iter_children(seek_payload):
                        if entry_id == ID_SEEK_ID:
                            target_id = read_uint(entry_payload)
                        elif entry_id == ID_SEEK_POSITION:
                            target_pos = read_uint(entry_payload)
                    seek_positions.setdefault(target_id, segment_start + target_pos)
            elif element_id == ID_INFO:
                for info_id, info_payload in iter_children(payload):
                    if info_id == ID_TIMESTAMP_SCALE:
                        timestamp_scale_ns = read_uint(info_payload)
                    elif info_id == ID_DURATION:
                        duration_ticks = read_float(info_payload)
            elif element_id == ID_TRACKS:
                for track_id, track_payload in iter_children(payload):
                    if track_id != ID_TRACK_ENTRY:
                        continue
                    track = parse_track_entry(track_payload)
                    if track:
                        audio_tracks.append(track)
            elif element_id == ID_CUES:
                cue_positions = parse_cues(payload, segment_start)

        def read_element(pos):
            header = get(pos, ELEMENT_HEADER_MAX_BYTES)
            if len(header) < 2:
                return None
            element_id, id_len = read_id(header, 0)
            size, size_len = read_size(header, id_len)
            return element_id, pos + id_len + size_len, size

        pos = segment_start
        while pos < segment_end:
            element = read_element(pos)
            if not element:
                break
            element_id, data_pos, size = element
            if element_id == ID_CLUSTER:
                first_cluster_pos = pos
                break
            if size < 0:
                raise MkvError(f"unknown-size element 0x{element_id:x} before the first cluster")
            if element_id in (ID_SEEK_HEAD, ID_INFO, ID_TRACKS, ID_CUES):
                handle(element_id, get(data_pos, size))
            pos = data_pos + size

        for wanted in (ID_INFO, ID_TRACKS, ID_CUES):
            if wanted in seen or wanted not in seek_positions:
                continue
            target = seek_positions[wanted]
            if target >= file_size:
                continue
            element = read_element(target)
            if not element or element[0] != wanted or element[2] < 0:
                continue
            handle(wanted, get(element[1], element[2]))

        if first_cluster_pos is None:
            raise MkvError("no Cluster found")

        cluster_positions = sorted(p for p in (cue_positions or ()) if first_cluster_pos <= p < segment_end)
        if not cluster_positions or cluster_positions[0] != first_cluster_pos:
            cluster_positions.insert(0, first_cluster_pos)

        duration_seconds = None
        if duration_ticks:
            duration_seconds = duration_ticks * timestamp_scale_ns / NS_PER_SECOND

        return MkvInfo(
            path=path,
            file_size=file_size,
            segment_start=segment_start,
            segment_end=segment_end,
            timestamp_scale_ns=timestamp_scale_ns,
            duration_seconds=duration_seconds,
            first_cluster_pos=first_cluster_pos,
            cluster_positions=cluster_positions,
            audio_tracks=audio_tracks,
        )


def find_cluster_near(f, target, limit):
    pos = target
    for _ in range(RESYNC_MAX_READS):
        if pos >= limit:
            return None
        buf = read_at(f, pos, RESYNC_READ_BYTES + ELEMENT_HEADER_MAX_BYTES + 2)
        search_from = 0
        while True:
            found = buf.find(CLUSTER_ID_BYTES, search_from)
            if found < 0 or found + ELEMENT_HEADER_MAX_BYTES + 2 > len(buf):
                break
            try:
                size, size_len = read_size(buf, found + 4)
                next_id = buf[found + 4 + size_len]
            except (MkvError, IndexError):
                next_id = 0
                size = 0
            if next_id in (0xE7, 0xBF, 0xEC) and (size < 0 or pos + found + size <= limit + ELEMENT_HEADER_MAX_BYTES):
                return pos + found
            search_from = found + 1
        if len(buf) < RESYNC_READ_BYTES:
            return None
        pos += RESYNC_READ_BYTES
    return None


def pick_audio_track(info):
    if not info.audio_tracks:
        return None
    for track in info.audio_tracks:
        if track.is_default:
            return track
    return info.audio_tracks[0]


def parse_aac_config(track):
    private = track.codec_private
    base_rate = 0
    output_rate = 0
    if len(private) >= 2:
        bits = int.from_bytes(private, "big")
        total = len(private) * 8
        cursor = 0

        def take(n):
            nonlocal cursor
            if cursor + n > total:
                raise MkvError("AudioSpecificConfig is truncated")
            value = (bits >> (total - cursor - n)) & ((1 << n) - 1)
            cursor += n
            return value

        def take_object_type():
            value = take(5)
            if value == AOT_ESCAPE:
                value = 32 + take(6)
            return value

        def take_sample_rate():
            index = take(4)
            if index == SAMPLE_RATE_INDEX_EXPLICIT:
                return index, take(24)
            if index >= len(AAC_SAMPLE_RATES):
                raise MkvError(f"reserved AAC sample rate index {index}")
            return index, AAC_SAMPLE_RATES[index]

        object_type = take_object_type()
        rate_index, base_rate = take_sample_rate()
        channel_config = take(4)
        output_rate = base_rate
        if object_type in (AOT_SBR, AOT_PS):
            _, output_rate = take_sample_rate()
            object_type = take_object_type()
    else:
        object_type = 2
        base_rate = int(round(track.sampling_frequency))
        output_rate = base_rate
        if base_rate not in AAC_SAMPLE_RATES:
            raise MkvError(f"AAC track has no CodecPrivate and a non-standard sample rate {base_rate}")
        rate_index = AAC_SAMPLE_RATES.index(base_rate)
        channel_config = track.channels

    if track.output_sampling_frequency:
        output_rate = int(round(track.output_sampling_frequency))
    if base_rate <= 0:
        raise MkvError("AAC track has no usable sample rate")
    return AacConfig(
        profile=object_type - 1,
        sample_rate_index=rate_index,
        channel_config=channel_config,
        base_sample_rate=base_rate,
        output_sample_rate=output_rate,
    )


def split_laced(data, flags):
    lacing = flags & LACING_MASK
    count = data[0] + 1
    off = 1
    sizes = []
    if lacing == LACING_FIXED:
        each = (len(data) - off) // count
        sizes = [each] * count
    elif lacing == LACING_XIPH:
        for _ in range(count - 1):
            size = 0
            while True:
                value = data[off]
                off += 1
                size += value
                if value != 255:
                    break
            sizes.append(size)
        sizes.append(len(data) - off - sum(sizes))
    else:
        size, n = read_size(data, off)
        off += n
        sizes.append(size)
        for _ in range(count - 2):
            raw, n = read_size(data, off)
            off += n
            size += raw - ((1 << (7 * n - 1)) - 1)
            sizes.append(size)
        sizes.append(len(data) - off - sum(sizes))
    spans = []
    for size in sizes:
        spans.append((off, size))
        off += size
    return spans


@dataclass
class ScanResult:
    frame_count: int = 0
    first_timestamp: int | None = None
    last_timestamp: int | None = None
    read_calls: int = 0
    read_bytes: int = 0
    payload_bytes: int = 0
    end_pos: int = 0


def scan_audio(f, start, end, file_size, track_number, read_chunk, limit, on_frames, on_spans=None):
    result = ScanResult()
    buf = b""
    base = 0
    blen = 0
    pos = start
    cluster_timestamp = 0
    frames = []
    spans = []
    read_calls = 0
    read_bytes = 0
    count = 0
    payload_bytes = 0
    first_timestamp = None
    last_timestamp = None
    pending_bytes = 0
    want_spans = on_spans is not None
    while pos < end:
        off = pos - base
        if off < 0 or off + SCAN_MIN_AVAILABLE_BYTES > blen:
            if not (off >= 0 and base + blen >= file_size and off + 2 <= blen):
                f.seek(pos)
                buf = f.read(read_chunk)
                read_calls += 1
                read_bytes += len(buf)
                base = pos
                blen = len(buf)
                off = 0
                if blen < 2:
                    break
        try:
            b0 = buf[off]
            if b0 == 0xA3 or b0 == 0xA1:
                s0 = buf[off + 1]
                n = 9 - s0.bit_length()
                if n == 1:
                    size = s0 & 0x7F
                else:
                    size = int.from_bytes(buf[off + 1:off + 1 + n], "big") & SIZE_MASKS[n]
                d = off + 1 + n
                t0 = buf[d]
                if t0 & 0x80:
                    track = t0 & 0x7F
                    h = 1
                else:
                    track, h = read_size(buf, d)
                if track == track_number:
                    data_end = d + size
                    if data_end > blen:
                        f.seek(pos)
                        buf = f.read(max(read_chunk, 1 + n + size + SCAN_MIN_AVAILABLE_BYTES))
                        read_calls += 1
                        read_bytes += len(buf)
                        base = pos
                        blen = len(buf)
                        off = 0
                        d = 1 + n
                        data_end = d + size
                        if data_end > blen:
                            break
                    timestamp = cluster_timestamp + int.from_bytes(buf[d + h:d + h + 2], "big", signed=True)
                    flags = buf[d + h + 2]
                    body = d + h + 3
                    if first_timestamp is None:
                        first_timestamp = timestamp
                    last_timestamp = timestamp
                    if flags & LACING_MASK:
                        laced = buf[body:data_end]
                        for lace_index, (lace_off, lace_size) in enumerate(split_laced(laced, flags)):
                            frames.append(laced[lace_off:lace_off + lace_size])
                            if want_spans:
                                spans.append((base + body + lace_off, lace_size, timestamp, lace_index))
                            count += 1
                            payload_bytes += lace_size
                            pending_bytes += lace_size
                    else:
                        frames.append(buf[body:data_end])
                        if want_spans:
                            spans.append((base + body, data_end - body, timestamp, 0))
                        count += 1
                        payload_bytes += data_end - body
                        pending_bytes += data_end - body
                    if limit and count >= limit:
                        pos += 1 + n + size
                        break
                    if pending_bytes >= FRAME_BATCH_BYTES:
                        on_frames(frames, first_timestamp)
                        frames = []
                        pending_bytes = 0
                        if want_spans:
                            on_spans(spans)
                            spans = []
                pos += 1 + n + size
            elif b0 == 0xE7:
                s0 = buf[off + 1]
                n = 9 - s0.bit_length()
                size = int.from_bytes(buf[off + 1:off + 1 + n], "big") & SIZE_MASKS[n]
                cluster_timestamp = int.from_bytes(buf[off + 1 + n:off + 1 + n + size], "big")
                pos += 1 + n + size
            elif b0 == 0xA0:
                s0 = buf[off + 1]
                pos += 1 + 9 - s0.bit_length()
            elif b0 == 0x1F and buf[off:off + 4] == CLUSTER_ID_BYTES:
                s0 = buf[off + 4]
                pos += 4 + 9 - s0.bit_length()
            else:
                id_len = 9 - b0.bit_length()
                if id_len > 4:
                    raise MkvError(f"lost sync at byte {pos}: invalid element id byte 0x{b0:02x}")
                s0 = buf[off + id_len]
                if s0 == 0:
                    raise MkvError(f"lost sync at byte {pos}: invalid element size")
                n = 9 - s0.bit_length()
                size = int.from_bytes(buf[off + id_len:off + id_len + n], "big") & SIZE_MASKS[n]
                if size == SIZE_MASKS[n]:
                    raise MkvError(f"unknown-size element at byte {pos} cannot be skipped")
                pos += id_len + n + size
        except IndexError:
            break
    if frames:
        on_frames(frames, first_timestamp)
    if want_spans and spans:
        on_spans(spans)
    result.frame_count = count
    result.first_timestamp = first_timestamp
    result.last_timestamp = last_timestamp
    result.read_calls = read_calls
    result.read_bytes = read_bytes
    result.payload_bytes = payload_bytes
    result.end_pos = pos
    return result


def frame_duration(config):
    return Fraction(AAC_SAMPLES_PER_FRAME, config.base_sample_rate)


def timestamp_to_frame_index(timestamp, timestamp_scale_ns, config):
    seconds = Fraction(timestamp * timestamp_scale_ns, NS_PER_SECOND)
    return round(seconds / frame_duration(config))
