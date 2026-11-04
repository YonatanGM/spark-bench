"""Split a splat file into parts below GitHub's 50 MB warning size.
The app joins the parts back into one stream for SplatMesh({stream, streamLength}).
Usage: python tools/split_file.py <input> <out_dir> [part_mb=45]"""
import hashlib, json, sys
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
part = int(float(sys.argv[3]) * 1024 * 1024) if len(sys.argv) > 3 else 45 * 1024 * 1024
out.mkdir(parents=True, exist_ok=True)
names, sha = [], hashlib.sha256()
with src.open("rb") as f:
    i = 0
    while chunk := f.read(part):
        sha.update(chunk)
        name = f"{src.name}.part{i:02d}"
        (out / name).write_bytes(chunk)
        names.append(name)
        i += 1
print(json.dumps({"fileName": src.name, "bytes": src.stat().st_size, "parts": names, "sha256": sha.hexdigest()}, indent=2))
