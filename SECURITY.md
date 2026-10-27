# Security

## Model

The device trusts **signatures, not servers**. GitHub Pages, the network and this repository's CI
are all treated as untrusted transport.

| Threat | Defence |
|---|---|
| A modified file on the server or in transit | Every file's SHA-256 and size are in a signed `package.sig`; the device checks each file before installing. |
| A modified or fake catalog | `index.txt` is signed (ECDSA P-256); unknown keys are refused. |
| Replaying an old catalog with a vulnerable app (rollback) | `serial` only goes up; the device refuses a lower serial than it has seen. |
| Freezing a device on a stale catalog | `expires`: a catalog is valid for 120 days. |
| Swapping a package between versions | The catalog line carries the SHA-256 of the exact `package.sig`; the package names its id, version code and kind. |
| A compromised GitHub account or CI | CI holds **no signing key**: it can only verify and publish. Without the offline key, nothing it publishes installs. |
| Path traversal / overwriting system files | Strict path rules, checked when signing and again on the device; installs go to `/sd/apps/<id>/` only. |
| A half-written install | Download to a temporary folder, verify all, then rename; failure leaves the old version. |
| A lost or leaked main key | A second key pair (backup) is compiled into the firmware; its private half stays offline. Rotating the main key is a firmware update that drops it. |

Keys are dedicated to this store: they are not the firmware OTA keys and not the NucleoOS-P4 store
keys, so a leak in one system cannot reach another.

## What the store does not do

- It does not sandbox apps. `web` apps run in your browser like any web page served by the device;
  `native` apps run with the firmware's privileges. Only install what you trust; every app is reviewed
  from source before it is signed (see CONTRIBUTING.md).
- It does not hide what you install from the network: downloads are plain HTTPS GETs.

## Reporting

Please report a vulnerability privately through GitHub's
[private vulnerability reporting](https://github.com/indecenti/nucleoos-cardputer-store/security/advisories/new),
not in a public issue.
