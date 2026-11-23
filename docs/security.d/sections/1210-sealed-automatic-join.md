### Sealed Automatic join

A new Development set starts in Automatic sharing (owner decision 2); an owner can
switch it to Confirm. Automatic exists for Development only: the CLI checks the
kind with a constant, and the server refuses a join request for Checks or
Production with `SECRETS_NOT_ALLOWED`. A Checks recipient always needs a person.

When a write member's device with no Development pin runs `nforge run` or any
sealed read, and its account has no device in the set, it posts one join request
(`sealedSecrets:join`) and stops with `SECRETS_WAITING`, printing its own
fingerprint. The request carries the device's public keys and its signed account
binding, nothing else; display text is `new device`. The server decodes it with
the same portable code the CLI uses and stores it only when it names this project
and the caller's account, the caller is a write member on a stable device sign-in,
the stored roster is in Automatic mode, and the account has no entry. It keeps one
request per account (a newer device replaces it, the same bytes are a replay) and
at most 32. Only a roster step clears requests: the one that adds that device,
one that gives its account an entry, or one that leaves Automatic (which clears
all of them).

On its next sealed read, an owner device that holds Development plans one share per
waiting request, re-checking every field it signs: the device is not in the roster,
its former list or a removal marker; its account has no entry; the entry is a
member device added automatically (role member, `how` auto), never an owner, a
machine or a person entry; its fingerprint matches no listed, removed or planned
device. Machines and person keys never wrap. A device shares at most three times a
day, reserved under the local lock before any wrap is built, so concurrent runs
cannot exceed it. The new entry, the
transition, the set-key wrap and the next signed head go in one write. Every other
holder derives the notice from the signed step, so a server cannot hide the share
from a holder without forking that holder's history. The wrapping device keeps its
notice, naming the project, the fingerprint and Undo, across restarts and agent
commands until it is shown on a person's terminal. A share Forge refuses, reports
as not stored or never confirms stays recorded as unconfirmed: it keeps its daily
slot and its notice, because the set key left in that request. A refusal pauses
automatic sharing on that device for a day.

The joining device's next read accepts the served roster through an
`automatic-join` anchor only when it is Development in Automatic mode, its own
local join record exists, and the roster lists this device, with its own keys and
account, as an automatic member. Its pin records `confirmed: tofu`. Its first run
prints its fingerprint and its account's devices; later reads list them again when
they change. Every other first contact keeps needing an explicit anchor.

Undo is `nforge secret unshare FINGERPRINT` (an automatic device) or the full
32-hex device id (any device), run by a person on an owner device:
one write removes the device and re-keys the set (new set key, every value
re-sealed, a wrap per remaining recipient), then prints the names to rotate at
their provider, because the key was handed over. Repeating it after an unknown
outcome reports the device as already removed and prints the same list. See Sealed removal and rotate list for the other routes.

Residual, accepted with owner decision 2: the joining device trusts that first
roster on first use. A compromised server can show it a fake Development set built
for it and, separately, add a device of its own for any account that has no device
yet; the only cross-check is the fingerprint the waiting device, its first run and
the holder's notice print, 40 bits that a server grinding keys (about 2^40 tries)
can match. Keep in Development only credentials the team could
rotate in an afternoon. A tofu pin never upgrades itself (a rebuild from the
device's own head keeps it when its signed entry was added automatically), Checks
never accepts this anchor, and a tofu Development pin is refused as the trusted
Development for any Checks read. `SECRETS_WAITING` is not retried in a loop: each
try reads the whole set.

A sealed write whose arguments fail the server's argument check (an older CLI
against a newer server) stops with `CLI_UPDATE_REQUIRED`: nothing was stored, the
retry journal drops the request, and the change is repeated as a new operation
after `nforge update`.
