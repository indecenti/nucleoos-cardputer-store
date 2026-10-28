#!/usr/bin/env python3
"""Store art: pack each channel's colour app icons into public/<channel>/art.bin and sign it (art.sig).

Sources: apps/<channel>/<id>/store-icon.png (a square painting, >= 256 px: tools/art/icons_paint.py) and
art/channels/<native|web>.png (the two stores' own icons, packed in both channels as "@native" / "@web").
An app without a store-icon.png simply has no entry: the device draws its fallback tile.

art.bin (format 1, read by NucleoOS nucleo_store/store_engine.c st_art_find): "NART", version 1, icon size (px),
count (u16 LE), channel (8 B, NUL-padded); count entries of 40 B (id NUL-padded to 36 B, pixel offset u32 LE);
then each icon, SIZE x SIZE RGB565 little-endian, row by row. Raw on purpose: the Cardputer draws an icon one row
at a time straight from the SD card (96 B of RAM), with no decoder and no image in memory.

art.sig is the catalog's signature format over the exact bytes of art.bin. Only the device's Store reads them
(older firmware and the web shells never ask), and a missing or bad pack only means the fallback tiles.

    python tools/art_pack.py            build + sign both channels (store.py publish runs it)
    python tools/art_pack.py --check    verify the published packs against the sources and the keys
"""
import argparse
import hashlib
import io
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import store  # noqa: E402

SIZE = 48
ENTRY = 40
CH_ICONS = os.path.join(store.ROOT, "art", "channels")


def rgb565(img):
    from PIL import Image
    im = img.convert("RGB")
    w, h = im.size
    s = min(w, h)                                   # centre square
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    out = bytearray()
    raw = im.tobytes()
    for i in range(0, len(raw), 3):
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        out += struct.pack("<H", (r >> 3) << 11 | (g >> 2) << 5 | b >> 3)
    return bytes(out)


def sources(ch, check_size=True):
    items = []
    for app_id in store.app_ids(ch):
        p = os.path.join(store.app_dir(ch, app_id), "store-icon.png")
        if os.path.isfile(p):
            items.append((app_id, p))
    for name in ("native", "web"):
        p = os.path.join(CH_ICONS, f"{name}.png")
        if os.path.isfile(p):
            items.append((f"@{name}", p))
    if not check_size:
        return items
    from PIL import Image
    for app_id, p in items:
        with Image.open(p) as im:
            if im.width < 128 or abs(im.width - im.height) > 2:
                store.fail(f"{p}: a store icon is a square of at least 128 px")
    return items


def pack(ch):
    items = sources(ch)
    if items:
        from PIL import Image                          # only when there is something to draw (CI publishes none)
    head = b"NART" + bytes([1, SIZE]) + struct.pack("<H", len(items)) + ch.encode().ljust(8, b"\0")[:8]
    table, data = bytearray(), bytearray()
    base = len(head) + ENTRY * len(items)
    for app_id, p in items:
        with Image.open(p) as im:
            px = rgb565(im)
        table += app_id.encode("ascii").ljust(ENTRY - 4, b"\0") + struct.pack("<I", base + len(data))
        data += px
    return head + bytes(table) + bytes(data), [i for i, _ in items]


def sig_block(priv, data):
    # store.sign_text signs UTF-8 text; art.bin is binary, so the same ECDSA P-256 / SHA-256 over its bytes.
    import base64
    hashes, _, ec, _ = store.crypto()
    sig = priv.sign(data, ec.ECDSA(hashes.SHA256()))
    return f"{store.SIG_MAGIC}\nkey {store.key_id(priv.public_key())}\nsig {base64.b64encode(sig).decode()}\n"


def build(sign=True):
    priv = store.load_private_key() if sign else None
    for ch in store.CHANNELS:
        data, ids = pack(ch)
        d = os.path.join(store.PUBLIC, ch)
        os.makedirs(d, exist_ok=True)
        art, sig = os.path.join(d, "art.bin"), os.path.join(d, "art.sig")
        old = open(art, "rb").read() if os.path.isfile(art) else None
        if old == data and os.path.isfile(sig):
            print(f"{ch}: art unchanged ({len(ids)} icons)")
            continue
        with open(art, "wb") as f:
            f.write(data)
        if priv:
            with open(sig, "w", encoding="utf-8", newline="\n") as f:
                f.write(sig_block(priv, data))
        print(f"{ch}: art {len(data)} B, {len(ids)} icons ({', '.join(ids)})" + ("" if priv else " - UNSIGNED"))


def check():
    import base64, re
    hashes, _, ec, InvalidSignature = store.crypto()
    keys = store.load_public_keys()
    for ch in store.CHANNELS:
        d = os.path.join(store.PUBLIC, ch)
        art, sig = os.path.join(d, "art.bin"), os.path.join(d, "art.sig")
        if not os.path.isfile(art):
            print(f"{ch}: no art")
            continue
        data = open(art, "rb").read()
        # Structure, and the same icons as the sources (by id; pixels are not re-derived here, so verify needs no
        # Pillow and no particular Pillow version): every entry in bounds, nothing after the last icon.
        if data[:6] != b"NART" + bytes([1, SIZE]):
            store.fail(f"public/{ch}/art.bin: not an art pack (format 1, {SIZE} px)")
        n = struct.unpack_from("<H", data, 6)[0]
        ids = []
        for i in range(n):
            e = data[16 + i * ENTRY:16 + (i + 1) * ENTRY]
            ids.append(e[:ENTRY - 4].rstrip(bytes(1)).decode("ascii"))
            off = struct.unpack_from("<I", e, ENTRY - 4)[0]
            if off != 16 + n * ENTRY + i * SIZE * SIZE * 2:
                store.fail(f"public/{ch}/art.bin: entry {ids[-1]} out of place")
        if len(data) != 16 + n * ENTRY + n * SIZE * SIZE * 2:
            store.fail(f"public/{ch}/art.bin: wrong size")
        want = [i for i, _ in sources(ch, check_size=False)]
        if ids != want:
            store.fail(f"public/{ch}/art.bin has {ids}, the sources {want}: run tools/art_pack.py")
        m = re.fullmatch(store.SIG_MAGIC + r"\nkey ([0-9a-f]{16})\nsig ([A-Za-z0-9+/=]+)\n", open(sig, encoding="utf-8").read())
        if not m or m.group(1) not in keys:
            store.fail(f"public/{ch}/art.sig: malformed or unknown key")
        try:
            keys[m.group(1)].verify(base64.b64decode(m.group(2)), data, ec.ECDSA(hashes.SHA256()))
        except InvalidSignature:
            store.fail(f"public/{ch}/art.bin: BAD SIGNATURE")
        print(f"{ch}: art ok ({len(data)} B, sha256 {hashlib.sha256(data).hexdigest()[:16]})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--unsigned", action="store_true", help="build without signing (previews)")
    a = ap.parse_args()
    check() if a.check else build(not a.unsigned)
