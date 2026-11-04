# Spark Test

Open a large Gaussian splat scene on any phone, tablet or computer and see how it runs. Built on [Spark](https://sparkjs.dev) 2.4.0 and three.js r180.

**Live:** https://yonatangm.github.io/spark-bench/

## Panel
One panel on the left holds everything. Tap the top line to show or hide it (it starts hidden on phones).
- Controls: scene, budget (Auto, 250k to 10M, or custom), LOD scale, reset view
- Performance: FPS, frame time, slowest frame, stutters over 50 ms, GPU time (where the browser supports it)
- Splats: drawn, budget, LOD updates, scene total, LOD tree size
- Memory: splat pool size, JS heap (Chrome only)
- Streaming: chunks downloaded, MB downloaded, chunks in memory compared with the pool size, loading or idle
- Loading: time until the first view and until full detail for the starting view
- Device: GPU, browser, screen, render size, CPU threads
- Problems: a previous load that crashed the tab, or a lost WebGL context

Move: drag to look, WASD or arrow keys, mouse wheel. Touch screens get Spark's on-screen joystick automatically.

## Scenes
Both scenes are CC BY 4.0 and were downloaded from SuperSplat:
- **Garage – High Detail Test** (13.9M splats) by [Ethan](https://superspl.at/user?id=ethan3111), [source](https://superspl.at/scene/8f4d8e05)
- **Tiny Planet – Still Life** (5.1M splats) by [Stéphane Agullo](https://superspl.at/user/sa3d), [source](https://superspl.at/scene/d59f99ee)

Each scene is converted with Spark's `build-lod` tool into a pre-built LOD tree in chunked RAD format (`build-lod <scene>.sog --quality --rad-chunked`): a small `-lod.rad` header plus chunks of a few MB. The app loads it like Spark's streaming-lod example, `new SplatMesh({ url, paged: true })`: Spark fetches the coarse chunks first, shows the scene within a second or two, and adds detail for the current view into a fixed-size splat pool. Large scenes on SuperSplat work the same way.

To rebuild a scene: build Spark 2.4.0's `rust/build-lod` (`cargo build --release --no-default-features`, Rust required), run it on the `.sog` or `.ply`, copy the `-lod.rad` and `.radc` files to `scenes/<id>/rad/`, and update `scenes/scenes.json` (url, bytes, chunks).

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
