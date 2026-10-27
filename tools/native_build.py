#!/usr/bin/env python3
"""Build a native app (.nap) from NucleoOS source, reproducibly, and record where it came from.

    python tools/native_build.py <id> --firmware ../NucleoOs           build apps/native/<id>/files/app.nap
    python tools/native_build.py <id> --firmware ../NucleoOs --check   rebuild and compare (byte for byte)

The recipe is the "build" object of apps/native/<id>/manifest.json:

    "build": { "repo": "indecenti/NucleoOs", "commit": "<sha>", "register": "nucleo_register_constellations",
               "sources": ["firmware/components/nucleo_app/app_constellations.cpp"], "flags": 0, "ram": 0 }

The firmware checkout must be AT that commit with those sources and sdk/native/ unmodified, and configured
(`idf.py reconfigure` or a build: the compile flags come from its firmware/build/compile_commands.json, so
the module is compiled exactly like the firmware it runs on). The SDK (sdk/native/: nap.ld, the header with
the layout fingerprint, abi/v<N>.txt) comes from the same commit. Every import is checked against the ABI
level the manifest names; an import the firmware does not export fails here, not on a device.

--allow-dirty builds from a modified checkout for testing: the manifest then records "<sha>-dirty" and
`store.py` refuses to sign it. Spec of the format: docs/native-apps.md in NucleoOS.
"""
import argparse
import hashlib
import json
import os
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
NATIVE = os.path.join(ROOT, "apps", "native")
SHA_RE = re.compile(r"^[0-9a-f]{40}(-dirty)?$")
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
NAP_MAGIC = 0x3150414E
DROP_ARGS = {"-c", "-o", "-MD", "-MMD", "-MP"}
DROP_WITH_VALUE = {"-o", "-MF", "-MT", "-MQ"}


def fail(msg):
    print(f"native_build: {msg}", file=sys.stderr)
    sys.exit(1)


def git(fw, *args):
    r = subprocess.run(["git", "-C", fw, *args], capture_output=True, text=True)
    if r.returncode != 0:
        fail(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout.strip()


def toolchain(cmd0):
    """The Xtensa compiler of the firmware build, and its siblings."""
    d = os.path.dirname(cmd0)
    pre = os.path.basename(cmd0).replace("g++.exe", "").replace("gcc.exe", "").replace("g++", "").replace("gcc", "")
    ext = ".exe" if cmd0.endswith(".exe") else ""
    t = lambda n: os.path.join(d, pre + n + ext)
    return t("g++"), t("strip"), t("readelf")


def compile_entry(cc, fw, src):
    want = os.path.normcase(os.path.normpath(os.path.join(fw, src)))
    for e in cc:
        if os.path.normcase(os.path.normpath(e["file"])) == want:
            return e
    fail(f"{src}: not in firmware/build/compile_commands.json - configure the firmware build first")


def module_args(entry, fw, sdk_inc):
    """The firmware's own flags for this file, minus output/dep flags, plus what a module needs."""
    cmd = entry.get("arguments") or shlex.split(entry["command"].replace("\\", "/"), posix=True)
    out, skip = [], False
    for a in cmd[1:]:
        if skip:
            skip = False
            continue
        if a in DROP_WITH_VALUE:
            skip = True
            continue
        if a in DROP_ARGS or os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(entry["file"])):
            continue
        out.append(a)
    fwn = os.path.normpath(fw).replace("\\", "/")
    out += ["-fPIC", "-fvisibility=hidden", "-fno-common", "-DNAP_MODULE=1", "-I", sdk_inc,
            f"-ffile-prefix-map={fwn}=.", f"-fdebug-prefix-map={fwn}=."]
    return cmd[0], out


def run(cmd, cwd):
    with tempfile.NamedTemporaryFile("w", suffix=".rsp", delete=False) as rsp:   # Windows: 32 KB command lines
        rsp.write("\n".join('"%s"' % a.replace("\\", "/").replace('"', '\\"') for a in cmd[1:]))
    try:
        r = subprocess.run([cmd[0], "@" + rsp.name], cwd=cwd, capture_output=True, text=True)
    finally:
        os.unlink(rsp.name)
    if r.returncode != 0:
        fail(f"{os.path.basename(cmd[0])} failed:\n{r.stderr[-4000:]}")


def abi_names(fw, level):
    names = set()
    for v in range(1, level + 1):
        p = os.path.join(fw, "sdk", "native", "abi", f"v{v}.txt")
        if not os.path.isfile(p):
            fail(f"sdk/native/abi/v{v}.txt missing in the firmware checkout")
        for raw in open(p, encoding="utf-8"):
            line = raw.split("#")[0].strip()
            if line:
                names.add(line.split("=")[0].strip())
    return names


def inspect(readelf, nap, app_id, abi):
    """What store.py and the device both rely on, checked on the built file."""
    with open(nap, "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF" or data[4] != 1 or data[5] != 1 or struct.unpack_from("<HH", data, 16) != (3, 94):
        fail("not an ELF32 Xtensa shared object")
    loads = []
    for l in subprocess.run([readelf, "-l", "-W", nap], capture_output=True, text=True).stdout.splitlines():
        p = l.split()
        if p and p[0] in ("LOAD", "TLS", "INTERP"):
            if p[0] != "LOAD":
                fail(f"segment {p[0]} not allowed")
            loads.append((int(p[1], 16), int(p[2], 16), int(p[4], 16), int(p[5], 16), " ".join(p[6:-1])))
    if [x[4] for x in loads] != ["R E", "R", "RW"] or any(o != v for o, v, *_ in loads):
        fail(f"segment layout {loads}: not sdk/native/nap.ld's")
    at = data.find(struct.pack("<I", NAP_MAGIC), loads[1][0], loads[1][0] + loads[1][2])
    if at < 0:
        fail("no nucleo_native_info in rodata")
    _, info_abi, flags, layout, ram = struct.unpack_from("<IHHII", data, at)
    info_id = data[at + 16:at + 49].split(b"\0")[0].decode("ascii", "replace")
    if info_id != app_id or info_abi != abi:
        fail(f"nucleo_native_info says id {info_id!r} abi {info_abi}, manifest says {app_id!r} abi {abi}")
    return {"text": loads[0][3], "rodata": loads[1][3], "data": loads[2][3], "layout": f"{layout:08x}"}


def build(app_id, fw, allow_dirty, out_path):
    mpath = os.path.join(NATIVE, app_id, "manifest.json")
    if not os.path.isfile(mpath):
        fail(f"apps/native/{app_id}/manifest.json missing")
    m = json.load(open(mpath, encoding="utf-8"))
    b = m.get("build") or fail("manifest has no build recipe")
    # register / flags / ram end up in generated C++: only an identifier and integers, never text.
    if not isinstance(b.get("register"), str) or not IDENT_RE.match(b["register"]) or             not all(isinstance(b.get(k, 0), int) and 0 <= b.get(k, 0) <= 0xffffff for k in ("flags", "ram")):
        fail("build.register must be a C identifier, build.flags / build.ram integers")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,31}", app_id):
        fail("bad app id")
    abi = m.get("abi")
    if not isinstance(abi, int) or abi < 1:
        fail("manifest abi must be the ABI level (1, 2, ...)")
    fw = os.path.abspath(fw)
    head = git(fw, "rev-parse", "HEAD")
    paths = list(b["sources"]) + ["sdk/native"]
    dirty = bool(git(fw, "status", "--porcelain", "--", *paths))
    if dirty and not allow_dirty:
        fail(f"{', '.join(paths)} modified in {fw}: commit first (or --allow-dirty for a test build)")
    commit = head + ("-dirty" if dirty else "")

    ccp = os.path.join(fw, "firmware", "build", "compile_commands.json")
    if not os.path.isfile(ccp):
        fail("firmware/build/compile_commands.json missing: run idf.py reconfigure in the firmware checkout")
    cc = json.load(open(ccp, encoding="utf-8"))
    sdk = os.path.join(fw, "sdk", "native")
    sdk_inc = os.path.join(sdk, "include").replace("\\", "/")

    with tempfile.TemporaryDirectory(prefix="nap-") as tmp:
        objs, cxx, cxx_args = [], None, None
        for i, src in enumerate(b["sources"]):
            e = compile_entry(cc, fw, src)
            comp, args = module_args(e, fw, sdk_inc)
            if src.endswith((".cpp", ".cc")) and cxx is None:
                cxx, cxx_args, cxx_dir = comp, args, e["directory"]
            obj = os.path.join(tmp, f"{i}.o")
            run([comp, *args, "-c", os.path.join(fw, src), "-o", obj], e["directory"])
            objs.append(obj)
        if cxx is None:
            fail("at least one C++ source is needed (the entry glue is C++)")
        glue = os.path.join(tmp, "nap_main.cpp")
        with open(glue, "w", encoding="utf-8", newline="\n") as f:
            f.write('// Generated by tools/native_build.py: the two exports of the module.\n#include "nucleo_native.h"\n'
                    f'NUCLEO_NATIVE_APP_EX("{app_id}", {b["register"]}, {int(b.get("flags", 0))}u, {int(b.get("ram", 0))}u)\n')
        gobj = os.path.join(tmp, "glue.o")
        run([cxx, *cxx_args, "-c", glue, "-o", gobj], cxx_dir)
        gxx, strip, readelf = toolchain(cxx)
        so = os.path.join(tmp, "app.so")
        run([gxx, "-shared", "-nostdlib", "-Wl,--gc-sections", "-Wl,--hash-style=sysv", "-Wl,--build-id=none",
             "-Wl,-T," + os.path.join(sdk, "nap.ld").replace("\\", "/"), "-o", so, gobj, *objs], tmp)
        # Every import must be in the ABI the manifest names.
        allowed = abi_names(fw, abi)
        need = set()
        for l in subprocess.run([readelf, "--dyn-syms", "-W", so], capture_output=True, text=True).stdout.splitlines():
            p = l.split()
            if len(p) >= 8 and p[0].endswith(":") and p[6] == "UND" and p[7]:
                need.add(p[7].split("@")[0])
        missing = sorted(need - allowed)
        if missing:
            fail(f"imports outside ABI {abi}: {', '.join(missing[:12])}{' ...' if len(missing) > 12 else ''}")
        run([strip, "--strip-all", "-R", ".comment", "-o", out_path, so], tmp)
        facts = inspect(readelf, out_path, app_id, abi)
    return m, commit, head, need, facts


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("id")
    p.add_argument("--firmware", required=True, help="NucleoOS checkout at the recipe's commit, configured")
    p.add_argument("--check", action="store_true", help="rebuild and compare with the committed app.nap")
    p.add_argument("--allow-dirty", action="store_true", help="test build from a modified checkout (never signed)")
    p.add_argument("--update-commit", action="store_true", help="record the checkout's HEAD as the recipe commit")
    a = p.parse_args()
    nap = os.path.join(NATIVE, a.id, "files", "app.nap")
    out = nap + ".new" if a.check else nap
    os.makedirs(os.path.dirname(nap), exist_ok=True)
    m, commit, head, imports, facts = build(a.id, a.firmware, a.allow_dirty, out)
    rec = m["build"].get("commit", "")
    if a.check:
        same = os.path.isfile(nap) and open(nap, "rb").read() == open(out, "rb").read()
        os.unlink(out)
        base = rec.split("-")[0]
        if base != head:
            # A later checkout is fine when the recipe's commit is an ancestor and nothing the module is built
            # from (its sources, sdk/native) changed in between: same inputs, same bytes.
            paths = list(m["build"]["sources"]) + ["sdk/native"]
            anc = subprocess.run(["git", "-C", a.firmware, "merge-base", "--is-ancestor", base, head]).returncode == 0
            same = subprocess.run(["git", "-C", a.firmware, "diff", "--quiet", base, head, "--", *paths]).returncode == 0
            if not (anc and same):
                fail(f"the checkout is at {head}: the recipe's {base} is not an ancestor with the same sources")
        if not same:
            fail("the rebuilt module differs from the committed app.nap: not reproducible from its recipe")
        print(f"native_build: {a.id} reproduces byte for byte from {rec}")
        return
    if a.update_commit or not SHA_RE.match(rec) or rec.split("-")[0] != head or rec.endswith("-dirty") != commit.endswith("-dirty"):
        m["build"]["commit"] = commit
        with open(os.path.join(NATIVE, a.id, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(m, f, indent=2, ensure_ascii=False)
            f.write("\n")
    digest = hashlib.sha256(open(nap, "rb").read()).hexdigest()
    print(f"native_build: {a.id} from {commit}: {os.path.getsize(nap)} B (text {facts['text']} B, rodata {facts['rodata']} B, "
          f"RAM {facts['data']} B), {len(imports)} imports, layout {facts['layout']}, sha256 {digest[:16]}")


if __name__ == "__main__":
    main()
