"""Data-free smoke tests. HEKA_TEST_DAT optionally enables a local recording test."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np

from assets import prepare
from ephys_library import Library

SOURCE = Path(__file__).resolve().parent


class LibraryChecks(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.out = self.root / "outputs"
        prepare(SOURCE, self.out)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        self.library = Library(self.out, self.root)
        import shutil
        for path in [SOURCE / "platform_template.html", *SOURCE.glob("ephys_*.js")]:
            shutil.copy2(path, self.root)

    def update(self, folder):
        from uuid import uuid4
        self.library.job = {"id": uuid4().hex, "state": "running"}
        self.library._worker(str(folder))
        return self.library.status()

    def test_empty_and_failed_import(self):
        original = self.library.payload()
        self.assertEqual(original["files"], [])
        self.assertEqual(self.library.config()["folder"], "")
        self.assertEqual(self.library.scan(self.raw)["count"], 0)
        self.assertEqual(self.update(self.raw)["state"], "error")
        (self.raw / "invalid.DAT").write_bytes(b"invalid DAT")
        self.assertEqual(self.library.scan(self.raw)["new_count"], 1)
        self.assertEqual(self.update(self.raw)["state"], "error")
        self.assertEqual(self.library.payload(), original)
        self.assertNotIn("__PLATFORM_DATA__", (self.out / "ephys_platform.html").read_text(encoding="utf8"))

    @unittest.skipUnless(os.getenv("HEKA_TEST_DAT"), "optional private DAT not supplied")
    def test_import_and_reuse(self):
        import shutil
        source = Path(os.environ["HEKA_TEST_DAT"])
        shutil.copyfile(source, self.raw / "recording.dat")
        result = self.update(self.raw)
        self.assertEqual(result["state"], "done", result)
        catalog = self.library.payload()
        self.assertEqual(catalog["files"][0]["sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
        self.assertTrue(all(catalog[key] for key in ["groups","series","traces","sweeps"]))
        for sweep in catalog["sweeps"]:
            samples = np.load(self.out / sweep["raw_url"], allow_pickle=False)
            self.assertEqual(len(samples), sweep["n_samples"])
        self.assertTrue(self.update(self.raw)["unchanged"])
        self.assertEqual(self.library.payload(), catalog)


if __name__ == "__main__":
    unittest.main()
