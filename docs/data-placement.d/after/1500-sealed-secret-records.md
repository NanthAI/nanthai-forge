## Sealed secret records

`sealedSecretSets`, `sealedSecretHistory` and `sealedSecretProposals` are an approved exception to the R2
byte-body rule (Issue `41a0df87`). They hold client-signed public metadata, key
wraps and padded ciphertext; no private key, value encoding or unkeyed value hash
belongs in either row. One set and one history row per project/set kind are
replaced together in one compare-and-swap mutation. This atomic publication is
why these bounded records stay in Convex. Existing Secret Objects are separate
and remain until their approved retirement.

The server enforces a complete set-row ceiling of 512 KiB and a complete history
ceiling of 128 KiB, including metadata allowance. It appends each write's own
transition, keeps at most 64 that fit the history ceiling and 50 retry events,
pruning in the same mutation. Genesis remains in the history row. Removal markers
and join requests are optional fields of the set row, absent when empty; reads
return them only when present. The landing storage ledger charges zero bytes for all three
tables: secret commands are outside the landing path. Standalone
record-size and request tests account for configured sets separately.

`sealedSecretProposals` (Item `6466c6a5`) holds one signed proposal record per row:
public metadata and a ciphertext sealed to the set's inbox key, 272 to 69,648 bytes
of ciphertext, a row under 72 KiB. A set waits on at most 32 proposals and 256 KiB of
proposal bytes, at most 8 from one device. The set row also keeps the last 64 resolved
proposal ids (about 1.5 KB) so a resolved proposal is not stored again. Their facts (id, proposer, name, epoch, size, row id; about 4 KB for
32) are an optional field of the set row, so a head write checks and resolves them
without reading proposal rows, and the set row stays under its own cap. `propose`
reads the bounded set row and inserts one row and patches the set (2 writes). The
head write that applies, adopts or rejects proposals, or re-keys, deletes their rows
in the same mutation; so do `reject` and the marking of a proposer (at most 32
deletes, no extra read). `proposals` reads the listed rows only when `read` reported a
count. Synthetic fixture at 100 recipients and 200 names: `propose` read 5 documents
(242 KB, almost all the set row) and took about 9 ms median in local Node; a head
write applying 32 proposals from 4 devices read 4 documents (294 KB), wrote 34 (set,
history, 32 deletes) and took 62 ms. Local observations, not Convex-billed I/O or time.

No application subscribes to these tables. CLI reads are one-shot. A cached
`run` asks with its verified head hash and receives only an unchanged response
when current; the server still reads the bounded current row, and checks current
membership. Changed or missing caches receive the sealed record in that same
call; history is included only when the roster differs or genesis is needed.
There is no idle query, polling or timer. The cap and absence of subscriptions
meet the large-per-write rule even when a configured set exceeds 100 KB. A future
web adapter must read a names-only projection, never these records.

The synthetic 20/200-name fixture uses 128-byte values and measures complete
Convex-value sizes, rather than JSON/base64 sizes. Set rows are 18,270/166,290 B;
history rows are 1,047 B. Initial write requests are 18,945/166,965 B; complete
read replies are 18,880/166,900 B. A verified cache hit returns 20 B. This is
logical fixture accounting, not provider-billed I/O; the server reads the whole
bounded set document even for the small response. A steady-state history may
include up to 50 events and 64 transitions within its unchanged 128 KiB cap.
Later writes send only the payload and the transition they introduce, never
genesis or the ring.

At 100 recipients and 200 names (synthetic fixture), a write that adds 99 members
sends a 237,438 B payload and a 50,159 B transition. The set row is 237,669 B and
the history row 51,315 B. The mutation reads four documents (167,843 B) and replaces
two. Its payload checks took about 9 ms (median of five) in a local V8 context with
no Buffer or Node built-ins. A full public check of the same roster, run twice as a
roster walk does, plus one head signature took about 333 ms there. That check is
not on the write path yet. These are local observations, not Convex-billed time.

For an existing pinned owner device, `secret set` and `rm` use one read and one
CAS mutation: normally seven document reads (credential/project/set on the read,
then credential/project/set/history on the write), and two document replacements.
A changed roster adds the history read. `list` and `run` each use one read:
three documents normally, four when history is needed. A cache hit sends only the
20-byte response; a miss returns the current sealed body in the same call.
Setup uses the same two function calls and inserts two rows. CAS contention adds
a re-read and retry; an unknown outcome replays the retained ciphertext operation.
`secret resolve` uses one current verified read and local journal IO only; it makes
no server mutation. The opaque genesis bytes are deterministic across decoding
and re-encoding; the server preserves the first genesis and refuses replacement.
Offline `run` may use the verified cache only after a transport failure, never
after an authentication or verification refusal. Idle is zero calls and zero I/O.

One shared-process fixture run reported RSS about 158/99 MiB and record assembly
86/7,784 ms for 20/200 names. These observations include the backend harness and
shared-machine/GC effects; they are not isolated helper memory or wall-time
assertions, and establish no performance gain. Payload and decrypted buffers grow
with the bounded set plus one current value, not with source or history size;
pin/cache memory is bounded by the record caps. These commands add zero secret
reads/writes per
landing and model $0 per 1,000 landings. Real secret-command billed usage remains
unmeasured; no new all-in serving-cost claim follows from these figures.
