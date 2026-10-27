# Store format (v2)

The contract between this repository and the NucleoOS firmware on the M5Stack Cardputer. The
firmware's store client implements exactly this; `tools/store.py` writes it and `tools/store.py verify`
checks it. Change both together, and bump the magic strings for any incompatible change.

Everything is plain text, UTF-8 restricted to printable ASCII, `\n` line endings, served over HTTPS
from GitHub Pages, in two **channels** that are two separate stores:

| Channel | Kinds | What |
|---|---|---|
| `native` | `native` | apps that run on the Cardputer itself: a `.nap` module loaded from the SD card (NucleoOS `docs/native-apps.md`) |
| `web` | `web`, `data` | apps the Cardputer serves to a browser, and content packs |

```
https://indecenti.github.io/nucleoos-cardputer-store/<channel>/index.txt
https://indecenti.github.io/nucleoos-cardputer-store/<channel>/index.sig
https://indecenti.github.io/nucleoos-cardputer-store/<channel>/apps/<id>/<version_code>/package.sig
https://indecenti.github.io/nucleoos-cardputer-store/<channel>/apps/<id>/<version_code>/<path>
```

The device asks which store to open first and never mixes them. An id belongs to one channel only (both
install into `/sd/apps/<id>/`). v1 had a single catalog at the root; no released firmware read it.

## Why text lines

The Cardputer has no PSRAM and about 18 KB of free heap. It never holds the catalog in memory: it
streams it to the SD card, hashes it in chunks to check the signature, then reads one line at a time.
A line is at most 1 KB, so the catalog can grow without limit.

## Catalog: `index.txt`

```
nucleoos-cardputer-index-v2
channel <native|web>
serial <n>
expires <unix seconds>
apps <count>
app<TAB>id<TAB>kind<TAB>version_code<TAB>version<TAB>min_os<TAB>category<TAB>size<TAB>sig_sha256<TAB>permissions<TAB>names<TAB>descriptions<TAB>updated<TAB>author<TAB>abi
...
```

| Field | Meaning |
|---|---|
| `channel` | The channel this catalog belongs to, inside the signed text: the device refuses a catalog whose channel is not the one it asked for, so a validly signed catalog of one store can never be served as the other. Every line's kind must belong to it. |
| `serial` | Goes up by one at every signing, per channel. The device stores the highest it has accepted and **refuses a lower one** (rollback). |
| `expires` | The device refuses an expired catalog when it knows the time (freeze attack: an attacker replaying an old, valid catalog). Catalogs are valid for 120 days. |
| `id` | `[a-z][a-z0-9-]{1,31}`, also the install folder `/sd/apps/<id>/`. |
| `kind` | `native` (native channel), `web` or `data` (web channel). Unknown kinds are skipped. |
| `version_code` | Positive integer, only ever goes up. Updates compare this, never `version`. |
| `version` | Human version `x.y.z`. |
| `min_os` | Lowest NucleoOS version that can run it; older firmware hides the row. |
| `category` | `games tools media office learn network security system`. |
| `size` | Total payload bytes (shown before download; checked against free SD space). |
| `sig_sha256` | SHA-256 of that version's `package.sig`: binds the catalog to the exact package. |
| `permissions` | Comma list from `net fs audio mic imu ir ble wifi gpio usb`, or `-`. Shown before install. |
| `names`, `descriptions` | Five values separated by `|`, in the order `it en es fr de`. Names at most 24 characters, descriptions at most 120. |
| `updated` | Unix time (day precision) this version was first published: the store's "New" tab sorts by it. |
| `author` | Who made it, at most 40 characters. |
| `abi` | `native`: the NucleoOS native ABI level the module was built for; the device refuses a level above its own. `-` for other kinds. |

Readers must accept extra fields after these and ignore them: new fields are only ever appended.

## Catalog signature: `index.sig`

```
nucleoos-cardputer-sig-v1
key <key id>
sig <base64 DER ECDSA signature>
```

ECDSA P-256 with SHA-256 over the exact bytes of `index.txt`. `key id` is the first 16 hex digits of
the SHA-256 of the public key in DER SubjectPublicKeyInfo form; the device holds the same public keys
(main and backup) compiled in and accepts either.

## Package: `apps/<id>/<version_code>/package.sig`

```
nucleoos-cardputer-pkg-v1
<id>
<version_code>
<kind>
<sha256> <size> <path>        one line per file, paths in ascending byte order
--
key <key id>
sig <base64 DER ECDSA signature>
```

The signature covers everything before the `--` line. Paths: up to four segments of
`[A-Za-z0-9._-]`, no segment starting with `.`, never `..`. Limits: 64 files, 4 MiB per file,
8 MiB per package.

## Install on the device

1. Download `index.txt` and `index.sig` to SD; verify; check serial and expiry; keep the serial.
2. For the chosen line: download `package.sig`, check its SHA-256 against the catalog line, verify
   its signature, check id, version code and kind against the line.
3. Download every listed file into `/sd/apps/.tmp/<id>/`, checking size and SHA-256 of each.
   Refuse any file not listed and any path the rules above reject.
4. Only when everything matches: move the old `/sd/apps/<id>/` aside, rename the new one into place,
   then delete the old one. A failure at any step leaves the installed version untouched.
5. The verified `package.sig` stays in the app folder as `.package.sig`. A native app is checked against it
   again (signature and the module's SHA-256) before every load, so a file edited on the card never runs.

Nothing is ever executed or rendered before step 4 completes.
