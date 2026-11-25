Settings → Landing and checks → Secrets is a value-free page: one names-only read
(`sealedSecrets:overview`, one-shot, no subscription) shows what needs a person (removed
computers to take out, names to rotate, proposals), the names and who can open them; each
action is a command copied to a terminal. The top bar's Needs-you count includes it.
`nforge secret set/list/rm/repin/resolve` and lazy `nforge run` now use the owner's
sealed Development set, signed metadata, local pins and a ciphertext-only cache.
Release name rules, exact root `.env.example` reading, credential stripping,
masking and private temporary-file cleanup remain the process boundary. Device
keys use a private local file; an OS keychain backend remains planned. A write
member's first device gets Development automatically on its next run after an
owner device's run, and `nforge secret unshare` undoes it by removing and
re-keying. A person who leaves the project, or loses access when it is trashed, is
marked for removal; an owner's next
write (or `nforge secret unshare --marked`) removes and re-keys, and `nforge secret
list` shows what to rotate. `nforge secret import` seals a `.env` into Development,
adds its names to `.env.example` and removes the plaintext after a full import,
printing the undo (`--restore`, a person only). Secret Objects and the server
keyring are retired: Forge holds no key that opens a team's secret, and a guard test
(`scripts/check-no-server-key.mjs`, run by `npm run check`) fails if a database, backup or object-storage copy
could. Code sharing, passkey recovery and per-added-name owner alerts remain pending;
Gate B cleared for the slice-1 and slice-2 code. Default policies protect
`.env.example`; explicit owner lists stay authoritative. See [security](../../security.md#sealed-development-core).
