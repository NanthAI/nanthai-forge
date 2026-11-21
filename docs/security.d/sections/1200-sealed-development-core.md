### Sealed Development core

`nforge secret set NAME [--file]`, `nforge secret list`, `nforge secret rm NAME`
and `nforge secret repin` use a stable device sign-in. Values never belong in
arguments or replies. `--file` makes the stdin/prompt value a file-shaped secret;
`run` supplies its private temporary path. Stdin bytes are kept exactly, including
any trailing newline. Agent markers and non-interactive input permit new names
only; changes/removals require a person until the proposals slice. The server's
storage gate requires the owner account's unrestricted stable device credential;
value authority is the owner device signature in the verified roster. Legacy
Secret Objects keep their existing owner-person gate.

Device signing and agreement keys are independent. Their account binding, set
keys, wraps, padded values, hiding value commitments, per-name change signatures,
roster history, former signers, tombstones and signed heads use purpose-separated
format-v1 frames. Project/account protocol IDs are independently derived from the
Forge IDs, with separate purpose labels; a server-supplied protocol ID is never
accepted as the requested project's identity. Known-answer fixtures cover these
layouts independently of the signing implementation.

Dropping a tombstone can raise the set's version floor while existing live names
keep their versions. A new change starts one above the higher of the name's
current version and the floor of the verified head used for the write, including
any compaction in that write.

Device secret keys are kept in a private file readable by your user account:
0600, in a 0700 configuration folder, outside projects and Lanes. The OS keychain
is planned before Gate B (Issue `a9f9b608`). Re-login retains these keys. This does
not protect against another process running as your user or an unlocked stolen
disk. Local keys are binary buffers and are not passed in process arguments.

Pins are MAC-authenticated per project/kind, with an account/device index and a
counter kept beside the device keys. Writers use one exclusive lock file with
PID, process-start marker and random token; only a dead holder's matching token
may be reclaimed. Lock contents are fsynced before an exclusive hard-link
publication; dead reclaim gates are recoverable, and incomplete legacy locks
become reclaimable after 30 seconds. Completed candidate files left by a crashed
holder are swept only when their token matches and their recorded process is
dead; live, incomplete or unidentifiable candidates are preserved. Readers use atomic snapshots and re-read
under that lock before
reporting lost trust. Writes use private temporary files, fsync and atomic rename.
Network calls never hold the lock, and a response is re-verified against the latest
pin before publication. Unchanged verification changes no pin, index or counter.
Restoring one kind after index or counter recovery keeps every unchecked sibling
kind lost until it is restored independently. Lost-kind identity survives later
writes, and rebuilding never resets counters below an earlier publication.
These file-store/lock deviations remain explicit Gate B review items.

A local retry journal retains only the exact sealed request while its outcome is
unknown, in 0600 files within the same 0700 configuration folder. Journal writes
share the pin lock and use temporary files, fsync and atomic rename. Acceptance
immediately compacts a request to a value-free receipt (operation ID, project,
name, action and accepted head hash); confirmed refusals delete it. The cap is
64 entries, each at most 768 KiB (48 MiB total). Oldest confirmed receipts go
first; unresolved requests are never silently dropped. A full unresolved journal
returns `SECRETS_JOURNAL_FULL`. Run `nforge secret resolve --operation-id UUID`
for each retained unknown operation: a matching change signature in the verified
current head confirms it; otherwise a person may explicitly discard that local
request, including when current access is unavailable. Cancelling keeps it. A
discarded operation ID must never be reused; repeat a missing change with a new
operation. This provides a way out of a full journal without silently dropping
unknown requests. Agent entry points cannot approve discards. Replaying a retained
confirmed receipt rechecks current access and writes no secret. A supplied retry
value must match the retained ciphertext, or the original confirmed head while
that exact head is current; otherwise `WORK_OPERATION_REUSED` refuses it. Use
`secret resolve` to inspect a confirmed receipt without supplying a value. An
unknown replay uses its original sealed
bytes; if the server's 50-event window can no longer establish the outcome, it
returns `SECRETS_WRITE_UNKNOWN`, never an automatic new seal. Run
`nforge secret list` to see the current head, then repeat the change as a new
operation if it is missing. This bounded local journal is also a Gate B item.

Deleting or restoring old pin files does not reset first-contact trust. A person
can use `secret repin` only when loading that project/kind under the lock reports
`SECRETS_PIN_LOST`, to confirm a view signed by this device after seeing its
date, device fingerprints and the possibility that it is older. Other cases need
a holder confirmation in the sharing slice. Rebuilding one project's trust keeps
other missing projects marked as lost. A rebuild checks this device's own head
signature with the public key from its local key store and starts at that signed
roster; it does not require this device to have created the set.

The verifier refuses a first-seen set without an explicit typed journey anchor;
served roster bytes or a copied public device entry grant no trust. The owner
CLI supplies only its locally held device identity as an own-genesis anchor:
that device must be the sole genesis entry and the signature chain must walk
from it. Retrying a retained sealed request checks this device's own signature
on that saved request against its locally held public key. Rebuilds verify
this device's own signed head. Checks
first contact uses an explicit genesis anchor named by trusted Development.
A passkey contact needs a person-signed checkpoint
with matching roster bytes and the public keys derived locally from its seed;
a listed person entry alone grants no trust. A missing checkpoint or a walk
outside retained history requires holder confirmation. These are verification
foundations: joined Development devices without a confirmed anchor remain
refused. Sharing commands, passkey browser delivery and Checks delivery are
not available yet. Pins protect subsequent reads, including the
ciphertext-only offline cache. A compromised server can withhold records or keep
an offline device on its last verified view. No decrypted cache is written.
