#!/usr/bin/env python3
"""Security tests for tools/store.py: every attack below must be refused.

    python tools/test_store.py

Each test builds a throw-away store in a temp dir with throw-away keys (never the real ones).
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "store.py")
LANGS = ("it", "en", "es", "fr", "de")


def device_icon(seed):
    """A valid 32x32 pixel icon, different for every seed: a frame plus the seed's bits."""
    h = abs(hash(seed)) | 1
    rows = []
    for y in range(32):
        row = ""
        for x in range(32):
            on = x in (0, 31) or y in (0, 31) or (8 <= x < 24 and 8 <= y < 24 and (h >> ((x + y * 3) % 60)) & 1)
            row += "#" if on else "."
        rows.append(row)
    return ("\n".join(rows) + "\n").encode()


def manifest(app_id, code=1, **over):
    m = {"id": app_id, "kind": "web", "version": f"1.0.{code}", "version_code": code, "min_os": "0.7.0",
         "category": "tools", "name": {l: "Demo" for l in LANGS}, "description": {l: "A demo app" for l in LANGS},
         "author": "Test", "license": "MIT", "source": "https://example.org/demo", "permissions": []}
    m.update(over)
    return m


COMMIT = "0123456789abcdef0123456789abcdef01234567"


def native_manifest(app_id, code=1, **over):
    m = manifest(app_id, code, kind="native", category="games", abi=1,
                 build={"repo": "indecenti/NucleoOs", "commit": COMMIT, "register": "nucleo_register_demo",
                        "sources": ["firmware/components/nucleo_app/app_demo.cpp"]})
    m.update(over)
    return m


def fake_nap(app_id, abi=1):
    """Enough of a .nap for the store's checks (the firmware loader gate runs the real ones on real modules)."""
    elf = bytearray(b"\x7fELF\x01\x01\x01" + bytes(9) + struct.pack("<HHI", 3, 94, 1) + bytes(32))
    info = struct.pack("<IHHII", 0x3150414E, abi, 0, 0x12345678, 0) + app_id.encode().ljust(33, b"\0") + bytes(3)
    return bytes(elf) + bytes(64) + info + bytes(64)


class Store:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="cpstore-")
        self.home = tempfile.mkdtemp(prefix="cpkeys-")   # outside the store: keys never sit in the tree
        self.env = dict(os.environ, NUCLEO_STORE_ROOT=self.dir,
                        NUCLEO_CARDPUTER_STORE_KEY=os.path.join(self.home, "k.pem"),
                        NUCLEO_CARDPUTER_STORE_BACKUP_KEY=os.path.join(self.home, "kb.pem"))

    def run(self, *args, env=None):
        r = subprocess.run([sys.executable, TOOL, *args], env=env or self.env, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def ok(self, *args):
        code, out = self.run(*args)
        assert code == 0, out
        return out

    def native(self, app_id, files=None, **over):
        """A native app that passes the store's rules, with `files` added or replacing (None = remove)."""
        d = os.path.join(self.dir, "apps", "native", app_id)
        shutil.rmtree(os.path.join(d, "files"), ignore_errors=True)
        os.makedirs(os.path.join(d, "files"), exist_ok=True)
        with open(os.path.join(d, "manifest.json"), "w") as f:
            json.dump(native_manifest(app_id, **over), f)
        base = {"app.nap": fake_nap(app_id), "device-icon.txt": device_icon("n-" + app_id)}
        base.update(files or {})
        for rel, data in base.items():
            if data is not None:
                with open(os.path.join(d, "files", rel), "wb") as f:
                    f.write(data)

    def app(self, app_id, files, scaffold=True, **over):
        """A web app that passes every Cardputer rule, with `files` added or replacing (None = remove)."""
        d = os.path.join(self.dir, "apps", "web", app_id)
        shutil.rmtree(os.path.join(d, "files"), ignore_errors=True)
        os.makedirs(os.path.join(d, "files"), exist_ok=True)
        m = manifest(app_id, **over)
        with open(os.path.join(d, "manifest.json"), "w") as f:
            json.dump(m, f)
        base = {}
        if scaffold:
            base = {
                "manifest.json": json.dumps({"id": app_id, "runtime": "web", "web_route": f"/apps/{app_id}/",
                                             "icon": "icon.svg", "version": m.get("version", "1.0.1")}).encode(),
                "www/index.html": b"<h1 data-i18n='t'>t</h1>",
                "www/icon.svg": (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12"/>'
                                 f'<circle cx="32" cy="32" r="12"/><text x="8" y="60">{app_id}</text></svg>').encode(),
                **{f"www/i18n.{l}.json": json.dumps({"_lang": l, "t": "x"}).encode() for l in LANGS},
                "device-icon.txt": device_icon(app_id),
            }
        base.update(files)
        files = {k: v for k, v in base.items() if v is not None}
        for rel, data in files.items():
            p = os.path.join(d, "files", rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)

    def path(self, *p):
        return os.path.join(self.dir, *p)

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        shutil.rmtree(self.home, ignore_errors=True)


class T(unittest.TestCase):
    def setUp(self):
        self.s = Store()
        self.s.ok("keygen")
        self.s.ok("keygen", "--backup")

    def tearDown(self):
        self.s.close()

    def published(self):
        self.s.app("demo", {"www/index.html": b"<h1>hi</h1>"})
        self.s.ok("publish")

    def test_publish_and_verify(self):
        self.published()
        out = self.s.ok("verify")
        self.assertIn("1 app(s) in 2 channels", out)

    def test_tampered_payload_is_refused(self):
        self.published()
        with open(self.s.path("public", "web", "apps", "demo", "1", "www", "index.html"), "ab") as f:
            f.write(b"<script>evil()</script>")
        code, out = self.s.run("verify")
        self.assertNotEqual(code, 0)
        self.assertIn("does not match its signed hash", out)

    def test_extra_unsigned_file_is_refused(self):
        self.published()
        with open(self.s.path("public", "web", "apps", "demo", "1", "www", "evil.js"), "w") as f:
            f.write("x")
        self.assertNotEqual(self.s.run("verify")[0], 0)

    def test_tampered_catalog_is_refused(self):
        self.published()
        p = self.s.path("public", "web", "index.txt")
        with open(p) as f:
            t = f.read()
        with open(p, "w", newline="\n") as f:
            f.write(t.replace("serial 1", "serial 99"))
        code, out = self.s.run("verify")
        self.assertIn("BAD SIGNATURE", out)

    def test_foreign_key_is_refused(self):
        self.published()
        other = Store()
        try:
            other.ok("keygen")
            env = dict(self.s.env, NUCLEO_CARDPUTER_STORE_KEY=other.env["NUCLEO_CARDPUTER_STORE_KEY"])
            code, out = self.s.run("sign", env=env)
            self.assertNotEqual(code, 0)
            self.assertIn("not in keys/", out)
        finally:
            other.close()

    def test_backup_key_signatures_verify(self):
        self.s.app("demo", {"a.txt": b"1"})
        self.s.ok("build")
        env = dict(self.s.env, NUCLEO_CARDPUTER_STORE_KEY=self.s.env["NUCLEO_CARDPUTER_STORE_BACKUP_KEY"])
        self.assertEqual(self.s.run("sign", env=env)[0], 0)
        self.s.ok("verify")

    def test_published_version_is_immutable(self):
        self.published()
        self.s.app("demo", {"www/index.html": b"<h1>changed</h1>"})
        code, out = self.s.run("build")
        self.assertNotEqual(code, 0)
        self.assertIn("raise version_code", out)
        self.s.app("demo", {"www/index.html": b"<h1>changed</h1>"}, code=2)
        self.s.ok("publish")
        self.assertFalse(os.path.exists(self.s.path("public", "web", "apps", "demo", "1")))

    def test_serial_only_goes_up(self):
        self.published()
        self.s.ok("sign")
        with open(self.s.path("public", "web", "index.txt")) as f:
            self.assertIn("serial 2", f.read())

    def test_bad_paths_and_ids_are_refused(self):
        self.s.app("demo", {"..x/a": b"1"})
        self.assertNotEqual(self.s.run("build")[0], 0)
        shutil.rmtree(self.s.path("apps"))
        self.s.app("Bad_Id", {"a": b"1"})
        self.assertNotEqual(self.s.run("build")[0], 0)

    def test_secret_in_payload_is_refused(self):
        self.s.app("demo", {"a.pem": b"-----BEGIN " + b"PRIVATE KEY-----\nabc\n"})   # split: this file must not look like a key
        code, out = self.s.run("build")
        self.assertIn("secret", out)

    def test_manifest_rules(self):
        for over in ({"kind": "elf"}, {"version_code": 0}, {"category": "x"}, {"permissions": ["root"]},
                     {"name": {"en": "only one"}}, {"unknown": 1}, {"id": "other"}):
            shutil.rmtree(self.s.path("apps"), ignore_errors=True)
            self.s.app("demo", {"a": b"1"}, **over)
            self.assertNotEqual(self.s.run("build")[0], 0, over)

    # ── Cardputer rules ──
    def refused(self, files, why, app_id="demo", **over):
        shutil.rmtree(self.s.path("apps"), ignore_errors=True)
        self.s.app(app_id, files, **over)
        code, out = self.s.run("build")
        self.assertNotEqual(code, 0, f"accepted: {why}")
        self.assertIn("Cardputer rule", out, out)

    def test_rule_icon_is_required_and_its_own(self):
        self.refused({"www/icon.svg": None}, "no icon")
        self.refused({"www/icon.svg": b"<svg viewBox='0 0 64 32'><rect/><rect/><rect/></svg>"}, "not square")
        self.refused({"www/icon.svg": b"<svg viewBox='0 0 64 64'><script>x()</script><rect/><rect/></svg>"}, "script in icon")
        self.refused({"www/icon.svg": b"<svg viewBox='0 0 64 64' onload='x()'><rect/><rect/><rect/></svg>"}, "handler in icon")
        self.refused({"www/icon.svg": b"<svg viewBox='0 0 64 64'><image href='https://x/y.png'/><rect/><rect/></svg>"}, "remote image")
        self.refused({"www/icon.svg": b"<svg viewBox='0 0 64 64'></svg>"}, "empty icon")
        shutil.rmtree(self.s.path("apps"), ignore_errors=True)
        same = b"<svg viewBox='0 0 64 64'><rect/><circle/><path/></svg>"
        self.s.app("one", {"www/icon.svg": same})
        self.s.app("two", {"www/icon.svg": same})
        code, out = self.s.run("build")
        self.assertIn("same drawing", out)

    def test_rule_device_icon(self):
        self.refused({"device-icon.txt": None}, "no device icon")
        self.refused({"device-icon.txt": b"#" * 32 + b"\n"}, "one line")
        self.refused({"device-icon.txt": (("." * 32 + "\n") * 32).encode()}, "blank icon")
        self.refused({"device-icon.txt": (("#" * 32 + "\n") * 32).encode()}, "solid block")
        shutil.rmtree(self.s.path("apps"), ignore_errors=True)
        self.s.app("one", {"device-icon.txt": device_icon("same")})
        self.s.app("two", {"device-icon.txt": device_icon("same")})
        self.assertIn("same drawing", self.s.run("build")[1])

    def test_rule_offline_and_no_code_from_strings(self):
        self.refused({"www/index.html": b"<script src='https://cdn.example.org/x.js'></script>"}, "remote script")
        self.refused({"www/index.html": b"<link href='//fonts.example.org/f.css' rel=stylesheet>"}, "remote css")
        self.refused({"www/app.js": b"import x from 'https://esm.sh/x';"}, "remote import")
        self.refused({"www/app.js": b"fetch('https://api.example.org/data')"}, "remote fetch")
        self.refused({"www/app.js": b"eval(userText)"}, "eval")
        self.refused({"www/app.js": b"setTimeout('go()', 10)"}, "string timer")

    def test_rule_languages_and_structure(self):
        self.refused({"www/i18n.de.json": None}, "missing German")
        self.refused({"www/i18n.fr.json": b'{"_lang":"fr","other":"y"}'}, "different keys")
        self.refused({"www/index.html": None}, "no index.html")
        self.refused({"manifest.json": b'{"id":"demo","runtime":"web","web_route":"/apps/demo/","icon":"x.png","version":"1.0.1"}'}, "not its own icon")
        self.refused({"www/big.bin": b"0" * (3 * 1024 * 1024)}, "too big")

    # ── channels and native apps ──
    def test_native_app_publishes_in_its_own_channel(self):
        self.s.native("demo")
        self.s.app("webapp", {})
        self.s.ok("publish")
        with open(self.s.path("public", "native", "index.txt")) as f:
            t = f.read()
        self.assertIn("channel native\n", t)
        self.assertIn("\tnative\t", t)
        # field 15 the ABI level, field 16 the capabilities: a native module always needs the native loader
        self.assertTrue(t.rstrip("\n").endswith("\t1\tapps.nap"))
        with open(self.s.path("public", "web", "index.txt")) as f:
            w = f.read()
        self.assertIn("channel web\n", w)
        self.assertNotIn("\tnative\t", w)
        self.assertTrue(os.path.isfile(self.s.path("public", "native", "apps", "demo", "1", "app.nap")))

    def test_catalog_of_one_channel_is_refused_as_the_other(self):
        self.s.native("demo")
        self.s.app("webapp", {})
        self.s.ok("publish")
        for name in ("index.txt", "index.sig"):          # a signed catalog served at the other channel's URL
            shutil.copyfile(self.s.path("public", "web", name), self.s.path("public", "native", name))
        code, out = self.s.run("verify")
        self.assertNotEqual(code, 0)
        self.assertIn("another channel", out)

    def test_id_in_both_channels_is_refused(self):
        self.s.native("demo")
        self.s.app("demo", {})
        code, out = self.s.run("build")
        self.assertNotEqual(code, 0)
        self.assertIn("one channel", out)

    def test_kind_must_match_its_channel(self):
        self.s.native("demo", kind="web")
        self.assertNotEqual(self.s.run("build")[0], 0)
        shutil.rmtree(self.s.path("apps"))
        self.s.app("demo", {}, kind="native")
        self.assertNotEqual(self.s.run("build")[0], 0)

    def test_app_outside_a_channel_is_refused(self):
        os.makedirs(self.s.path("apps", "loose", "files"))
        code, out = self.s.run("build")
        self.assertNotEqual(code, 0)
        self.assertIn("outside a channel", out)

    def native_refused(self, why, files=None, **over):
        shutil.rmtree(self.s.path("apps"), ignore_errors=True)
        self.s.native("demo", files, **over)
        code, out = self.s.run("build")
        self.assertNotEqual(code, 0, f"accepted: {why}")
        return out

    def test_native_rules(self):
        self.assertIn("committed", self.native_refused("dirty test build", build=dict(native_manifest("demo")["build"], commit=COMMIT + "-dirty")))
        self.native_refused("no commit", build={"repo": "x", "sources": ["a.cpp"], "register": "r"})
        self.native_refused("source escapes the repo", build=dict(native_manifest("demo")["build"], sources=["../../etc/x.cpp"]))
        self.native_refused("abi missing", abi=0)
        self.native_refused("code injected through the recipe", build=dict(native_manifest("demo")["build"], register="f); system(\"x\"); (void"))
        self.assertIn("exactly", self.native_refused("extra file", {"extra.bin": b"x"}))
        self.native_refused("no module", {"app.nap": None})
        self.native_refused("not ELF", {"app.nap": b"MZ" + bytes(200)})
        self.assertIn("says id", self.native_refused("module of another app", {"app.nap": fake_nap("other")}))
        self.assertIn("says id", self.native_refused("module for another ABI", {"app.nap": fake_nap("demo", abi=2)}))
        self.native_refused("too big", {"app.nap": fake_nap("demo") + bytes(600 * 1024)})
        self.native_refused("no launcher icon", {"device-icon.txt": None})

    def test_keygen_never_overwrites(self):
        code, out = self.s.run("keygen")
        self.assertIn("refusing to overwrite", out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
