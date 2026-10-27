# NucleoOS Cardputer Store

The app store of [NucleoOS](https://github.com/indecenti/NucleoOs) for the **M5Stack Cardputer**
(original and ADV, ESP32-S3). Apps are downloaded by the device over Wi-Fi and installed on its SD
card, so they do not take space in the firmware.

Everything is static and served by GitHub Pages at
**https://indecenti.github.io/nucleoos-cardputer-store/** - there is no server. Every catalog and
every package is signed offline; the device installs nothing whose signature it cannot verify.

> Other NucleoOS devices have their own stores: the ESP32-P4 tablet uses
> [nucleoos-p4-store](https://github.com/indecenti/nucleoos-p4-store).

## Layout

```
apps/<id>/manifest.json     the app: id, kind, versions, names and descriptions in 5 languages
apps/<id>/files/            its payload, installed as /sd/apps/<id>/ on the device
public/                     what Pages serves: the signed catalog and one folder per published version
keys/                       the public keys the firmware trusts (main + backup)
tools/store.py              build, sign, verify (see below)
tools/test_store.py         security tests: tampering, rollback, foreign keys, bad paths
docs/format.md              the catalog and package format - the contract with the firmware
docs/rules.md               the rules every app follows (enforced by tools/store.py)
schemas/                    JSON Schema of manifest.json (for editors; store.py enforces the same rules)
```

## Kinds of app

| `kind` | What it is | Runs on |
|---|---|---|
| `web` | A web app the device serves from SD to your browser | the browser (no device RAM) |
| `data` | Content: books, maps, voice packs, ANIMA knowledge | the apps that read it |
| `native` | A native game executed from flash (planned) | the Cardputer |

## Publishing (maintainer)

```sh
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
