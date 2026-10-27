#!/usr/bin/env python3
"""NucleoOS Cardputer store: build, sign and verify the catalog and its packages.

The store is static files on GitHub Pages. The device (M5Stack Cardputer, ESP32-S3, ~18 KB free heap)
downloads a line-oriented catalog to its SD card, checks its signature by hashing it in chunks, then
reads it one line at a time - so the catalog can grow to any size without costing RAM.

    apps/<id>/manifest.json       what an app is (schemas/manifest.schema.json)
    apps/<id>/files/...           its payload, installed under /sd/apps/<id>/ on the device

    public/index.txt              the catalog: header + one tab-separated line per app
    public/index.sig              ECDSA P-256 signature of the catalog
    public/apps/<id>/<code>/...   one directory per published version: payload + package.sig

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

INDEX_MAGIC = "nucleoos-cardputer-index-v1"
PKG_MAGIC = "nucleoos-cardputer-pkg-v1"
SIG_MAGIC = "nucleoos-cardputer-sig-v1"
LANGS = ("it", "en", "es", "fr", "de")
KINDS = ("web", "data", "native")         # native = flash-XIP games, accepted only by a firmware that says so
CATEGORIES = ("games", "tools", "media", "office", "learn", "network", "security", "system")
PERMISSIONS = ("net", "fs", "audio", "mic", "imu", "ir", "ble", "wifi", "gpio", "usb")

ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
PATH_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*){0,3}$")
TEXT_RE = re.compile(r"^[\x20-\x7e]*$")    # the device fonts are ASCII; no tab, no pipe in fields
MAX_FILES = 64
MAX_FILE = 4 * 1024 * 1024
MAX_PACKAGE = 8 * 1024 * 1024
MAX_NAME = 24
MAX_DESC = 120
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


def load_manifest(app_id):
    d = os.path.join(APPS, app_id)
    path = os.path.join(d, "manifest.json")
    if not ID_RE.match(app_id):
        fail(f"apps/{app_id}: id must match {ID_RE.pattern}")
    if not os.path.isfile(path):
        fail(f"apps/{app_id}: no manifest.json")
    with open(path, encoding="utf-8") as f:
        m = json.load(f)
    allowed = {"id", "kind", "version", "version_code", "min_os", "category", "name", "description",
               "author", "license", "source", "permissions", "entry"}
    extra = set(m) - allowed
    if extra:
        fail(f"apps/{app_id}/manifest.json: unknown fields {sorted(extra)}")
    if m.get("id") != app_id:
        fail(f"apps/{app_id}: manifest id must equal the folder name")
    if m.get("kind") not in KINDS:
        fail(f"apps/{app_id}: kind must be one of {KINDS}")
    for k in ("version", "min_os"):
        if not isinstance(m.get(k), str) or not VERSION_RE.match(m[k]):
            fail(f"apps/{app_id}: {k} must look like 1.2.3")
    if not isinstance(m.get("version_code"), int) or not 1 <= m["version_code"] <= 2**31 - 1:
        fail(f"apps/{app_id}: version_code must be a positive integer (it only ever goes up)")
    if m.get("category") not in CATEGORIES:
        fail(f"apps/{app_id}: category must be one of {CATEGORIES}")
    for field, maxlen in (("name", MAX_NAME), ("description", MAX_DESC)):
        v = m.get(field)
        if not isinstance(v, dict) or set(v) != set(LANGS):
            fail(f"apps/{app_id}: {field} needs exactly the languages {LANGS}")
        for lang in LANGS:
            text_field(v[lang], maxlen, f"apps/{app_id}: {field}.{lang}")
    for k in ("author", "license", "source"):
        text_field(m.get(k), 120, f"apps/{app_id}: {k}")
    perms = m.get("permissions", [])
    if not isinstance(perms, list) or any(p not in PERMISSIONS for p in perms) or len(set(perms)) != len(perms):
        fail(f"apps/{app_id}: permissions must be distinct values from {PERMISSIONS}")
    if "entry" in m and (not isinstance(m["entry"], str) or not PATH_RE.match(m["entry"])):
        fail(f"apps/{app_id}: entry must be a relative path inside files/")
    return m


def payload_files(app_id):
    """Sorted [(relative path, absolute path)] of apps/<id>/files, with every limit enforced."""
    base = os.path.join(APPS, app_id, "files")
    if not os.path.isdir(base):
        fail(f"apps/{app_id}: no files/ directory")
    out, total = [], 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames.sort()
        for name in sorted(filenames):
            if name in SKIP:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            if os.path.islink(full) or not PATH_RE.match(rel) or ".." in rel.split("/"):
                fail(f"apps/{app_id}/files/{rel}: path not allowed")
            if rel.lower() in ("package.sig",):
                fail(f"apps/{app_id}/files/{rel}: reserved name")
            size = os.path.getsize(full)
            if size > MAX_FILE:
                fail(f"apps/{app_id}/files/{rel}: {size} B is over {MAX_FILE} B")
            with open(full, "rb") as f:
                if SECRET_RE.search(f.read()):
                    fail(f"apps/{app_id}/files/{rel}: looks like it contains a secret")
            total += size
            out.append((rel, full))
    out.sort(key=lambda t: t[0].encode())
    if not out:
        fail(f"apps/{app_id}: files/ is empty")
    if len(out) > MAX_FILES or total > MAX_PACKAGE:
        fail(f"apps/{app_id}: {len(out)} files / {total} B over the limits ({MAX_FILES} / {MAX_PACKAGE} B)")
    return out


def package_text(m, files):
    """The exact signed text of a package (docs/format.md)."""
    lines = [PKG_MAGIC, m["id"], str(m["version_code"]), m["kind"]]
    lines += [f"{sha256_file(full)} {os.path.getsize(full)} {rel}" for rel, full in files]
    return "\n".join(lines) + "\n"


# ── build ─────────────────────────────────────────────────────────────────────
def app_ids():
    if not os.path.isdir(APPS):
        return []
    return sorted(d for d in os.listdir(APPS) if os.path.isdir(os.path.join(APPS, d)))


def pkg_dir(m):
    return os.path.join(PUBLIC, "apps", m["id"], str(m["version_code"]))


def cmd_build(args):
    """Copy each app's payload into public/apps/<id>/<code>/ (only the current version is kept)."""
    seen = set()
    for app_id in app_ids():
        m = load_manifest(app_id)
        files = payload_files(app_id)
        dest = pkg_dir(m)
        text = package_text(m, files)
        sig_path = os.path.join(dest, "package.sig")
        if os.path.isfile(sig_path):
            with open(sig_path, encoding="utf-8") as f:
                signed_body = f.read().split("--\n")[0]
            if signed_body != text:
                # Same version code, different bytes: a published version is immutable.
                fail(f"apps/{app_id}: files changed but version_code {m['version_code']} is already "
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
        root = os.path.join(PUBLIC, "apps", app_id)
        for old in os.listdir(root):
            if old != str(m["version_code"]):
                shutil.rmtree(os.path.join(root, old))
        seen.add(app_id)
    apps_root = os.path.join(PUBLIC, "apps")
    if os.path.isdir(apps_root):
        for gone in set(os.listdir(apps_root)) - seen:
            shutil.rmtree(os.path.join(apps_root, gone))
    print(f"built {len(seen)} package(s) into public/apps")


# ── sign ──────────────────────────────────────────────────────────────────────
def index_line(m, sig_sha, size):
    names = "|".join(m["name"][l] for l in LANGS)
    descs = "|".join(m["description"][l] for l in LANGS)
    fields = ["app", m["id"], m["kind"], str(m["version_code"]), m["version"], m["min_os"], m["category"],
              str(size), sig_sha, ",".join(m.get("permissions", [])) or "-", names, descs]
    return "\t".join(fields)


def read_serial():
    path = os.path.join(PUBLIC, "index.txt")
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
    lines = []
    for app_id in app_ids():
        m = load_manifest(app_id)
        dest = pkg_dir(m)
        unsigned = os.path.join(dest, "package.txt")
        sig_path = os.path.join(dest, "package.sig")
        if os.path.isfile(unsigned):
            with open(unsigned, encoding="utf-8") as f:
                text = f.read()
            if text != package_text(m, payload_files(app_id)):
                fail(f"apps/{app_id}: public/ is stale, run build first")
            with open(sig_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text + "--\n" + sign_text(priv, text))
            os.remove(unsigned)
            print(f"signed {app_id} {m['version']} ({m['version_code']})")
        if not os.path.isfile(sig_path):
            fail(f"apps/{app_id}: no package for version_code {m['version_code']}, run build first")
        size = sum(os.path.getsize(full) for _, full in payload_files(app_id))
        lines.append(index_line(m, sha256_file(sig_path), size))
    serial = read_serial() + 1
    expires = int(time.time()) + INDEX_TTL_DAYS * 86400
    text = "\n".join([INDEX_MAGIC, f"serial {serial}", f"expires {expires}", f"apps {len(lines)}"] + lines) + "\n"
    os.makedirs(PUBLIC, exist_ok=True)
    with open(os.path.join(PUBLIC, "index.txt"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    with open(os.path.join(PUBLIC, "index.sig"), "w", encoding="utf-8", newline="\n") as f:
        f.write(SIG_MAGIC + "\n" + sign_text(priv, text))
    print(f"catalog serial {serial}, {len(lines)} app(s), valid until {time.strftime('%Y-%m-%d', time.gmtime(expires))}")


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
    idx_path, sig_path = os.path.join(PUBLIC, "index.txt"), os.path.join(PUBLIC, "index.sig")
    if not os.path.isfile(idx_path) or not os.path.isfile(sig_path):
        fail("public/index.txt or index.sig missing")
    with open(idx_path, encoding="utf-8") as f:
        text = f.read()
    with open(sig_path, encoding="utf-8") as f:
        sig = f.read()
    if not sig.startswith(SIG_MAGIC + "\n"):
        fail("public/index.sig: wrong magic")
    verify_text(text, sig[len(SIG_MAGIC) + 1:], keys, "public/index.txt")
    rows = text.rstrip("\n").split("\n")
    if rows[0] != INDEX_MAGIC or not rows[1].startswith("serial ") or not rows[2].startswith("expires ") \
            or not rows[3].startswith("apps "):
        fail("public/index.txt: bad header")
    left = (int(rows[2].split()[1]) - time.time()) / 86400
    if left < 0:
        fail("public/index.txt has expired: run sign")
    if left < getattr(args, "warn_days", 0):
        fail(f"public/index.txt expires in {left:.0f} days: run sign and push")
    apps = rows[4:]
    if int(rows[3].split()[1]) != len(apps):
        fail("public/index.txt: app count does not match")
    published = set()
    for row in apps:
        f = row.split("\t")
        if len(f) != 12 or f[0] != "app":
            fail(f"public/index.txt: bad line {row[:40]}")
        app_id, code, sig_sha = f[1], f[3], f[8]
        m = load_manifest(app_id)
        if str(m["version_code"]) != code:
            fail(f"{app_id}: catalog and manifest disagree on version_code")
        pdir = pkg_dir(m)
        psig = os.path.join(pdir, "package.sig")
        if not os.path.isfile(psig) or sha256_file(psig) != sig_sha:
            fail(f"{app_id}: package.sig missing or not the one the catalog names")
        with open(psig, encoding="utf-8") as fh:
            body, _, block = fh.read().partition("--\n")
        verify_text(body, block, keys, f"{app_id}/package.sig")
        if body != package_text(m, payload_files(app_id)):
            fail(f"{app_id}: apps/{app_id}/files differs from the signed package - rebuild and sign")
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
    if published != set(app_ids()):
        fail(f"apps without a catalog entry: {sorted(set(app_ids()) - published)} - run publish")
    print(f"ok: catalog serial {rows[1].split()[1]}, {len(apps)} app(s), all signatures valid")


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
