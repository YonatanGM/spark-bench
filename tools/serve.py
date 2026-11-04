"""Static server for local testing. Usage: python tools/serve.py [port] [--lan]
--lan binds 0.0.0.0 so phones on the same Wi-Fi can open http://<pc-ip>:<port>/
(WebGL works over plain http on a LAN IP; only some APIs need https)."""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(__file__).resolve().parent.parent
port = int(next((a for a in sys.argv[1:] if a.isdigit()), 8770))
host = "0.0.0.0" if "--lan" in sys.argv else "127.0.0.1"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


Handler.extensions_map.update({".wasm": "application/wasm", ".webp": "image/webp", ".rad": "application/octet-stream", ".radc": "application/octet-stream"})
print(f"Serving {root} on http://{host}:{port}/")
ThreadingHTTPServer((host, port), partial(Handler, directory=str(root))).serve_forever()
