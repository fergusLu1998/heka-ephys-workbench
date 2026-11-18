"""Open this checkout's local workbench, reusing its server if available."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
INSTANCE = hashlib.sha256(str(ROOT).encode()).hexdigest()


def service(base):
    try:
        with urllib.request.urlopen(base + "/api/library/config", timeout=1) as response:
            return json.load(response).get("instance", "occupied")
    except urllib.error.HTTPError:
        return "occupied"
    except (ValueError, AttributeError):
        return "occupied"
    except OSError:
        return None


def main():
    for port in range(8765, 8776):
        base = f"http://127.0.0.1:{port}"
        running = service(base)
        if running is None:
            proc = subprocess.Popen([sys.executable, str(ROOT / "serve_platform.py"), "--port", str(port)],
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for _ in range(150):
                running = service(base)
                if running or proc.poll() is not None:
                    break
                time.sleep(.1)
            if proc.poll() is not None and not running:
                raise SystemExit("Startup failed. Install requirements.txt, then run serve_platform.py for details.")
        if running == INSTANCE:
            url = base + "/ephys_platform.html"
            print(url)
            webbrowser.open(url)
            return
    raise SystemExit("No local port available. Specify a port with serve_platform.py --port PORT.")


if __name__ == "__main__":
    main()
