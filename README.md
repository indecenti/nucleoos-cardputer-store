# NucleoOS Cardputer Store

The app store of [NucleoOS](https://github.com/indecenti/NucleoOs) for the **M5Stack Cardputer**
(original and ADV, ESP32-S3). Apps are downloaded by the device over Wi-Fi and installed on its SD
card, so they do not take space in the firmware.

Everything is static and served by GitHub Pages at
**https://indecenti.github.io/nucleoos-cardputer-store/** - there is no server. Every catalog and
every package is signed offline; the device installs nothing whose signature it cannot verify.

> Other NucleoOS devices have their own stores: the ESP32-P4 tablet uses
> [nucleoos-p4-store](https://github.com/indecenti/nucleoos-p4-store).

## Two stores in one repository

The Store app on the Cardputer asks first which one to open; they are two separate signed catalogs and
never mix.

| Channel | Kinds | What it is | Runs on |
|---|---|---|---|
| **Native C** (`native`) | `native` | A C/C++ app built from NucleoOS source into a signed `.nap` module, loaded from the SD card | the Cardputer itself |
| **Web app** (`web`) | `web`, `data` | A web app the device serves from SD to your browser; content packs | the browser (no device RAM) |

## Layout

```
apps/native/<id>/           a native app: manifest.json (with its build recipe) + files/app.nap + launcher icon
apps/web/<id>/              a web app or content pack: manifest.json + files/
public/<channel>/           what Pages serves: that channel's signed catalog and one folder per published version
keys/                       the public keys the firmware trusts (main + backup)
tools/store.py              build, sign, verify both channels (see below)
tools/native_build.py       builds a native app from NucleoOS source, reproducibly
tools/test_store.py         security tests: tampering, rollback, foreign keys, bad paths, channel mix-ups
docs/format.md              the catalog and package format - the contract with the firmware
docs/rules.md               the rules every app follows (enforced by tools/store.py)
schemas/                    JSON Schema of manifest.json (for editors; store.py enforces the same rules)
```

## Publishing (maintainer)

```sh
python tools/native_build.py <id> --firmware ../NucleoOs   # native apps: rebuild from the recipe's commit
python tools/store.py publish      # build public/ from apps/, sign with the offline key, verify
git add -A && git commit && git push   # CI verifies again and deploys Pages
```

A published `version_code` is immutable: changing an app's files requires a higher `version_code`.
The catalog expires 120 days after signing, so run `python tools/store.py sign` at least every
few months even without changes; CI warns 30 days ahead.

First-time setup: `python tools/store.py keygen` and `python tools/store.py keygen --backup`, commit
the two public keys in `keys/`, move the backup private key offline. Private keys live in
`~/.nucleo/` and must never be committed (CI refuses anything that looks like one).

## Who can publish

Only the maintainer: every package is signed with an offline key after its source has been reviewed, and
the device installs nothing else. Submissions are not accepted (CONTRIBUTING.md). The rules every app
follows - its own icon, five languages, offline, small - are in [docs/rules.md](docs/rules.md) and are
enforced by the tools. Security: [SECURITY.md](SECURITY.md).

## License

The store tooling and documentation are under the [PolyForm Noncommercial License 1.0.0](LICENSE),
like NucleoOS. Each app keeps its own license, named in its `manifest.json`.
