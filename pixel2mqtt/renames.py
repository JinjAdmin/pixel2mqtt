"""Remember what the user renamed, per display: {display id: {kind: {original name: current name}}} in
<data>/renames.json. The importer uses it so a re-import (even with overwrite) writes to the new name instead of
bringing the old one back, and the editor uses it to find a renamed animation's source scene."""
import json
import os
import pathlib
import threading


class Renames:
    def __init__(self, data_dir: pathlib.Path):
        self.path = data_dir / "renames.json"
        self.lock = threading.Lock()

    def _load(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self, d):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)

    def for_display(self, dev, kind):
        """{original name: current name}"""
        return dict(self._load().get(dev, {}).get(kind, {}))

    def original(self, dev, kind, name):
        for orig, cur in self.for_display(dev, kind).items():
            if cur == name:
                return orig
        return name

    def record(self, dev, kind, old, new):
        with self.lock:
            d = self._load()
            m = d.setdefault(dev, {}).setdefault(kind, {})
            orig = next((o for o, c in m.items() if c == old), old)
            if new == orig:
                m.pop(orig, None)
            else:
                m[orig] = new
            self._save(d)
