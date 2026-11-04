# Splat Stress Test

Open a large Gaussian splat scene on any phone, tablet or computer and see how it runs. Built on [Spark](https://sparkjs.dev) 2.4.0 and three.js r180.

**Live:** https://yonatangm.github.io/spark-bench/

## Controls
- **Scene**: switch between the scenes below (reloads the page so memory starts clean)
- **LOD budget**: Auto (Spark's device default), fixed base budgets, a custom base, or All splats (LOD off)
- **LOD scale**: multiplies the base budget
- **Resolution**: render pixel ratio
- Move: drag to look, WASD / arrows, scroll. On touch devices: drag to look and the joystick to move.

## Readout
Current splats drawn, FPS, time per frame, GPU time (where the browser allows it), the budget, stutters (frames over 50 ms), splat memory, JS memory (Chrome), and how long download, decode and LOD build took. If a previous load crashed the tab, it says so.

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
- `tools/` – vendoring, splitting, local server, headless check

Spark is MIT licensed (World Labs Technologies, Inc.); three.js is MIT licensed.
