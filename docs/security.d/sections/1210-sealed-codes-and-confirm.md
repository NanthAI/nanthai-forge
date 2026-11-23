### Sealed codes, confirmed pins and roster repair

A device that has no trusted way to a set uses a four-word code with a two-word reply
(design 4.13). There are four purposes: add a device, raise a member device to owner,
make a Development device a Checks proposer, and re-pin a lost or too-old view. The
requester fixes the roster view it holds before it draws a 16-byte nonce. The code is
the first 44 bits of scrypt (N=2^17, r=8, p=1) over the framed request, read as four
words from the fixed 2,048-word BIP-39 English list (MIT notice in `src/sealed-words.ts`).
The reply is the first 22 bits of SHA-256 over what the holder signed, read as two words.
Typed words match by whole word or 4-letter prefix, in any case. Input that does not parse
costs no attempt. A wrong entry costs one, and the third closes that side
(`SECRETS_CODE_CLOSED`). A closed request keeps no nonce; the person starts a new one.

The holder must be a person (`PERSON_REQUIRED`) at a terminal with a confirmed pin of the
same set. It approves only on its own current roster, from a server read verified in that
process, and each read approves once; a Checks approval also needs a fresh Development read. A
stored, offline, already used or self-written pin is refused (`SECRETS_NOT_ALLOWED`).
A request at any other roster version or hash is refused (`SECRETS_CODE_ROSTER_MISMATCH`)
and the new device starts a new request after both read again. An older view the holder
once trusted is refused too: it could still list a device removed since. Only on a
matching code does the holder sign the transition, proposer head or re-pin statement. The
requester checks the signature, then derives the reply from those exact bytes. A staged
approval on any other roster gives a different reply. Only a matched reply mints a code
anchor for the verifier, and the anchor is what the holder signed: for add and raise the
roster after the approved step, for proposer and re-pin the roster the signed head names.
The verifier requires the served chain to pass through that roster; an older one is
`SECRETS_ROLLBACK`. Proposer and re-pin also treat the holder's head as a floor: a lower
head is `SECRETS_ROLLBACK`, and another hash at that version is `SECRETS_FORK`. A re-pin replaces only a lost or too-old pin. A pin
that still verifies is never replaced (`SECRETS_NOT_ALLOWED`). "Too old" is judged
against the holder-confirmed view, which must be more than 64 roster versions ahead,
never against the served history alone. A server that drops one transition cannot make
a healthy pin replaceable. A readable old pin also stays a floor
(`SECRETS_ROLLBACK`). Before typing, the holder sees what a match grants: the request's
claimed account handle, its device name and fingerprint, and the role it would get. The
account is the request's own claim, so it is shown, not trusted.

Every Checks and Production pin records how it was confirmed: `code`, `holder`, `machine`
or `none`. A pin from a walk-only Checks genesis anchor is `none`. It shows names but
opens no wrap (`SECRETS_CODE_NEEDED`). Its holder cannot approve a code, propose a value
or post a join request. Approving needs a `code` or `holder` pin. Wraps are made only
from a key the verifier opened on a confirmed base, or at genesis. A code upgrades the pin only after the reply
matches. Code paths enforce the proposal and join gates (`requireConfirmedBase`). A
source guard test fails in either of two cases: code that builds a proposal or join
skips the gate, or a new wrap producer or code-anchor minter appears unreviewed. Adding any
Checks or Production recipient needs a person, both in the transition builder and in the
holder approval.

Repair (GB-08 d5). A Checks or Production roster can break the cross-set rule because
of a later Development change, with no Checks write at all. Its values stay refused on
read (`SECRETS_ROSTER_REFUSED`). One write is then allowed. A person on a full owner device
of that set repairs it: the device's own account must still have a Development owner
device, and its pin must come from at or before the breaking roster. Repair verification
runs every check except the final cross-set rule. The result is never pinned, never
handed to `run` or `list`, and never cached. The set key is opened only to re-seal. The
repair removes each offending device and everything it added, transitively through
`addedBy`, unless the person keeps an entry by name. A kept name must match exactly one
entry in the roster, or the person names it by id. An offending device is never kept.
Proposer approvals that a removed device made are dropped. Values that a removed device
wrote are listed for review. The repair also drops pending proposals and
re-keys in the same signed step: a new key, every value re-sealed with its version,
signature and commitment kept, a wrap for every remaining recipient, and a new head the
repairer signs. Readers, including fresh ones, walk through the broken roster to the
repaired one. A healthy roster has nothing to repair (`SECRETS_NOT_ALLOWED`). If no
Checks owner device passes the rule, the error names the only way out: replace the
Checks set from a Development owner device (4.18). Members then confirm their proposer
code again.

These are client foundations. The sharing commands that drive them ship in later slices.
