# Store format (v1)

The contract between this repository and the NucleoOS firmware on the M5Stack Cardputer. The
firmware's store client implements exactly this; `tools/store.py` writes it and `tools/store.py verify`
checks it. Change both together, and bump the magic strings for any incompatible change.

Everything is plain text, UTF-8 restricted to printable ASCII, `\n` line endings, served over HTTPS
from GitHub Pages:

```
https://indecenti.github.io/nucleoos-cardputer-store/index.txt
https://indecenti.github.io/nucleoos-cardputer-store/index.sig
https://indecenti.github.io/nucleoos-cardputer-store/apps/<id>/<version_code>/package.sig
https://indecenti.github.io/nucleoos-cardputer-store/apps/<id>/<version_code>/<path>
```

## Why text lines

The Cardputer has no PSRAM and about 18 KB of free heap. It never holds the catalog in memory: it
streams it to the SD card, hashes it in chunks to check the signature, then reads one line at a time.
A line is at most 1 KB, so the catalog can grow without limit.

## Catalog: `index.txt`

```
nucleoos-cardputer-index-v1
serial <n>
expires <unix seconds>
apps <count>
app<TAB>id<TAB>kind<TAB>version_code<TAB>version<TAB>min_os<TAB>category<TAB>size<TAB>sig_sha256<TAB>permissions<TAB>names<TAB>descriptions
...
```

| Field | Meaning |
|---|---|
| `serial` | Goes up by one at every signing. The device stores the highest it has accepted and **refuses a lower one** (rollback). |
| `expires` | The device refuses an expired catalog when it knows the time (freeze attack: an attacker replaying an old, valid catalog). Catalogs are valid for 120 days. |
| `id` | `[a-z][a-z0-9-]{1,31}`, also the install folder `/sd/apps/<id>/`. |
| `kind` | `web` (served to the browser from SD), `data` (content only), `native` (a flash-executed game; only firmware that implements it lists these). Unknown kinds are skipped. |
| `version_code` | Positive integer, only ever goes up. Updates compare this, never `version`. |
| `version` | Human version `x.y.z`. |
| `min_os` | Lowest NucleoOS version that can run it; older firmware hides the row. |
| `category` | `games tools media office learn network security system`. |
| `size` | Total payload bytes (shown before download; checked against free SD space). |
| `sig_sha256` | SHA-256 of that version's `package.sig`: binds the catalog to the exact package. |
| `permissions` | Comma list from `net fs audio mic imu ir ble wifi gpio usb`, or `-`. Shown before install. |
| `names`, `descriptions` | Five values separated by `|`, in the order `it en es fr de`. Names at most 24 characters, descriptions at most 120. |

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

Nothing is ever executed or rendered before step 4 completes.
