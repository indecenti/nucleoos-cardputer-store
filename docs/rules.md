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

## Native apps (planned)

Executed from flash on the Cardputer. They will additionally be built against a versioned firmware API,
tested on both the original Cardputer and the ADV before they are signed, and draw within the 240x135
screen with the system fonts and keyboard conventions (`docs/device-ui.md` in NucleoOS).
