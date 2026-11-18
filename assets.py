"""Prepare a local, offline UI from source and the current private manifest."""
import hashlib
import json
import os
import shutil
from tempfile import NamedTemporaryFile

from plotly.offline import get_plotlyjs

SCRIPTS = ("ephys_math.js", "ephys_session.js", "ephys_app.js", "ephys_library_ui.js")
COLLECTIONS = ("files", "groups", "series", "traces", "sweeps", "events")


def page_html(project, encoded):
    html = (project / "platform_template.html").read_text(encoding="utf8")
    for name in SCRIPTS:
        version = hashlib.sha256((project / name).read_bytes()).hexdigest()[:12]
        html = html.replace(f'src="{name}"', f'src="{name}?v={version}"')
    return html.replace("__PLATFORM_DATA__", encoded.replace("<", "\\u003c"))


def write_text(path, text):
    with NamedTemporaryFile(dir=path.parent, delete=False, mode="w", encoding="utf8") as temp:
        temp.write(text)
    os.replace(temp.name, path)


def prepare(project, out):
    out.mkdir(parents=True, exist_ok=True)
    manifest = out / "ephys_platform_data.json"
    if not manifest.exists():
        write_text(manifest, json.dumps({"meta": {}, **{key: [] for key in COLLECTIONS}}))
    for name in SCRIPTS:
        shutil.copyfile(project / name, out / name)
    write_text(out / "plotly.min.js", get_plotlyjs())
    write_text(out / "ephys_platform.html", page_html(project, manifest.read_text(encoding="utf8")))
