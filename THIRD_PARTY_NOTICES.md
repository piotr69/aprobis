# Third-party notices

Aprobis itself is licensed under the [MIT License](LICENSE). It depends on open-source packages installed
from npm (see `package-lock.json`). Most of them use permissive licenses (MIT, ISC, Apache-2.0, BSD).
A few carry additional obligations when redistributed:

| Package | License | Note |
|---|---|---|
| `@img/sharp-libvips-*` (optional, installed by Next.js `sharp`) | LGPL-3.0-or-later | Prebuilt libvips binaries, loaded dynamically and not modified. If you redistribute a bundle that includes `node_modules`, include the LGPL-3.0 text and the libvips notices. See [sharp licensing](https://sharp.pixelplumbing.com/#licensing). |
| `axe-core`, `lightningcss` and its platform packages | MPL-2.0 | File-level copyleft: changes to MPL-covered files must be shared under MPL-2.0. Aprobis does not modify them. |
| `caniuse-lite` | CC-BY-4.0 | Browser compatibility data; attribution to the Browserslist / caniuse project. |
| `lucide-react` | ISC (icons partly derived from Feather, MIT) | Keep the license notice when redistributing. |

This list summarises declared license metadata; it is not legal advice. For an exact inventory of a particular
build, generate it from the installed `node_modules` (for example with `npx license-checker --summary`).

SQL Server, Windows, IIS and Windows Defender are external requirements of the runtime environment and are
not distributed with Aprobis.
