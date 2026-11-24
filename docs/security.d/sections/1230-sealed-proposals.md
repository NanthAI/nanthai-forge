### Sealed proposals

A proposal is how a device that may not change a value directly asks a person to
change it. The format and its checks are local functions (`src/sealed-proposal.ts`);
the public checks that need no key are shared with the server
(`src/sealed-proposal-check.ts`). Forge stores Development proposals; no command or
agent tool creates or applies one yet, so agents and member devices are still refused
when they change an existing value.

Storing. `sealedSecrets:propose` takes one record for the active Development set from
a stable CLI device sign-in with write access. Before it stores anything, the server
checks the exact record schema and runs the same public checks a holder runs on the
stored head, roster and markers: the current epoch, an unmarked author that is a device
of the signed-in account, operation, kind and name, the ciphertext bounds and digest,
and the proposal signature. It opens nothing and holds no key. A set waits on at most
32 proposals and 256 KiB, and one device on at most 8; a newer proposal from the same
device for the same name replaces the older one. The set row remembers the last 64
proposal ids that left the list, so an applied or rejected proposal is not stored again
(the holder's own journal of applied ids is the client's check). A Development head write may carry a proposal record only when
it answers a waiting proposal from that record's author, for that name and epoch; the
same mutation removes it. The write also removes the proposals it names as resolved
(adopted or rejected with it), and a re-key or roster step removes proposals from an
older epoch or from a proposer no longer on the roster or marked for removal. Marking a
proposer (a person removed, or a sign-in ended) removes its proposals in the same
mutation. `sealedSecrets:reject` removes waiting proposals without a head write: a
proposer's own account withdraws its own from any write-scoped device; another
account's proposals need a sign-in without restrictions whose account has an unmarked
write device on the roster, and the whole call is refused if any known id is not
allowed. Checks heads still carry no proposal record, and
Checks takes no proposals yet. Holders rely on none of these server checks: every
holder checks a proposal again before it opens one.

Sealing. The proposer works from its verified view of the set. A device that trusted
Development on first use (it joined automatically and has no code yet) proposes
nothing, just as it writes nothing. A Checks proposal also needs a Checks view confirmed by a code or held by this device (GB-08 d4), and
the proposer must be listed in the Checks head's approved proposers. The value is
packed exactly like a stored value: length, a hidden random `r`, the value, and zero
padding to its bucket. It is encrypted with AES-256-GCM under a key from a fresh
X25519 agreement with the set's inbox key. The key derivation and the encryption
both bind the project, set, epoch, proposal id, name and operation. The ciphertext
is 272 to 69,648 bytes. The proposer signs two things: the name record at the
version it would get, and the whole proposal, which covers that change signature,
the value commitment and the ciphertext digest. That version is the one above the
higher of the name's current version and the view's floor. In a full set, a new name
is computed after the compaction the applying write makes, so the proposer signs the
version apply will compute. `baseValueVersion` is
the name's real version and is used only to detect conflicts.

Opening. A holder of the set key derives the inbox key from it. It checks the exact
record schema, the current epoch and an unmarked author on the roster (Development)
or on its trusted Development roster (Checks). It also checks that the operation,
kind and commitment agree, the name is accepted, the size is within bounds, and the
proposal signature and ciphertext digest match. Then it decrypts and checks the
padding. A proposal from before a re-key is a conflict (`WORK_CONFLICT`).

Applying. The applier has write authority and works on the verified head that its
write replaces. The version is computed from that head with the same rule as a
direct write; the proposal's own claim never sets it. A base that changed since the
proposal is `WORK_CONFLICT`, never `SECRETS_ROLLBACK`. An unchanged base means one of
these:

- the same live version, for a change or removal;
- for an addition, the name absent then and now;
- the same tombstone;
- a tombstone that compaction has since dropped under the floor.

When the proposer's change signature is valid at the computed version, the record
keeps that signature and its proposal id. The value commitment must then match the
value, and readers name the proposer and the head's signer. When
compaction has raised the floor since the proposal, the signed version is stale. In
Development the applier then adopts the value: an ordinary change it signs, with the
same `r` and no proposal id. The proposer recognises its value by the `r` it kept. A
stale Checks proposal needs a new one, because its proposer cannot open the value to
recognise an adoption. In both cases the value is re-sealed under the set key with
the proposer's `r`. Reader floor checks are unchanged.

Limit, stated: an adopted proposal's own change signature and commitment are made for
a version the applier no longer knows, so they are not checked. The proposal
signature still covers both, along with the ciphertext, so the value applied is the
one the proposer signed.

Limit, stated (review L1): for an addition, a base reads as unchanged when the name is
absent and the base is at or under the floor. That check cannot tell "absent ever
since" from "added, removed and compacted since". A hostile server could serve an
applied Development addition again after the name was removed and its tombstone
compacted in the same epoch. A person who approves it would bring the removed value
back as their own change. The applying device's journal of applied proposal ids,
built with the command that applies proposals, closes this.
