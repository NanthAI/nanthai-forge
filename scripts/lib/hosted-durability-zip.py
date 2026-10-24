# SPDX-License-Identifier: Apache-2.0
"""Read a snapshot without extracting files. stdout is private input to Node."""
import hashlib
import json
import sys
import zipfile


def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


try:
    with zipfile.ZipFile(sys.argv[1]) as archive:
        seen = set()
        for entry in archive.infolist():
            name = entry.filename
            if name in seen or name.startswith("/") or ".." in name.split("/"):
                raise ValueError("invalid entry")
            seen.add(name)
            if entry.is_dir():
                continue
            parts = name.split("/")
            if len(parts) == 2 and parts[1] in ("documents.jsonl", "generated_schema.jsonl"):
                table = parts[0] if parts[1] == "documents.jsonl" else name
                emit({"kind": "table", "table": table})
                with archive.open(entry) as stream:
                    for line in stream:
                        if line.strip():
                            emit({"kind": "record", "table": table, "value": json.loads(line)})
            else:
                digest = hashlib.sha256()
                size = 0
                with archive.open(entry) as stream:
                    while True:
                        chunk = stream.read(1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
                        size += len(chunk)
                emit({"kind": "file", "path": name, "sha256": digest.hexdigest(), "size": size})
except Exception:
    # Parsing errors can contain private document text or paths.
    sys.exit(1)
