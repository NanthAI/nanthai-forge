Rebuilt Settings → Secrets is value-free with an unavailable metadata provider.
`nforge secret set/list/rm/repin/resolve` and lazy `nforge run` now use the owner's
sealed Development set, signed metadata, local pins and a ciphertext-only cache.
Release name rules, exact root `.env.example` reading, credential stripping,
masking and private temporary-file cleanup remain the process boundary. Device
keys use a private local file; an OS keychain backend remains planned. Sharing,
proposals, passkey recovery, Checks/machine delivery, import, per-added-name owner
alerts and Secret Object retirement remain pending. Gate B follows the sharing
slice; no completed code-review gate is claimed. Default policies protect
`.env.example`; explicit owner lists stay authoritative. See [security](../../security.md#sealed-development-core).
