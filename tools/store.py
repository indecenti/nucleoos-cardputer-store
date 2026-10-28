#!/usr/bin/env python3
"""NucleoOS Cardputer store: build, sign and verify the catalog and its packages.

The store is static files on GitHub Pages. The device (M5Stack Cardputer, ESP32-S3, ~18 KB free heap)
downloads a line-oriented catalog to its SD card, checks its signature by hashing it in chunks, then
reads it one line at a time - so the catalog can grow to any size without costing RAM.

Two channels, two separate signed catalogs, never mixed (the device asks which one first):

    native   apps that run ON the Cardputer: a .nap module built from NucleoOS source (tools/native_build.py)
    web      apps the Cardputer serves to a browser (kind web), and content packs (kind data)

    apps/<channel>/<id>/manifest.json        what an app is (schemas/manifest.schema.json)
    apps/<channel>/<id>/files/...            its payload, installed under /sd/apps/<id>/ on the device

    public/<channel>/index.txt               the catalog: header (with its channel) + one line per app
    public/<channel>/index.sig               ECDSA P-256 signature of the catalog
    public/<channel>/apps/<id>/<code>/...    one directory per published version: payload + package.sig

An id is unique across both channels: on the device both install into /sd/apps/<id>/.

Trust: ONLY a maintainer's offline key signs. CI (tools/store.py verify) checks every signature with the
public keys in keys/ and publishes; it holds no secret, so a compromised GitHub account cannot ship
software to devices. Formats: docs/format.md.

    python tools/store.py keygen [--backup]   one-time: create a signing key pair under ~/.nucleo/
    python tools/store.py build               validate apps/, write packages + the catalog into public/
    python tools/store.py sign                sign every unsigned/changed package and the catalog
    python tools/store.py verify              what CI runs: signatures, hashes, limits, no secrets
    python tools/store.py publish             build + sign + verify (the maintainer's one command)
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import sys
import time

ROOT = os.environ.get("NUCLEO_STORE_ROOT") or os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
APPS = os.path.join(ROOT, "apps")
PUBLIC = os.path.join(ROOT, "public")
KEYS = os.path.join(ROOT, "keys")

INDEX_MAGIC = "nucleoos-cardputer-index-v2"
PKG_MAGIC = "nucleoos-cardputer-pkg-v1"
SIG_MAGIC = "nucleoos-cardputer-sig-v1"
LANGS = ("it", "en", "es", "fr", "de")
KINDS = ("web", "data", "native")
CHANNELS = {"native": ("native",), "web": ("web", "data")}   # channel -> the kinds it carries
CATEGORIES = ("games", "tools", "media", "office", "learn", "network", "security", "system")
PERMISSIONS = ("net", "fs", "audio", "mic", "imu", "ir", "ble", "wifi", "gpio", "usb")

ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
# Capabilities an app needs (the NucleoOS web OS vocabulary, nucleo-webos contract/capabilities.json). The
# web OS store shows an app only on a device that has every one of them; a native module always needs the
# Cardputer's native loader, `apps.nap`.
CAP_RE = re.compile(r"^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$")
NATIVE_CAP = "apps.nap"
# nucleo-webos next to this repository: a web app's `requires` must match its caps.json there
WEBOS_APPS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "nucleo-webos", "apps")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
PATH_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*){0,3}$")
TEXT_RE = re.compile(r"^[\x20-\x7e]*$")    # the device fonts are ASCII; no tab, no pipe in fields
MAX_FILES = 64
MAX_FILE = 4 * 1024 * 1024
MAX_PACKAGE = 8 * 1024 * 1024
MAX_NAME = 24
MAX_DESC = 120
MAX_NATIVE_PACKAGE = 512 * 1024            # a .nap runs from a 252 KB flash scratch region; with its icon
NATIVE_FILES = {"app.nap", "device-icon.txt"}
# A native game's own es/fr/de text (tools/game-i18n packs from the same NucleoOS commit): all three or none.
NATIVE_I18N = {"i18n.es", "i18n.fr", "i18n.de"}
MAX_I18N_PACK = 12288                      # firmware game_text.cpp GT_MAX_PACK
COMMIT_RE = re.compile(r"^[0-9a-f]{40}(-dirty)?$")       # -dirty: a test build, refused at signing
SRC_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]*\.(?:c|cc|cpp)$")
INDEX_TTL_DAYS = 120                       # a catalog older than this is refused (anti-freeze)
SKIP = {"Thumbs.db", "desktop.ini", ".DS_Store"}
# A secret must never reach a public repo: refuse files that look like one.
SECRET_RE = re.compile(rb"-----BEGIN (EC |RSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}")


def fail(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── keys ──────────────────────────────────────────────────────────────────────
def key_path(backup=False):
    env = os.environ.get("NUCLEO_CARDPUTER_STORE_BACKUP_KEY" if backup else "NUCLEO_CARDPUTER_STORE_KEY")
    name = "cardputer-store-signing-backup-key.pem" if backup else "cardputer-store-signing-key.pem"
    return env or os.path.join(os.path.expanduser("~"), ".nucleo", name)


def crypto():
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.exceptions import InvalidSignature
    except ImportError:
        fail("this needs the 'cryptography' package: pip install cryptography")
    return hashes, serialization, ec, InvalidSignature


def key_id(pub):
    _, serialization, _, _ = crypto()
    der = pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(der).hexdigest()[:16]


def load_public_keys():
    """keys/*.pem -> {key id: public key}. The device has the same keys compiled in."""
    _, serialization, ec, _ = crypto()
    keys = {}
    if os.path.isdir(KEYS):
        for name in sorted(os.listdir(KEYS)):
            if name.endswith(".pem"):
                with open(os.path.join(KEYS, name), "rb") as f:
                    pub = serialization.load_pem_public_key(f.read())
                if not isinstance(pub, ec.EllipticCurvePublicKey) or pub.curve.name != "secp256r1":
                    fail(f"keys/{name}: not an ECDSA P-256 public key")
                keys[key_id(pub)] = pub
    return keys


def load_private_key():
    _, serialization, _, _ = crypto()
    path = key_path()
    if not os.path.isfile(path):
        fail(f"no signing key at {path} (run keygen, or set NUCLEO_CARDPUTER_STORE_KEY)")
    with open(path, "rb") as f:
        return serialization.load_pem_private_key(f.read(), password=None)


def cmd_keygen(args):
    _, serialization, ec, _ = crypto()
    path = key_path(args.backup)
    if os.path.exists(path):
        fail(f"{path} exists: refusing to overwrite a signing key")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    priv = ec.generate_private_key(ec.SECP256R1())
    pem = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    os.makedirs(KEYS, exist_ok=True)
    pub_name = "store-backup.pem" if args.backup else "store.pem"
    with open(os.path.join(KEYS, pub_name), "wb") as f:
        f.write(priv.public_key().public_bytes(serialization.Encoding.PEM,
                                               serialization.PublicFormat.SubjectPublicKeyInfo))
    print(f"private key: {path}  (back it up; never commit it)")
    print(f"public key:  keys/{pub_name}  key id {key_id(priv.public_key())}")
    if args.backup:
        print("move the private backup key to offline storage now; it is only for recovery.")


def sign_text(priv, text):
    hashes, _, ec, _ = crypto()
    sig = priv.sign(text.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    return f"key {key_id(priv.public_key())}\nsig {base64.b64encode(sig).decode()}\n"


def verify_text(text, sig_block, keys, what):
    """sig_block = 'key <id>\\nsig <b64>\\n'. Returns the key id that signed."""
    hashes, _, ec, InvalidSignature = crypto()
    m = re.fullmatch(r"key ([0-9a-f]{16})\nsig ([A-Za-z0-9+/=]+)\n", sig_block)
    if not m:
        fail(f"{what}: malformed signature block")
    kid, b64 = m.groups()
    if kid not in keys:
        fail(f"{what}: signed by unknown key {kid}")
    try:
        keys[kid].verify(base64.b64decode(b64), text.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        fail(f"{what}: BAD SIGNATURE")
    return kid


# ── manifests ─────────────────────────────────────────────────────────────────
def text_field(v, maxlen, where):
    if not isinstance(v, str) or not v.strip() or len(v) > maxlen or not TEXT_RE.match(v) or "|" in v:
        fail(f"{where}: must be 1-{maxlen} printable ASCII characters, no '|'")
    return v


def app_dir(ch, app_id):
    return os.path.join(APPS, ch, app_id)


def load_manifest(ch, app_id):
    where = f"apps/{ch}/{app_id}"
    d = app_dir(ch, app_id)
    path = os.path.join(d, "manifest.json")
    if not ID_RE.match(app_id):
        fail(f"{where}: id must match {ID_RE.pattern}")
    if not os.path.isfile(path):
        fail(f"{where}: no manifest.json")
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    allowed = {"id", "kind", "version", "version_code", "min_os", "category", "name", "description",
               "author", "license", "source", "permissions", "entry", "requires"}
    if ch == "native":
        allowed |= {"abi", "build"}
    extra = set(m) - allowed
    if extra:
        fail(f"{where}/manifest.json: unknown fields {sorted(extra)}")
    if m.get("id") != app_id:
        fail(f"{where}: manifest id must equal the folder name")
    if m.get("kind") not in CHANNELS[ch]:
        fail(f"{where}: kind must be one of {CHANNELS[ch]} in the {ch} channel")
    if ch == "native":
        if not isinstance(m.get("abi"), int) or not 1 <= m["abi"] <= 0xffff:
            fail(f"{where}: abi must be the ABI level the module was built for")
        b = m.get("build")
        need = {"repo", "commit", "sources", "register"}
        if not isinstance(b, dict) or not need <= set(b) or set(b) - need - {"flags", "ram"}:
            fail(f"{where}: build must be {{repo, commit, sources, register[, flags, ram]}} (tools/native_build.py)")
        if not isinstance(b["register"], str) or not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$", b["register"]) or                 not all(isinstance(b.get(k, 0), int) and 0 <= b.get(k, 0) <= 0xffffff for k in ("flags", "ram")):
            fail(f"{where}: build.register must be a C identifier, build.flags / build.ram integers")
        if not isinstance(b["sources"], list) or not b["sources"] or                 not all(isinstance(x, str) and SRC_RE.match(x) and ".." not in x.split("/") for x in b["sources"]):
            fail(f"{where}: build.sources must be source paths in the NucleoOS repository")
    for k in ("version", "min_os"):
        if not isinstance(m.get(k), str) or not VERSION_RE.match(m[k]):
            fail(f"{where}: {k} must look like 1.2.3")
    if not isinstance(m.get("version_code"), int) or not 1 <= m["version_code"] <= 2**31 - 1:
        fail(f"{where}: version_code must be a positive integer (it only ever goes up)")
    if m.get("category") not in CATEGORIES:
        fail(f"{where}: category must be one of {CATEGORIES}")
    for field, maxlen in (("name", MAX_NAME), ("description", MAX_DESC)):
        v = m.get(field)
        if not isinstance(v, dict) or set(v) != set(LANGS):
            fail(f"{where}: {field} needs exactly the languages {LANGS}")
        for lang in LANGS:
            text_field(v[lang], maxlen, f"{where}: {field}.{lang}")
    text_field(m.get("author"), 40, f"{where}: author")
    for k in ("license", "source"):
        text_field(m.get(k), 120, f"{where}: {k}")
    perms = m.get("permissions", [])
    if not isinstance(perms, list) or any(p not in PERMISSIONS for p in perms) or len(set(perms)) != len(perms):
        fail(f"{where}: permissions must be distinct values from {PERMISSIONS}")
    req = m.get("requires", [])
    if not isinstance(req, list) or len(req) > 16 or len(set(req)) != len(req) or \
            not all(isinstance(c, str) and CAP_RE.match(c) for c in req):
        fail(f"{where}: requires must be distinct capability names (nucleo-webos contract/capabilities.json)")
    caps_json = os.path.join(WEBOS_APPS, app_id, "caps.json")
    if ch == "web" and os.path.isfile(caps_json):
        with open(caps_json, encoding="utf-8") as fh:
            want = json.load(fh).get("requires", [])
        if sorted(req) != sorted(want):
            fail(f"{where}: requires {sorted(req)} differs from nucleo-webos apps/{app_id}/caps.json {sorted(want)}")
    if "entry" in m and (not isinstance(m["entry"], str) or not PATH_RE.match(m["entry"])):
        fail(f"{where}: entry must be a relative path inside files/")
    return m


def payload_files(ch, app_id):
    """Sorted [(relative path, absolute path)] of apps/<channel>/<id>/files, with every limit enforced."""
    base = os.path.join(app_dir(ch, app_id), "files")
    if not os.path.isdir(base):
        fail(f"apps/{ch}/{app_id}: no files/ directory")
    out, total = [], 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            if name in SKIP:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            if os.path.islink(full) or not PATH_RE.match(rel) or ".." in rel.split("/"):
                fail(f"apps/{ch}/{app_id}/files/{rel}: path not allowed")
            if rel.lower() in ("package.sig",):
                fail(f"apps/{ch}/{app_id}/files/{rel}: reserved name")
            size = os.path.getsize(full)
            if size > MAX_FILE:
                fail(f"apps/{ch}/{app_id}/files/{rel}: {size} B is over {MAX_FILE} B")
            with open(full, "rb") as f:
                if SECRET_RE.search(f.read()):
                    fail(f"apps/{ch}/{app_id}/files/{rel}: looks like it contains a secret")
            total += size
            out.append((rel, full))
    out.sort(key=lambda t: t[0].encode())
    if not out:
        fail(f"apps/{ch}/{app_id}: files/ is empty")
    if len(out) > MAX_FILES or total > MAX_PACKAGE:
        fail(f"apps/{ch}/{app_id}: {len(out)} files / {total} B over the limits ({MAX_FILES} / {MAX_PACKAGE} B)")
    return out


# ── Cardputer rules (docs/rules.md) ───────────────────────────────────────────
# Every app is checked against these when it is built AND when CI verifies the published tree: an app that
# breaks one never gets a package, whoever wrote it.
MAX_WEB_PACKAGE = 3 * 1024 * 1024          # served from SD to a browser: keep it small (a PDF engine fits)
MAX_ICON = 16 * 1024
TEXT_EXT = (".html", ".htm", ".js", ".mjs", ".css", ".json", ".svg", ".txt", ".md")
# Nothing may come from the Internet: a store app works offline and cannot pull unreviewed code.
REMOTE_RE = re.compile(rb"""(?:\b(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:https?:)?//)"""
                       rb"""|(?:\bfrom\s*["'](?:https?:)?//)|(?:\bimport\s*\(\s*["'](?:https?:)?//)"""
                       rb"""|(?:url\(\s*["']?(?:https?:)?//)|(?:@import\s+["']?(?:https?:)?//)"""
                       rb"""|(?:\b(?:fetch|EventSource|WebSocket|importScripts)\s*\(\s*["'`](?:https?|wss?):)""", re.I)
UNSAFE_RE = re.compile(rb"\beval\s*\(|\bnew\s+Function\s*\(|document\.write\s*\(|\bsetTimeout\s*\(\s*[\"'`]|\bsetInterval\s*\(\s*[\"'`]")
SVG_BAD_RE = re.compile(rb"<script|\bon[a-z]+\s*=|javascript:|<foreignObject|xlink:href\s*=\s*[\"'](?!#)|\bhref\s*=\s*[\"'](?!#)", re.I)
VIEWBOX_RE = re.compile(rb"""viewBox\s*=\s*["']\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*["']""")


def rule_fail(app_id, msg):
    fail(f"apps/{app_id}: Cardputer rule: {msg}")


DEVICE_ICON = "device-icon.txt"    # 32 x 32 pixel art for the Cardputer launcher: '#' on, '.' off


def device_icon_bits(path):
    """The 32 lines of a device icon, or None when it is not exactly 32 x 32 of '#' and '.'."""
    with open(path, encoding="ascii", errors="replace") as f:
        rows = [r.rstrip(chr(13)) for r in f.read().strip(chr(13) + chr(10)).split(chr(10))]
    if len(rows) != 32 or any(len(r) != 32 or set(r) - {"#", "."} for r in rows):
        return None
    return rows


def cardputer_rules(m, files):
    app_id = m["id"]
    rel = {r: full for r, full in files}
    # Every app, whatever its kind, has its own pixel icon for the Cardputer launcher.
    if DEVICE_ICON not in rel:
        rule_fail(app_id, f"files/{DEVICE_ICON} is missing: the launcher icon, 32 x 32 pixels of '#' and '.'")
    bits = device_icon_bits(rel[DEVICE_ICON])
    if bits is None:
        rule_fail(app_id, f"files/{DEVICE_ICON} must be exactly 32 lines of 32 '#' or '.' characters")
    on = sum(r.count("#") for r in bits)
    if on < 60 or on > 32 * 32 - 60:
        rule_fail(app_id, f"files/{DEVICE_ICON} has {on} pixels on: draw an icon, not a blank or a block")
    for och, other in all_apps():
        o = os.path.join(app_dir(och, other), "files", DEVICE_ICON)
        if other != app_id and os.path.isfile(o) and device_icon_bits(o) == bits:
            rule_fail(app_id, f"files/{DEVICE_ICON} is the same drawing as {other}'s")
    total = sum(os.path.getsize(full) for full in rel.values())
    for r, full in files:
        if r.lower().endswith(TEXT_EXT):
            with open(full, "rb") as f:
                data = f.read()
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                rule_fail(app_id, f"{r} is not UTF-8")
            hit = REMOTE_RE.search(data)
            if hit:
                rule_fail(app_id, f"{r} loads something from the Internet ({hit.group(0)[:40]!r}): store apps work offline")
            if not r.endswith((".json", ".svg", ".txt", ".md")) and UNSAFE_RE.search(data):
                rule_fail(app_id, f"{r} runs code from strings (eval / new Function / document.write / string timers)")
    if m["kind"] == "native":
        native_rules(m, rel, total)
    if m["kind"] == "web":
        if total > MAX_WEB_PACKAGE:
            rule_fail(app_id, f"web apps are at most {MAX_WEB_PACKAGE} B ({total} B)")
        for need in ("manifest.json", "www/index.html", "www/icon.svg"):
            if need not in rel:
                rule_fail(app_id, f"a web app needs files/{need}")
        with open(rel["manifest.json"], encoding="utf-8") as f:
            am = json.load(f)
        if am.get("id") != app_id or am.get("runtime") != "web" or am.get("web_route") != f"/apps/{app_id}/":
            rule_fail(app_id, f"files/manifest.json must say id {app_id}, runtime web, web_route /apps/{app_id}/")
        if am.get("icon") != "icon.svg":
            rule_fail(app_id, 'files/manifest.json must use its own drawn icon: "icon": "icon.svg"')
        if am.get("version") != m["version"]:
            rule_fail(app_id, "files/manifest.json version differs from the store manifest")
        # Its own icon: a square, self-contained SVG drawn for this app (not another app's).
        icon = rel["www/icon.svg"]
        with open(icon, "rb") as f:
            svg = f.read()
        if len(svg) > MAX_ICON or not svg.lstrip().startswith(b"<svg"):
            rule_fail(app_id, f"www/icon.svg must be an SVG of at most {MAX_ICON} B")
        vb = VIEWBOX_RE.search(svg)
        if not vb or vb.group(1) != vb.group(2):
            rule_fail(app_id, 'www/icon.svg needs a square viewBox="0 0 N N"')
        if SVG_BAD_RE.search(svg):
            rule_fail(app_id, "www/icon.svg must be plain drawing: no scripts, event handlers or external links")
        if svg.count(b"<") < 4:
            rule_fail(app_id, "www/icon.svg is too bare to be a drawn icon")
        for och, other in all_apps():
            o = os.path.join(app_dir(och, other), "files", "www", "icon.svg")
            if other != app_id and os.path.isfile(o) and sha256_file(o) == sha256_file(icon):
                rule_fail(app_id, f"www/icon.svg is the same drawing as {other}'s: every app has its own icon")
        # Every language, with the same keys.
        keys = None
        for lang in LANGS:
            p = f"www/i18n.{lang}.json"
            if p not in rel:
                rule_fail(app_id, f"files/{p} is missing: every app speaks it, en, es, fr, de")
            with open(rel[p], encoding="utf-8") as f:
                cat = {k for k in json.load(f) if not k.startswith("_")}
            if keys is None:
                keys = cat
            elif cat != keys:
                rule_fail(app_id, f"files/{p} has different keys from the others: {sorted(cat ^ keys)[:5]}")


def native_rules(m, rel, total):
    """A native package is its module and its launcher icon, nothing else; the module says what the manifest says."""
    app_id = m["id"]
    extra = set(rel) - NATIVE_FILES
    if not NATIVE_FILES <= set(rel) or (extra and extra != NATIVE_I18N):
        rule_fail(app_id, f"a native app ships exactly {sorted(NATIVE_FILES)}, plus all of {sorted(NATIVE_I18N)} "
                          f"or none (has {sorted(rel)})")
    for name in sorted(extra):
        with open(rel[name], "rb") as f:
            pk = f.read()
        if len(pk) < 6 or len(pk) > MAX_I18N_PACK or pk[:4] != b"GTX1" or pk[-1] != 0:
            rule_fail(app_id, f"{name} is not a game text pack (tools/game-i18n/build.mjs in NucleoOS)")
    if total > MAX_NATIVE_PACKAGE:
        rule_fail(app_id, f"native packages are at most {MAX_NATIVE_PACKAGE} B ({total} B)")
    commit = m["build"]["commit"]
    if not COMMIT_RE.match(commit) or commit.endswith("-dirty"):
        rule_fail(app_id, f"built from {commit!r}: only a module built from a committed NucleoOS source is published "
                          "(tools/native_build.py without --allow-dirty)")
    with open(rel["app.nap"], "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF" or data[4:6] != b"\x01\x01" or data[16:20] != b"\x03\x00\x5e\x00":
        rule_fail(app_id, "app.nap is not an Xtensa shared object (tools/native_build.py)")
    at = data.find(b"NAP1")
    if at < 0 or data.find(b"NAP1", at + 1) >= 0:
        rule_fail(app_id, "app.nap needs exactly one nucleo_native_info")
    abi = int.from_bytes(data[at + 4:at + 6], "little")
    info_id = data[at + 16:at + 49].split(b"\0")[0].decode("ascii", "replace")
    if info_id != app_id or abi != m["abi"]:
        rule_fail(app_id, f"app.nap says id {info_id!r} abi {abi}; the manifest says {app_id!r} abi {m['abi']}")


def package_text(m, files):
    """The exact signed text of a package (docs/format.md)."""
    lines = [PKG_MAGIC, m["id"], str(m["version_code"]), m["kind"]]
    lines += [f"{sha256_file(full)} {os.path.getsize(full)} {rel}" for rel, full in files]
    return "\n".join(lines) + "\n"


# ── build ─────────────────────────────────────────────────────────────────────
def app_ids(ch):
    d = os.path.join(APPS, ch)
    if not os.path.isdir(d):
        return []
    return sorted(x for x in os.listdir(d) if os.path.isdir(os.path.join(d, x)))


def all_apps():
    """(channel, id) of every app; an id may exist in one channel only (one /sd/apps/<id>/ on the device)."""
    out, seen = [], {}
    stray = sorted(x for x in (os.listdir(APPS) if os.path.isdir(APPS) else []) if x not in CHANNELS)
    if stray:
        fail(f"apps/: {stray} outside a channel - apps live in apps/native/ or apps/web/")
    for ch in CHANNELS:
        for app_id in app_ids(ch):
            if app_id in seen:
                fail(f"{app_id}: in both apps/{seen[app_id]}/ and apps/{ch}/ - an id belongs to one channel")
            seen[app_id] = ch
            out.append((ch, app_id))
    return out


def pub(ch, *p):
    return os.path.join(PUBLIC, ch, *p)


def pkg_dir(ch, m):
    return pub(ch, "apps", m["id"], str(m["version_code"]))


def cmd_build(args):
    """Copy each app's payload into public/<channel>/apps/<id>/<code>/ (only the current version is kept)."""
    all_apps()
    stray = sorted(x for x in (os.listdir(PUBLIC) if os.path.isdir(PUBLIC) else []) if x not in CHANNELS)
    for x in stray:                                    # the single-catalog layout before the channels
        full = os.path.join(PUBLIC, x)
        shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)
    for ch in CHANNELS:
        build_channel(ch)


def build_channel(ch):
    seen = set()
    for app_id in app_ids(ch):
        m = load_manifest(ch, app_id)
        files = payload_files(ch, app_id)
        cardputer_rules(m, files)
        dest = pkg_dir(ch, m)
        text = package_text(m, files)
        sig_path = os.path.join(dest, "package.sig")
        if os.path.isfile(sig_path):
            with open(sig_path, encoding="utf-8") as f:
                signed_body = f.read().split("--\n")[0]
            if signed_body != text:
                # Same version code, different bytes: a published version is immutable.
                fail(f"apps/{ch}/{app_id}: files changed but version_code {m['version_code']} is already "
                     "published - raise version_code (and version)")
        else:
            if os.path.isdir(dest):
                shutil.rmtree(dest)
            for rel, full in files:
                out = os.path.join(dest, rel)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                shutil.copyfile(full, out)
            with open(os.path.join(dest, "package.txt"), "w", encoding="utf-8", newline="\n") as f:
                f.write(text)   # unsigned until `sign`
        # Older versions of this app leave the site: devices only ever install the newest.
        root = pub(ch, "apps", app_id)
        for old in os.listdir(root):
            if old != str(m["version_code"]):
                shutil.rmtree(os.path.join(root, old))
        seen.add(app_id)
    apps_root = pub(ch, "apps")
    if os.path.isdir(apps_root):
        for gone in set(os.listdir(apps_root)) - seen:
            shutil.rmtree(os.path.join(apps_root, gone))
    print(f"{ch}: built {len(seen)} package(s) into public/{ch}/apps")


# ── sign ──────────────────────────────────────────────────────────────────────
def previous_dates(ch):
    """(id, version_code) -> the date that version was first published, from the current catalog."""
    out = {}
    path = pub(ch, "index.txt")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                p = line.rstrip("\n").split("\t")
                if p[0] == "app" and len(p) >= 13 and p[12].isdigit():
                    out[(p[1], p[3])] = int(p[12])
    return out


def index_line(m, sig_sha, size, updated):
    names = "|".join(m["name"][l] for l in LANGS)
    descs = "|".join(m["description"][l] for l in LANGS)
    fields = ["app", m["id"], m["kind"], str(m["version_code"]), m["version"], m["min_os"], m["category"],
              str(size), sig_sha, ",".join(m.get("permissions", [])) or "-", names, descs, str(updated), m["author"],
              str(m["abi"]) if m["kind"] == "native" else "-", ",".join(requires_of(m)) or "-"]
    return "\t".join(fields)


def requires_of(m):
    """The capabilities a device needs for this app, sorted; a native module also needs the native loader."""
    req = set(m.get("requires", []))
    if m["kind"] == "native":
        req.add(NATIVE_CAP)
    return sorted(req)


def read_serial(ch):
    path = pub(ch, "index.txt")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                if line.startswith("serial "):
                    return int(line.split()[1])
    return 0


def cmd_sign(args):
    priv = load_private_key()
    keys = load_public_keys()
    if key_id(priv.public_key()) not in keys:
        fail("the private key's public half is not in keys/: devices would reject everything it signs")
    all_apps()
    for ch in CHANNELS:
        sign_channel(ch, priv)


def sign_channel(ch, priv):
    lines = []
    dates = previous_dates(ch)
    today = int(time.time()) // 86400 * 86400          # day precision: the catalog does not leak signing times
    for app_id in app_ids(ch):
        m = load_manifest(ch, app_id)
        dest = pkg_dir(ch, m)
        unsigned = os.path.join(dest, "package.txt")
        sig_path = os.path.join(dest, "package.sig")
        if os.path.isfile(unsigned):
            with open(unsigned, encoding="utf-8") as f:
                text = f.read()
            if text != package_text(m, payload_files(ch, app_id)):
                fail(f"apps/{ch}/{app_id}: public/ is stale, run build first")
            with open(sig_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text + "--\n" + sign_text(priv, text))
            os.remove(unsigned)
            print(f"{ch}: signed {app_id} {m['version']} ({m['version_code']})")
        if not os.path.isfile(sig_path):
            fail(f"apps/{ch}/{app_id}: no package for version_code {m['version_code']}, run build first")
        size = sum(os.path.getsize(full) for _, full in payload_files(ch, app_id))
        updated = dates.get((app_id, str(m["version_code"])), today)
        lines.append(index_line(m, sha256_file(sig_path), size, updated))
    serial = read_serial(ch) + 1
    expires = int(time.time()) + INDEX_TTL_DAYS * 86400
    # The channel is inside the signed text: one channel's catalog can never be served as the other's.
    text = "\n".join([INDEX_MAGIC, f"channel {ch}", f"serial {serial}", f"expires {expires}", f"apps {len(lines)}"] + lines) + "\n"
    os.makedirs(pub(ch), exist_ok=True)
    with open(pub(ch, "index.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    with open(pub(ch, "index.sig"), "w", encoding="utf-8", newline="\n") as f:
        f.write(SIG_MAGIC + "\n" + sign_text(priv, text))
    print(f"{ch}: catalog serial {serial}, {len(lines)} app(s), valid until {time.strftime('%Y-%m-%d', time.gmtime(expires))}")


# ── verify (CI) ───────────────────────────────────────────────────────────────
def cmd_verify(args):
    keys = load_public_keys()
    if not keys:
        fail("keys/ has no public key")
    if len(keys) < 2:
        print("warning: only one public key in keys/ - add the backup key (keygen --backup)")
    # Nothing secret anywhere in the tree that gets published or committed.
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in (".git", "__pycache__")]
        for name in filenames:
            full = os.path.join(dirpath, name)
            if os.path.getsize(full) <= MAX_PACKAGE:
                with open(full, "rb") as f:
                    if SECRET_RE.search(f.read()):
                        fail(f"{os.path.relpath(full, ROOT)}: looks like a secret")
    all_apps()
    stray = sorted(x for x in (os.listdir(PUBLIC) if os.path.isdir(PUBLIC) else []) if x not in CHANNELS)
    if stray:
        fail(f"public/: {stray} outside a channel - run build")
    total = 0
    for ch in CHANNELS:
        total += verify_channel(ch, keys, args)
    import art_pack
    art_pack.check()
    print(f"ok: {total} app(s) in {len(CHANNELS)} channels, all signatures valid")


def verify_channel(ch, keys, args):
    idx_path, sig_path = pub(ch, "index.txt"), pub(ch, "index.sig")
    if not os.path.isfile(idx_path) or not os.path.isfile(sig_path):
        fail(f"public/{ch}/index.txt or index.sig missing")
    with open(idx_path, encoding="utf-8") as f:
        text = f.read()
    with open(sig_path, encoding="utf-8") as f:
        sig = f.read()
    if not sig.startswith(SIG_MAGIC + "\n"):
        fail(f"public/{ch}/index.sig: wrong magic")
    verify_text(text, sig[len(SIG_MAGIC) + 1:], keys, f"public/{ch}/index.txt")
    rows = text.rstrip("\n").split("\n")
    if rows[0] != INDEX_MAGIC or rows[1] != f"channel {ch}" or not rows[2].startswith("serial ") \
            or not rows[3].startswith("expires ") or not rows[4].startswith("apps "):
        fail(f"public/{ch}/index.txt: bad header (or another channel's catalog)")
    left = (int(rows[3].split()[1]) - time.time()) / 86400
    if left < 0:
        fail(f"public/{ch}/index.txt has expired: run sign")
    if left < getattr(args, "warn_days", 0):
        fail(f"public/{ch}/index.txt expires in {left:.0f} days: run sign and push")
    apps = rows[5:]
    if int(rows[4].split()[1]) != len(apps):
        fail(f"public/{ch}/index.txt: app count does not match")
    published = set()
    for row in apps:
        f = row.split("\t")
        # 15 fields until the catalog is signed again with `requires` (field 16): readers ignore extra fields
        if len(f) not in (15, 16) or f[0] != "app" or not f[12].isdigit() or f[2] not in CHANNELS[ch]:
            fail(f"public/{ch}/index.txt: bad line {row[:40]}")
        app_id, code, sig_sha = f[1], f[3], f[8]
        m = load_manifest(ch, app_id)
        cardputer_rules(m, payload_files(ch, app_id))
        if str(m["version_code"]) != code or f[14] != (str(m["abi"]) if m["kind"] == "native" else "-"):
            fail(f"{app_id}: catalog and manifest disagree on version_code / abi")
        if len(f) == 16 and f[15] != (",".join(requires_of(m)) or "-"):
            fail(f"{app_id}: catalog and manifest disagree on requires")
        pdir = pkg_dir(ch, m)
        psig = os.path.join(pdir, "package.sig")
        if not os.path.isfile(psig) or sha256_file(psig) != sig_sha:
            fail(f"{app_id}: package.sig missing or not the one the catalog names")
        with open(psig, encoding="utf-8") as fh:
            body, _, block = fh.read().partition("--\n")
        verify_text(body, block, keys, f"{app_id}/package.sig")
        if body != package_text(m, payload_files(ch, app_id)):
            fail(f"{app_id}: apps/{ch}/{app_id}/files differs from the signed package - rebuild and sign")
        # Every listed file is there with its hash; nothing unlisted is published.
        listed = set()
        for line in body.split("\n")[4:]:
            if not line:
                continue
            sha, size, rel = line.split(" ", 2)
            full = os.path.join(pdir, rel)
            if not os.path.isfile(full) or os.path.getsize(full) != int(size) or sha256_file(full) != sha:
                fail(f"{app_id}/{rel}: published file does not match its signed hash")
            listed.add(rel)
        for dirpath, _, filenames in os.walk(pdir):
            for name in filenames:
                rel = os.path.relpath(os.path.join(dirpath, name), pdir).replace(os.sep, "/")
                if rel != "package.sig" and rel not in listed:
                    fail(f"{app_id}/{rel}: published but not signed")
        published.add(app_id)
    if published != set(app_ids(ch)):
        fail(f"{ch}: apps without a catalog entry: {sorted(set(app_ids(ch)) - published)} - run publish")
    print(f"{ch}: catalog serial {rows[2].split()[1]}, {len(apps)} app(s)")
    return len(apps)


def cmd_firmware_keys(args):
    """The C table of trusted keys for the NucleoOS firmware (components/nucleo_store/store_keys.c)."""
    _, serialization, _, _ = crypto()
    keys = load_public_keys()
    if not keys:
        fail("keys/ has no public key")
    out = ["// GENERATED by `python tools/store.py firmware-keys` in indecenti/nucleoos-cardputer-store from its",
           "// keys/*.pem - do not edit. The store's public signing keys (main + backup) this firmware trusts.",
           '#include "store_verify.h"', "", "const st_key_t ST_KEYS[] = {"]
    for kid, pub in sorted(keys.items()):
        q = pub.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        rows = [", ".join(f"0x{b:02x}" for b in q[i:i + 13]) for i in range(0, len(q), 13)]
        out.append(f'    {{ "{kid}", {{')
        out += [f"        {r}," for r in rows]
        out.append("    } },")
    out += ["};", f"const int ST_NKEYS = {len(keys)};", ""]
    text = "\n".join(out)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        print(f"wrote {len(keys)} key(s) to {args.out}")
    else:
        sys.stdout.write(text)


def cmd_publish(args):
    cmd_build(args)
    cmd_sign(args)
    import art_pack                                    # the apps' colour icons (public/<ch>/art.bin + art.sig)
    art_pack.build()
    cmd_verify(args)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen")
    k.add_argument("--backup", action="store_true", help="create the offline backup key pair")
    for name in ("build", "sign", "publish"):
        sub.add_parser(name)
    fk = sub.add_parser("firmware-keys")
    fk.add_argument("--out", help="write the C file here (default: stdout)")
    v = sub.add_parser("verify")
    v.add_argument("--warn-days", type=int, default=0, help="fail if the catalog expires within N days")
    args = p.parse_args()
    {"keygen": cmd_keygen, "build": cmd_build, "sign": cmd_sign, "verify": cmd_verify,
     "publish": cmd_publish, "firmware-keys": cmd_firmware_keys}[args.cmd](args)


if __name__ == "__main__":
    main()
