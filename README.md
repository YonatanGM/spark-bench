# Spark Splat Bench

A stress-test viewer for large Gaussian splat scenes, built on [Spark](https://sparkjs.dev) 2.4.0 and three.js r180. Open it on any phone, tablet or computer, run the benchmark and send back the JSON report.

## What it measures
- FPS, frame time p50 / p95 / worst, share of frames slower than 30 FPS
- GPU time per frame (WebGL timer queries; not available in Safari or most mobile browsers)
- Splats drawn (current LOD cut), LOD budget (base × scale), LOD updates per second, LOD tree size
- Load timing: download, decode + LOD build, first frame
- Estimated splat memory, JS heap (Chrome only), WebGL context loss, and loads that never finished (tab crash / out of memory)
- Device: GPU string, pixel ratio, drawing-buffer size, Spark's platform default budget

Settings are in the URL, so a link reproduces a configuration, e.g. `?scene=garage&lod=quick&keep=0&budget=1000000&dpr=1`. Add `&bench=1` to start the benchmark automatically after loading.

## Scenes
Both scenes are CC BY 4.0 and were downloaded from SuperSplat:
- **Garage – High Detail Test** (13.9M splats) by [Ethan](https://superspl.at/user?id=ethan3111), [source](https://superspl.at/scene/8f4d8e05)
- **Tiny Planet – Still Life** (5.1M splats) by [Stéphane Agullo](https://superspl.at/user/sa3d), [source](https://superspl.at/scene/d59f99ee)

Spark reads SOG only as a single `.sog` zip. GitHub rejects files over 100 MB, so each `.sog` is split into parts below 50 MB (`tools/split_file.py`) and joined back into one stream for `SplatMesh({ stream, streamLength })`. The whole file is downloaded and decoded before rendering; this is not LOD streaming.

## Run locally
```
npm install          # pinned Spark 2.4.0 + three 0.180.0
npm run vendor       # copies runtime files into vendor/
python tools/serve.py 8770          # http://127.0.0.1:8770/
python tools/serve.py 8770 --lan    # reachable from phones on the same Wi-Fi
```

## Layout
- `index.html`, `src/` – the app (no build step; import map points at `vendor/`)
- `scenes/` – catalog (`scenes.json`), split `.sog` parts, per-scene license
- `reference/spark-2.4.0/` – Spark README, docs and the examples this app follows
- `tools/` – vendoring, splitting, local server, headless checks

Spark is MIT licensed (World Labs Technologies, Inc.); three.js is MIT licensed.
