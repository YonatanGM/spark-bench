"""Headless Chrome check of the bench app against the real scene files.
Usage: <python with playwright> tools/check_app.py [query] [--mobile] [--bench]
Writes screenshots + JSON to tools/check_out/."""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

out = Path(__file__).parent / "check_out"
out.mkdir(exist_ok=True)
query = next((a for a in sys.argv[1:] if not a.startswith("--")), "scene=garage")
mobile = "--mobile" in sys.argv
tag = query.replace("=", "-").replace("&", "_") + ("_mobile" if mobile else "")
url = f"http://127.0.0.1:8770/?{query}"
logs, errors = [], []

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless=True,
                                args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    if mobile:
        ctx = browser.new_context(**p.devices["iPhone 13"])
    else:
        ctx = browser.new_context(viewport={"width": 1400, "height": 860})
    page = ctx.new_page()
    page.on("console", lambda m: logs.append(f"{m.type}: {m.text}"))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("worker", lambda w: w.on("console", lambda m: logs.append(f"worker {m.type}: {m.text}")))
    t0 = time.time()
    page.goto(url)
    page.wait_for_function("window.sparkBench && (window.sparkBench.timing.firstFrame || document.querySelector('#loading.error'))", timeout=600_000, polling=500)
    page.wait_for_timeout(3000)
    result = {"url": url, "wall_s": round(time.time() - t0, 1), "errors": errors}
    result["report_initial"] = page.evaluate("window.sparkBench.buildReport()")
    page.screenshot(path=str(out / f"{tag}_loaded.png"))
    if not mobile:
        page.click("#hud-toggle") if page.evaluate("document.getElementById('hud').classList.contains('collapsed')") else None
        page.click("#settings-toggle")
        page.select_option("#budget-select", "500000")
        page.wait_for_timeout(2500)
        result["at_500k"] = page.evaluate("window.sparkBench.counts()")
        page.fill("#scale", "0.5"); page.dispatch_event("#scale", "input")
        page.wait_for_timeout(2500)
        result["at_500k_x0.5"] = page.evaluate("window.sparkBench.counts()")
        page.screenshot(path=str(out / f"{tag}_panel.png"))
        if page.evaluate("!document.getElementById('lod-enabled-wrap').hidden"):
            page.uncheck("#lod-enabled")
            page.wait_for_timeout(2500)
            result["lod_off"] = page.evaluate("window.sparkBench.counts()")
            page.check("#lod-enabled")
        page.select_option("#budget-select", "auto")
        page.fill("#scale", "1"); page.dispatch_event("#scale", "input")
        page.click("#panel-close")
        page.wait_for_timeout(1500)
    if "--bench" in sys.argv:
        page.evaluate("window.sparkBench.startBench()")
        page.wait_for_selector("#report[open]", timeout=60_000)
        page.wait_for_timeout(500)
        page.screenshot(path=str(out / f"{tag}_report.png"))
        result["bench"] = json.loads(page.input_value("#report-json"))["benchmark"]
    result["logs"] = logs[-40:]
    browser.close()

(out / f"{tag}.json").write_text(json.dumps(result, indent=2))
print(json.dumps({k: v for k, v in result.items() if k != "logs"}, indent=2)[:6000])
print("\n".join(result["logs"][-25:]))
