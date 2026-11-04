"""Headless Chrome check against the real scene files.
Usage: <python with playwright> tools/check_app.py [scene] [--mobile]
Writes screenshots + JSON to tools/check_out/."""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

out = Path(__file__).parent / "check_out"; out.mkdir(exist_ok=True)
scene = next((a for a in sys.argv[1:] if not a.startswith("--")), "garage")
mobile = "--mobile" in sys.argv
tag = scene + ("_mobile" if mobile else "")
logs, errors, res = [], [], {}
STATE = "({drawn: window.splatBench.mesh.numSplats, t: window.splatBench.t, chunks: window.splatBench.net.chunks.size, mb: Math.round(window.splatBench.net.bytes/1048576), pager: window.splatBench.pagerState(), text: document.getElementById('stats').innerText})"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless=True, args=["--use-angle=d3d11", "--ignore-gpu-blocklist"])
    ctx = b.new_context(**p.devices["iPhone 13"]) if mobile else b.new_context(viewport={"width": 1400, "height": 860})
    pg = ctx.new_page()
    pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.add_init_script("localStorage.clear()")
    t0 = time.time()
    pg.goto(f"http://127.0.0.1:8770/?scene={scene}")
    pg.wait_for_function("window.splatBench?.t.firstFrame || document.querySelector('#loading.error')", timeout=600_000, polling=500)
    pg.wait_for_timeout(3000)
    res["wall_s"] = round(time.time() - t0, 1)
    res["loaded"] = pg.evaluate(STATE)
    pg.screenshot(path=str(out / f"{tag}_loaded.png"))
    if not mobile:
        for value in ["500000", "auto"]:
            pg.select_option("#budget", value); pg.wait_for_timeout(2500)
            res[f"budget_{value}"] = pg.evaluate(STATE)["drawn"]
        pg.fill("#scale", "0.5"); pg.dispatch_event("#scale", "input"); pg.wait_for_timeout(2500)
        res["auto_x0.5"] = pg.evaluate(STATE)["drawn"]
        pg.select_option("#budget", "custom"); pg.fill("#custom", "300000"); pg.dispatch_event("#custom", "change"); pg.wait_for_timeout(2500)
        res["custom_300k_x0.5"] = pg.evaluate(STATE)["drawn"]
        pg.screenshot(path=str(out / f"{tag}_custom.png"))
    else:
        res["joystick"] = pg.evaluate("!!document.getElementById('mobile-joystick') && getComputedStyle(document.getElementById('mobile-joystick')).display !== 'none'")
        pg.click("#hud-toggle"); pg.wait_for_timeout(400)
        res["loaded"]["text"] = pg.evaluate("document.getElementById('stats').innerText")
        pg.screenshot(path=str(out / f"{tag}_expanded.png"))

    res["errors"] = errors
    res["logs"] = logs[-12:]
    b.close()
(out / f"{tag}.json").write_text(json.dumps(res, indent=2))
print(json.dumps({k: v for k, v in res.items() if k != "logs"}, indent=2))
