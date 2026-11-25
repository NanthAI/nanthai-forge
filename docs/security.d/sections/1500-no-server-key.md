## No server key for team secrets

A copy of the database, a backup or an object-storage copy reveals the names of the
secrets a team stored, never a value and never a key that opens one. This holds for a
deployment once it has run the Secret Object purge and its operator has deleted the old
`FORGE_SECRET_KEYS` setting; a snapshot or a key copy taken before that still holds
what it held then, and the claim does not cover it. The guard below checks the code and
the tables; it cannot see a deployment's settings or an earlier backup, so the operator
checks those by name (never by value) when the purge is done.

- Values are sealed on members' devices (see [sealed Development](1200-sealed-development-core.md)).
  The server stores ciphertext, signed rosters and wraps to device public keys, in Convex
  records, and nothing in file or object storage.
- Forge holds no setting that opens a team's value. The Secret Object keyring
  (`FORGE_SECRET_KEYS`) is deleted from every deployment and no code reads it. Server
  settings that look like keys are named service credentials (GitHub sign-in and App
  credentials, the signing keys for device tokens and checks, object-storage access); the
  GitHub App user tokens are sealed under their own server keyring, which never opens a
  team value.
- Secret Objects, their modules, tables and web dotenv import are retired. A one-off purge
  deletes any remaining rows ([operations](../../operations.md#sealed-secrets-and-the-retired-secret-objects)).
- Agent read grants keep only the hash of their token, never a copy that a server key could open.
- `scripts/check-no-server-key.mjs` (run by `npm run check`, so by every landing) fails the build when
  the keyring comes back, when a new key-like server setting is not named and classed, when a
  sealed-set module reads a setting or holds a cipher, when anything but the GitHub token store seals
  under a server keyring, or when a backup, export or archive module reads a sealed table.
  `tests/check-no-server-key.test.mjs` also fails when a sealed table gains a field shaped like a
  value or a key, and the sealed journey test (`tests/sealed-no-plaintext.test.mjs`) fails when a
  journey leaves a value or key in any stored row, call or file, or anything in file or object storage.

Recovery needs a device that is on the roster, or reissuing the value at the provider; no
server-side copy can restore a value. The backend administrator can still delete or replace
ciphertext, which the readers detect (rollback and fork refusal), but cannot read it.
