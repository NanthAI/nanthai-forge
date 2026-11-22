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
join request. Nothing else in a head write changes them. The commands that place
markers and post join requests arrive with removal and Automatic join.

The record transport header must round-trip as exact UTF-8, so the decode refuses
invalid bytes and a byte-order mark the same way in Node and in Convex, with no
decoder options.

Roster entry checks test each X25519 key with a fixed public probe scalar. X25519
clamps every scalar to a multiple of the cofactor, so a fixed scalar refuses each
low-order key exactly as a random one would, and the check needs no random source.

The server opens no value, holds no key and does not yet check signatures. It
accepts writes only from the project owner's stable device sign-in. Member
writes stay off until the server also verifies the public signatures with the
same code. Clients verify every reply in full and rely on none of these checks.
