#!/usr/bin/env python3
"""Bring a web app from nucleo-webos into the web channel: apps/web/<id>/ (manifest + files/).

    python tools/import_web.py pdf-editor [--from ../nucleo-webos]

Reads, in nucleo-webos apps/<id>/:
  store.json              the store manifest (editions.cardputer is the min_os of this channel)
  manifest.json, www/     the payload, as the device serves it
  store/device-icon.txt   the 32 x 32 Cardputer launcher icon
Writes files/ fresh (an app's old files never linger) with deterministic .gz twins (gzip -9, no name,
mtime 0) next to every text file they make smaller: the Cardputer serves them, the browser gets fewer bytes.
Then run `python tools/store.py build` as for any app; nothing is signed here.
"""
import argparse
import gzip
import io
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TEXT_EXT = (".html", ".js", ".css", ".json", ".svg", ".txt", ".md")
SKIP = ("store.json", "caps.json")       # metadata of the source tree, not payload


def gz(data):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", compresslevel=9, mtime=0, fileobj=buf) as g:
        g.write(data)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("app")
    ap.add_argument("--from", dest="src", default=os.path.join(ROOT, "..", "nucleo-webos"))
    a = ap.parse_args()
    src = os.path.join(a.src, "apps", a.app)
    with open(os.path.join(src, "store.json"), encoding="utf-8") as f:
        sj = json.load(f)
    with open(os.path.join(src, "caps.json"), encoding="utf-8") as f:
        caps = json.load(f)
    if sj.get("id") != a.app or sj.get("kind") != "web":
        sys.exit(f"{src}/store.json: id must be {a.app} and kind web")
    min_os = (sj.get("editions") or {}).get("cardputer")
    if not min_os:
        sys.exit(f"{src}/store.json: editions.cardputer (the lowest Cardputer OS it runs on) is missing")
    m = {
        "id": a.app, "kind": "web", "version": sj["version"], "version_code": sj["version_code"], "min_os": min_os,
        "category": sj["category"], "name": sj["name"], "description": sj["description"], "author": sj["author"],
        "license": sj["license"], "source": f"https://github.com/indecenti/nucleo-webos/tree/main/apps/{a.app}",
        "permissions": sj.get("permissions", []),
    }
    if caps.get("requires"):
        m["requires"] = caps["requires"]

    dest = os.path.join(ROOT, "apps", "web", a.app)
    files = os.path.join(dest, "files")
    if os.path.isdir(files):
        shutil.rmtree(files)
    os.makedirs(files)
    with open(os.path.join(dest, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(m, indent=2, ensure_ascii=False) + "\n")

    payload = [("manifest.json", os.path.join(src, "manifest.json")),
               ("device-icon.txt", os.path.join(src, "store", "device-icon.txt"))]
    www = os.path.join(src, "www")
    for d, _, names in os.walk(www):
        for n in sorted(names):
            full = os.path.join(d, n)
            payload.append(("www/" + os.path.relpath(full, www).replace(os.sep, "/"), full))
    total = 0
    for rel, full in payload:
        if rel in SKIP or rel.endswith(".gz"):
            continue
        with open(full, "rb") as f:
            data = f.read()
        out = os.path.join(files, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as f:
            f.write(data)
        total += len(data)
        if rel.lower().endswith(TEXT_EXT) and rel != "device-icon.txt":
            z = gz(data)
            if len(z) < len(data):
                with open(out + ".gz", "wb") as f:
                    f.write(z)
                total += len(z)
    print(f"apps/web/{a.app}: {m['version']} (code {m['version_code']}), min_os {min_os}, {total} bytes with twins")


if __name__ == "__main__":
    main()
