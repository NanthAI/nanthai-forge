# SPDX-License-Identifier: Apache-2.0
"""Write a snapshot ZIP holding one project's rows (and every row that names it), every row
without a projectId (accounts, settings, project shells), and all table metadata and stored
files unchanged. Imported alone, it restores that project without the rest of the deployment.
stdout is one JSON line of counts; errors exit 1 without echoing private input."""
import json
import shutil
import sys
import zipfile

source, target, project = sys.argv[1:4]
marker = project.encode()
try:
    kept = dropped = 0
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(
        target, "x", compression=zipfile.ZIP_DEFLATED
    ) as out:
        for entry in archive.infolist():
            name = entry.filename
            if entry.is_dir():
                continue
            parts = name.split("/")
            with archive.open(entry) as stream, out.open(name, "w", force_zip64=True) as sink:
                if len(parts) == 2 and parts[1] == "documents.jsonl" and not parts[0].startswith("_"):
                    for line in stream:
                        if not line.strip():
                            continue
                        row = json.loads(line)
                        if "projectId" not in row or row["projectId"] == project or marker in line:
                            sink.write(line if line.endswith(b"\n") else line + b"\n")
                            kept += 1
                        else:
                            dropped += 1
                else:
                    shutil.copyfileobj(stream, sink, 1024 * 1024)
    print(json.dumps({"kept": kept, "dropped": dropped}))
except Exception:
    sys.exit(1)
