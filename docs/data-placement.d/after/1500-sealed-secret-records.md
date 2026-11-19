## Sealed secret records

`sealedSecretSets` and `sealedSecretHistory` are an approved exception to the R2
byte-body rule (Issue `41a0df87`). They hold client-signed public metadata, key
wraps and padded ciphertext; no private key, value encoding or unkeyed value hash
belongs in either row. One set and one history row per project/set kind are
replaced together in one compare-and-swap mutation. This atomic publication is
why these bounded records stay in Convex. Existing Secret Objects are separate
and remain until their approved retirement.

The server enforces a complete set-row ceiling of 512 KiB and a complete history
ceiling of 128 KiB, including metadata allowance. It retains at most 64
transitions and 50 retry events, pruning in the same mutation. Genesis remains
in the history row. The landing storage ledger charges zero bytes for both
new tables: owner secret commands are outside the landing path. Standalone
record-size and request tests account for configured sets separately.

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
history rows are 1,047 B. Initial write requests are 19,096/167,116 B; complete
read replies are 18,880/166,900 B. A verified cache hit returns 20 B. This is
logical fixture accounting, not provider-billed I/O; the server reads the whole
bounded set document even for the small response. A steady-state history may
include up to 50 events and 64 transitions within its unchanged 128 KiB cap.

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
