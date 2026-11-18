## Secrets for checks

Today, check definitions declare environment variable names in `env` and sensitive
names in `credentials`. Both select values already present in the runner process;
they do not fetch Secret Objects. Missing variables remain absent, rather than
failing setup by name. A CI secret must be exposed to that runner process by the
CI configuration. Forge does not perform a separate machine-key setup today.
Definition digests and receipts carry names, never values. Commands can still
print values into their CI logs; the future sealed-secret masking contract is
not implemented. See [clean check environments](#clean-check-environments).

The rebuilt **Settings → Secrets** page is value-free and currently shows that
sealed secrets are not connected. Its metadata-only interface covers names in
Development and Checks, holders, waiting computers, rotation state and recent
changes. It makes no secret reads or writes. There is no value field, reveal
control or public sample-data route. Proposed CLI commands are marked Proposed;
holder removal and sharing settings await the protocol.

The replacement store is sealed Development and Checks sets, tracked by Item
`41a0df87`. Slice 1 implements the owner's Development device, value entry from a
hidden prompt or stdin, name-only list/remove commands and `run` delivery. Other
recipients, sharing, proposals, passkey recovery, machine keys, Checks execution,
import and Secret Object retirement remain unimplemented. Gate A passed; Gate B
is a separate code review after sharing. No database-wide confidentiality claim
applies while legacy Secret Objects and their server keyring remain.
