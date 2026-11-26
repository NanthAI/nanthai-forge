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
markers, so the step's signer must hold the authority for that shape; that
signer must also be a device or person key of the signed-in account. The head
must be signed by a write device of the roster after the step, that device's
account must be the signed-in account, and no marker may name it. The head is
checked against the stored head the way every holder pinned there checks it:
versions, floor, tombstones, unchanged records, and the author and change
signature of every changed name. Every record, changed or not, must name an
author on the roster or among its former signers, so no step can drop a former
signer that a record still names; readers apply the same rule. Development accepts a
proposal record only when the write answers the matching waiting proposal.
A Checks or Production genesis or roster step reads the
stored Development roster (one indexed read) and must meet the cross-set owner
rule: every owner account on the new roster has a Development owner device. With
no Development set it is refused. A value write on an unchanged roster does not
read it again. Every ciphertext must name one live record and match its signed
hash, every live record needs its ciphertext, and there is one wrap per roster
entry, each naming a different recipient on the roster. A genesis roster is
checked in full. A refused write stores nothing.

A step checks the curve operations (the agreement-key probe and the device
binding) only for the entries it adds. Every other entry carries keys that a
checked roster already held, and the roster hash binds them, so it gets the
structural rules only. The server's own induction starts with this check:
rosters stored before it were checked by every reader, not by the server.
Readers do the same after checking their starting roster once, so walking 64
steps costs one full roster check, not 64.

The work of one write is capped before any signature check: two units for each
added entry (the agreement probe and the binding) and one for each changed name
record, at most 100 units (`SEALED_WRITE_WORK`). A genesis roster is checked in
full, so it counts two units for every entry it lists. A bigger write is refused with
`SECRETS_FORMAT_REFUSED` and must be split. The CLI changes one name per write,
and an automatic share adds at most 32 devices (the waiting join requests), so
honest writes stay well below the cap. Measured in the V8 bundle at 100
recipients and 200 names over three runs, the worst capped writes take 125–140
ms median for a 50-device step and 152–162 ms median for 100 changed values
(157–258 ms on a cold first run), and refusing an over-cap write takes 11–19 ms.
Without the cap, 200 changed values would take 282–305 ms median, and 99 added
devices with 200 changed values 489–551 ms median (up to 756 ms cold), against
the 1 s mutation limit.

Some rules need the set key, which the server never holds: the key commitment,
the wraps opening (wrap bytes are not checked) and each value's commitment. A
head that passes the server's checks but fails one of these is stored, and every
holder refuses it. Bad wrap bytes for one recipient lock out only that holder:
the others open the set as before. The server opens no value and holds no key. Clients verify
every reply in full and rely on none of these checks.

Who may write: the project owner starts a set; after that any current write
member on an unrestricted stable device sign-in may store the next head, with
write access re-read in the same mutation, so a member removed or lowered to read
is refused at once. The head rules above decide what that member may sign: a
Development member device changes values and its own account's entries; roster
shapes reserved to owners (sharing mode, roles, other accounts' entries, the
Checks pointer) and every Checks head need an owner device. Until the code
journey binds the joining account on the server, only an owner device adds
another account's first device: its key alone would bind it to any account id.
A member's CLI writes
only on a roster it confirmed with a code: a device that joined automatically
trusts Development on first use, and a value it sealed into a set a compromised
server built for it would reach that server. For the same reason such a device
approves no code, for any purpose. While Forge has marked another
account's entries or the member's own other devices, a member's write stops with
`SECRETS_REKEY_PENDING` until an owner device removes them and re-keys.

Residual of member writes: a write member can store a head that passes every
public rule but fails one that needs the set key, such as a wrong key commitment.
Every holder then refuses that head, and since each write must extend a head its
writer verified, no holder can write the next one either: the set stops until
restore-previous (Item 0433ce4a) is built or the set is replaced. A member could
already harm the set as a holder (it can read every value); this adds an
availability attack that needs no value. A targeted variant sends bad wrap
bytes for one holder, such as the sole owner: only that holder is locked out, and
members then wait on `SECRETS_REKEY_PENDING` for an owner who cannot open the key.
The signed head names the member's device that did it. Restore-previous fixes
both, so member writes do not reach beta users before it lands (a condition on
Item 0433ce4a).
