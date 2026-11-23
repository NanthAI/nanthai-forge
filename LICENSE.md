# Licensing

Copyright 2026 Ferdinando Valsecchi.

Every original file in this repository is licensed under the [GNU Affero General Public License version 3 only](LICENSE-AGPL-3.0-only.txt), SPDX `AGPL-3.0-only`. That covers the CLI, the browser client, `src/`, `convex/`, `scripts/`, `tests/`, `evals/`, documentation, agent instructions, configuration and package metadata, as one licence for the whole repository. Source files carry `SPDX-License-Identifier: AGPL-3.0-only` and the copyright line above as their first lines (`node scripts/check-spdx.mjs` enforces it). Files that cannot carry a comment header (JSON, Markdown prose, images) are covered by this file.

Exclusions:

- Generated files (for example `convex/_generated/`) are written by their generators and are not original work.
- Third-party code, notices and dependencies keep their own licences. Preserve required notices. The npm production dependencies are listed in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), with the licence compatibility check; vendored upstream notices are under `docs/vendor-notices/`. Inventories: [npm](docs/dependency-licenses.md) and [native backend](docs/native-dependency-licenses.md). The downloaded Convex backend has its own FSL-1.1-Apache-2.0 terms.
- Brand assets: the NanthAi monograms and Forge marks, badges, lockups and browser/app icons, with the inline mark component `web/src/ui/brand.tsx` and its state styles `web/src/ui/mark.css`, remain all-rights-reserved NanthAi branding, reused by explicit owner authorization. See [asset notice](web/src/assets/NOTICE.md). Source licensing does not grant rights to NanthAi or N:Forge trademarks.

Copies of this repository published before this change carried `SPDX-License-Identifier: Apache-2.0` headers on most files (and a mixed Apache-2.0 / AGPL-3.0-only map in this file). Those headers still apply to those copies. This change applies to versions published with the AGPL-3.0-only headers and later, and does not retract rights already granted for earlier copies.

The complete licence text governs; this file identifies scope. No copying or relicensing of NanthAI:Edge code is authorized merely by this file.

Outside contributions need a signed contributor agreement first, and are closed until it is approved. See [CONTRIBUTING.md](CONTRIBUTING.md).
