# SPDX-License-Identifier: Apache-2.0
"""Read a snapshot ZIP front to back without extracting files. SOURCE is a path or "-" for stdin,
so a backup can stream straight from storage and is never written whole to disk. stdout is
private input to Node: one JSON event per table, record and file.

With PROJECT it also writes to file descriptor 3, in the same pass, a ZIP holding that project's rows
(and every row that names it), every row without a projectId (accounts, settings, project
shells), and all table metadata and stored files unchanged; imported alone it restores that
project without the rest of the deployment. fd 3 is a pipe, so that ZIP (data descriptors,
zip64) is never written whole either. The last event then counts kept and dropped rows.

Entries are read from their local headers; the central directory must list exactly the entries
read, in order. Errors exit 1 without echoing private input."""
import hashlib
import json
import shutil
import struct
import sys
import zipfile
import zlib

LOCAL, CENTRAL, DESCRIPTOR = 0x04034B50, 0x02014B50, 0x08074B50
CHUNK = 1 << 20


class Reader:
    def __init__(self, stream):
        self.stream, self.buffer = stream, b""

    def take(self, size):
        while len(self.buffer) < size:
            more = self.stream.read(max(CHUNK, size - len(self.buffer)))
            if not more:
                raise ValueError("truncated")
            self.buffer += more
        out, self.buffer = self.buffer[:size], self.buffer[size:]
        return out

    def chunk(self, limit=CHUNK):
        if not self.buffer:
            self.buffer = self.stream.read(CHUNK)
            if not self.buffer:
                raise ValueError("truncated")
        out, self.buffer = self.buffer[:limit], self.buffer[limit:]
        return out

    def unread(self, data):
        self.buffer = data + self.buffer

    def rest(self, limit=64 << 20):
        out = self.buffer + self.stream.read(limit + 1 - len(self.buffer))
        if len(out) > limit:
            raise ValueError("central directory too large")
        return out


def zip64_sizes(extra, usize, csize):
    at = 0
    while at + 4 <= len(extra):
        kind, length = struct.unpack_from("<HH", extra, at)
        if kind == 1:
            fields, offset = extra[at + 4 : at + 4 + length], 0
            if usize == 0xFFFFFFFF:
                usize, offset = struct.unpack_from("<Q", fields, offset)[0], offset + 8
            if csize == 0xFFFFFFFF:
                csize = struct.unpack_from("<Q", fields, offset)[0]
            return usize, csize
        at += 4 + length
    return usize, csize


def descriptor(reader, actual):
    """Skip a data descriptor. Writers differ: the signature is optional, sizes are 4 or 8 bytes,
    and some write 0xFFFFFFFF and keep the real sizes only in the central directory (which is
    checked against what was read). The layout is the one followed by the next header."""
    head = reader.take(4)
    if struct.unpack("<I", head)[0] != DESCRIPTOR:
        reader.unread(head)
    ahead = reader.take(24)
    reader.unread(ahead)
    following = lambda at: struct.unpack_from("<I", ahead, at)[0] in (LOCAL, CENTRAL)
    if struct.unpack_from("<IQQ", ahead) == actual and following(20):
        reader.take(20)
    elif struct.unpack_from("<I", ahead)[0] == actual[0] and following(12) and (
        struct.unpack_from("<II", ahead, 4) in (actual[1:], (0xFFFFFFFF, 0xFFFFFFFF))
    ):
        reader.take(12)
    else:
        raise ValueError("entry checksum")


def entry(reader, entries):
    """One local entry: (name, raw name, generator of its uncompressed bytes). Once drained, the
    generator checks CRC and sizes and appends (raw name, crc, compressed, uncompressed)."""
    flags, method, _, _, crc, csize, usize, name_length, extra_length = struct.unpack(
        "<2xHHHHIIIHH", reader.take(26)
    )
    raw = reader.take(name_length)
    name = raw.decode("utf-8" if flags & 0x800 else "cp437")
    usize, csize = zip64_sizes(reader.take(extra_length), usize, csize)
    streamed = bool(flags & 8)
    if flags & 1 or method not in (0, 8) or (streamed and method == 0):
        raise ValueError("unsupported entry")

    def data():
        actual_crc = actual_size = consumed = 0
        remaining = None if streamed else csize
        inflater = zlib.decompressobj(-15) if method == 8 else None
        while remaining != 0 and not (inflater and inflater.eof):
            piece = reader.chunk(CHUNK if remaining is None else min(remaining, CHUNK))
            if remaining is not None:
                remaining -= len(piece)
            if inflater is None:
                out, consumed = piece, consumed + len(piece)
            else:
                out = inflater.decompress(piece, CHUNK)
                while True:
                    actual_crc, actual_size = zlib.crc32(out, actual_crc), actual_size + len(out)
                    yield out
                    # At the end of the stream, unconsumed_tail repeats unused_data.
                    if inflater.eof or not inflater.unconsumed_tail:
                        break
                    out = inflater.decompress(inflater.unconsumed_tail, CHUNK)
                consumed += len(piece) - len(inflater.unused_data)
                if inflater.unused_data:
                    if remaining is not None:
                        raise ValueError("entry size")
                    reader.unread(inflater.unused_data)
                continue
            actual_crc, actual_size = zlib.crc32(out, actual_crc), actual_size + len(out)
            yield out
        if inflater and not inflater.eof:
            raise ValueError("truncated entry")
        actual = (actual_crc, consumed, actual_size)
        if streamed:
            descriptor(reader, actual)
        elif (crc, csize, usize) != actual:
            raise ValueError("entry checksum")
        entries.append((raw, *actual))

    return name, raw, data()


def lines(chunks):
    carry = b""
    for chunk in chunks:
        parts = (carry + chunk).split(b"\n")
        carry = parts.pop()
        yield from parts
    if carry:
        yield carry


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")


def central(tail):
    """(raw name, crc, compressed, uncompressed) of every central directory record."""
    records, at = [], 0
    while at + 46 <= len(tail) and struct.unpack_from("<I", tail, at)[0] == CENTRAL:
        crc, csize, usize, name_length, extra_length, comment_length = struct.unpack_from(
            "<IIIHHH", tail, at + 16
        )
        name = tail[at + 46 : at + 46 + name_length]
        extra = tail[at + 46 + name_length : at + 46 + name_length + extra_length]
        records.append((name, crc, *reversed(zip64_sizes(extra, usize, csize))))
        at += 46 + name_length + extra_length + comment_length
    return records


def main():
    source, project = (sys.argv[1:3] + [None])[:2]
    marker = project.encode() if project else None
    stream = sys.stdin.buffer if source == "-" else open(source, "rb")
    reader, seen, entries, kept, dropped = Reader(stream), set(), [], 0, 0
    sink_file = open(3, "wb") if project else None
    out = zipfile.ZipFile(sink_file, "w", compression=zipfile.ZIP_DEFLATED) if project else None
    while True:
        head = reader.take(4)
        if struct.unpack("<I", head)[0] != LOCAL:
            reader.unread(head)
            break
        name, raw, data = entry(reader, entries)
        if name in seen or name.startswith("/") or ".." in name.split("/"):
            raise ValueError("invalid entry")
        seen.add(name)
        if name.endswith("/"):
            for _ in data:
                pass
            continue
        parts = name.split("/")
        sink = out.open(name, "w", force_zip64=True) if out else None
        if len(parts) == 2 and parts[1] in ("documents.jsonl", "generated_schema.jsonl"):
            table = parts[0] if parts[1] == "documents.jsonl" else name
            filtered = sink and parts[1] == "documents.jsonl" and not parts[0].startswith("_")
            emit({"kind": "table", "table": table})
            for line in lines(data):
                if not line.strip():
                    continue
                row = json.loads(line)
                emit({"kind": "record", "table": table, "value": row})
                if not sink:
                    continue
                if not filtered or "projectId" not in row or row["projectId"] == project or marker in line:
                    sink.write(line + b"\n")
                    kept += filtered
                else:
                    dropped += 1
        else:
            digest, size = hashlib.sha256(), 0
            for chunk in data:
                digest.update(chunk)
                size += len(chunk)
                if sink:
                    sink.write(chunk)
            emit({"kind": "file", "path": name, "sha256": digest.hexdigest(), "size": size})
        if sink:
            sink.close()
    if central(reader.rest()) != entries:
        raise ValueError("central directory differs")
    if out:
        out.close()
        sink_file.close()
        emit({"kind": "filtered", "kept": kept, "dropped": dropped})
    sys.stdout.flush()


try:
    main()
except Exception:
    # Parsing errors can contain private document text or paths.
    sys.exit(1)
