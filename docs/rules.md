# Cardputer rules

Every app in this store follows these rules. `tools/store.py` enforces them when it builds a package and
again when CI verifies the published tree, so an app that breaks one is never signed or served.

## Who publishes

Only the maintainer. Packages are signed with an offline key that never leaves the maintainer's machine;
the device installs nothing else. Pull requests are not a way to publish: nothing merged into this
repository reaches a device until the maintainer has reviewed it, built it and signed it.

## Every app

- **Its own drawn icon.** A web app ships `www/icon.svg`, referenced by its `manifest.json` as
  `"icon": "icon.svg"`: a square `viewBox`, at most 16 KB, plain drawing only (no scripts, event
  handlers, `javascript:` or external links), and not the same drawing as any other app.
- **Its own launcher icon on the Cardputer**: `files/device-icon.txt`, 32 lines of 32 characters, `#` for
  a lit pixel and `.` for an unlit one, hand-drawn pixel art that the launcher paints in the app's colour.
  Not blank, not a solid block, not the same drawing as another app's.
- **Five languages**: `it`, `en`, `es`, `fr`, `de`, in the store manifest and, for a web app, as
  `www/i18n.<lang>.json` catalogs with the same keys. Store names and descriptions are printable ASCII
  (the device fonts have no accents): at most 24 and 120 characters.
- **Offline.** Nothing is loaded from the Internet: no remote `src`/`href`, imports, stylesheets, fonts,
  `fetch`, sockets. A store app works on a Cardputer with no connection and never pulls unreviewed code.
- **No code from strings**: no `eval`, `new Function`, `document.write`, string timers.
- **Small.** At most 64 files, 4 MiB per file; a web app at most 2 MiB in total.
- **Immutable versions.** A published `version_code` never changes; every change is a new, higher one.

## Web apps

`files/` is exactly `/sd/apps/<id>/` on the device:

```
manifest.json        the NucleoOS app manifest: id, "runtime": "web", "web_route": "/apps/<id>/", "icon": "icon.svg"
www/index.html       the app
www/icon.svg         its icon
www/i18n.<lang>.json one per language (loaded by /nucleo-i18n.js, the OS i18n runtime)
```

They run in the browser of whoever opens them (the Cardputer only serves files): Web Audio, storage and
the UI cost the device nothing.

## Native apps

Run on the Cardputer itself, loaded from the SD card into a flash region and executed from there
(NucleoOS `docs/native-apps.md`). `files/` is exactly:

```
app.nap              the module, built by tools/native_build.py from NucleoOS source
device-icon.txt      its launcher icon
i18n.es/.fr/.de      a game's text in Spanish, French and German: all three or none
```

- **Its own languages.** A game that writes its text with `GT()` ships the three packs NucleoOS builds from
  `tools/game-i18n/<id>.json` at the recipe's commit (`tools/sd-sim/system/i18n/games/<id>.<lang>`);
  `tools/native_build.py` copies them and `--check` compares them too. Italian and English are in the module.
  A firmware that knows them (game_text reading `/sd/apps/<id>/i18n.<lang>` first) uses the installed packs, so
  the game speaks five languages even on a card whose system content is older; an older firmware ignores them
  and reads its system copy.

- **Built from committed source, reproducibly.** The manifest's `build` recipe names the NucleoOS commit and
  sources; `tools/native_build.py --check` rebuilds the module byte for byte from it. A test build from a
  modified checkout (`<commit>-dirty`) is never signed.
- **Within its ABI.** The manifest's `abi` is the level it was built for; every import is checked against
  that level's list at build time, and the module's own info record must say the same id and level.
- **One app, one id.** The id is the app's launcher id; an app that leaves the firmware keeps its built-in id,
  so its tile, Recents, pins and saves carry over.
- **Tested on both boards** (original Cardputer and ADV), as an upgrade with saves on the card, before it is
  signed; draws within 240x135 (and 320x240 on the second screen) with the system fonts and keys
  (`docs/device-ui.md` in NucleoOS).
- **At most 512 KB** for the package; the module's code and constants fit the 252 KB flash scratch region.
