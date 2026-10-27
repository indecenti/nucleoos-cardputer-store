# Submitting an app

1. Fork, add `apps/<id>/manifest.json` and `apps/<id>/files/`, open a pull request.
2. CI checks the manifest and the payload (ids, paths, sizes, languages, no secrets). It does not sign.
3. A maintainer reviews the **source** of the app. Approved apps are built and signed offline, then
   published. Nothing unsigned ever reaches a device.

## manifest.json

```json
{
  "id": "metronome",
  "kind": "web",
  "version": "1.0.0",
  "version_code": 1,
  "min_os": "0.7.0",
  "category": "media",
  "name":        { "it": "Metronomo", "en": "Metronome", "es": "Metronomo", "fr": "Metronome", "de": "Metronom" },
  "description": { "it": "...", "en": "...", "es": "...", "fr": "...", "de": "..." },
  "author": "Your name",
  "license": "MIT",
  "source": "https://github.com/you/your-app",
  "permissions": ["mic"]
}
```

Rules (enforced by `tools/store.py`, see `schemas/manifest.schema.json`):

- `id`: lowercase, `[a-z][a-z0-9-]{1,31}`, equal to the folder name. Never reused.
- `version_code`: a positive integer that goes up with every release. A published version is never changed.
- `name` (24 characters) and `description` (120) in all five languages: it, en, es, fr, de.
  Printable ASCII only - the device fonts have no accented letters (write `Metronomo`, `Etat`, `Wuerfel`).
- `permissions`: only what the app needs; they are shown to the user before installing.
- Payload: at most 64 files, 4 MiB each, 8 MiB in total. Paths of letters, digits, `.`, `_`, `-`.

## Web apps

`files/` is exactly what goes in `/sd/apps/<id>/` on the device: the NucleoOS app `manifest.json`
plus `www/`. Keep a `.gz` twin next to large text files; the device serves it to the browser as is.
