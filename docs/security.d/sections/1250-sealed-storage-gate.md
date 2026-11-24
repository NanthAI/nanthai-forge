### Sealed storage gate

The sealed write mutation takes the project, set kind, operation ID, the signed
payload, the genesis roster on a first write and at most one roster transition.
Everything else it stores comes from the payload. It decodes the payload with the
same strict schemas and portable format code the CLI uses (`src/sealed-portable.ts`
has no Node built-ins, so it runs inside a Convex mutation) and derives the head
hash, head and roster versions and set ID from it. The head and roster must name
this project, kind and set, and the head must carry its roster's version and hash.
The compare-and-swap compares the head's own previous-head hash with the stored
head. A first write needs the all-zero previous hash and stores its own
version-one roster as genesis, which never changes.

The server keeps the history ring. It appends a write's transition only when it
starts at the stored roster's version and hash and ends at the signed head's
roster, and only when its delta is that change: every removed device is absent
from the signed roster and every added one is present. A roster change without its
transition is refused, and a client never supplies the ring. A first head starts an
empty ring. The ring keeps the newest 64 steps that fit its 128 KiB record.

Removal markers and join requests are server-owned fields of the set record. A head
write cannot carry markers or proposals, or nested previous or related replies with
their own markers; the replacement flow will fill those from the server's markers on
the old set. Every read reply returns the server's
markers and join requests, including an unchanged-cache reply. A transition that
removes a device clears that device's marker, and one that adds a device clears its
join request; a step also drops requests it made stale (an account that now has an
entry, or every request once Development leaves Automatic). Nothing else in a head
write changes them. Join requests are posted
by the join mutation (Sealed Automatic join); markers are placed when a person
loses write access to the project (Sealed removal and rotate list).

The record transport header must round-trip as exact UTF-8, so the decode refuses
invalid bytes and a byte-order mark the same way in Node and in Convex, with no
decoder options.

Roster entry checks test each X25519 key with a fixed public probe scalar. X25519
clamps every scalar to a multiple of the cofactor, so a fixed scalar refuses each
low-order key exactly as a random one would, and the check needs no random source.

Before it stores a head, the server runs the public part of the reader's
verifier, with the same code (`src/sealed-roster.ts` and `src/sealed-head.ts`).
It walks the write's roster step from the stored roster with the stored
markers, so the step's signer must hold the authority for that shape. The head
must be signed by a write device of the roster after the step, that device's
account must be the signed-in account, and no marker may name it. The head is
checked against the stored head the way every holder pinned there checks it:
versions, floor, tombstones, unchanged records, and the author and change
signature of every changed name. One exception: a Checks name that records a
proposal is authored in Development, which the server does not read, so its
author and signature are left to readers. Every ciphertext must name one live record and match its
signed hash, every live record needs its ciphertext, and every wrap names a
different recipient on the roster. A genesis roster is checked in full. A
refused write stores nothing.

A step checks the curve operations (the agreement-key probe and the device
binding) only for the entries it adds. Every other entry carries keys that a
checked roster already held, and the roster hash binds them, so it gets the
structural rules only. The server's own induction starts with this check: rosters
stored before it were checked by every reader, not by the server. Readers do the same after checking their starting
roster once, so walking 64 steps costs one full roster check, not 64.

Measured in the V8 bundle at 100 recipients and 200 names: a value write takes
about 43 ms of gate time; one step that adds 99 devices takes about 384 ms
(584 ms on a cold first run), against the 1 s mutation limit. Each changed name
adds one signature check. An automatic share adds at most 32 devices in one step
(the waiting join requests); manual additions are bounded only by the 100-entry
roster.

Some rules need the set key, which the server never holds: the key commitment,
the wraps opening (wrap bytes are not checked) and each value's commitment. A head that passes the server's
checks but fails one of these is stored, and every holder refuses it. The
server opens no value and holds no key. It still accepts writes only from the
project owner's stable device sign-in. Clients verify every reply in full and
rely on none of these checks.
