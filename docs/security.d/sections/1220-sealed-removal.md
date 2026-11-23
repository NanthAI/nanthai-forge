### Sealed removal and rotate list

Removing an entry from a sealed set is one owner-device write that removes it and
re-keys the set: a new set key, every value re-sealed with its version, epoch,
author and signature kept, a wrap for each remaining recipient, and the next head.
A removed device cannot open anything written from then on. It keeps what it
already opened, so every removal prints the rotate list: the names it could open,
to rotate at their provider. A person runs it; an agent is refused with
`PERSON_REQUIRED`.

There are three routes to that one write:

- `nforge secret unshare FINGERPRINT` removes an automatic device (guard 7), and
  `nforge secret unshare DEVICE_ID` (the full 32-hex id) removes any entry.
- When a person loses write access to the project (an owner removes them, lowers
  them to read, or they leave), the server marks every entry of their account in
  each sealed set of the project and drops their waiting join request, in the same
  mutation. Holders see the marker on their next read, with the fingerprints. The
  next `nforge secret set` or `nforge secret rm` by a person on an owner device
  removes the marked entries and re-keys before its own change, and prints the
  rotate list. `nforge secret unshare --marked` does the same at once. An agent's
  write is refused with `SECRETS_REKEY_PENDING` while markers name entries, and
  automatic sharing waits until they are removed.
- A team change marks the same way: removing a member or the member leaving the
  team, unlinking a write team or lowering it to read, and deleting the team. Each
  member who has an entry or a waiting join request and no longer writes the
  project is marked; a member who still writes through a direct grant or another
  write team is not. Removing or leaving marks in the same mutation. Unlinking or
  lowering checks the first 100 team members in the same mutation and the rest in
  scheduled steps of 100. Deleting is the exception: the team stops granting at
  once, and its purge marks each write link's members in steps of 100 before that
  link goes. In both delayed cases the people already lack write access, so they
  cannot read a sealed set meanwhile.
- A marker that names no entry of the roster asks for nothing. A marker on the
  holder's own account (it still has access) or on a machine is never acted on:
  the notice names it, and only `nforge secret unshare DEVICE_ID` removes it.

Markers are a request: the server changes no signed record itself. A removed person
cannot read the set from Forge at all, because the read checks project write
access. Removing a person also drops their waiting join request, and the server
refuses an automatic addition whose join request is no longer waiting, so a share a
holder signed from an earlier read cannot add a device of someone who has just left.

Residual: holders act on a marker without asking. A compromised server can mark a
member who is still in the project, and the next person write removes that member's
entries in a signed step; adding them back needs a code (an account left with no
device counts as new under Automatic). Every holder sees each marker on its reads and
each removal it made. The server cannot mark the writer's own account into removal,
and cannot stop a removal from re-keying.

The rotate list is derived from signed records only: each live name whose value has
not changed since a removed device's last epoch, with that device's fingerprint.
`nforge secret list` prints it on standard error until each value is changed, which
seals it at a later epoch and takes the name off. Nothing is stored for it. A removed
machine or person key has no former-signer record, so its rotate list is printed
only when it is removed.

The server's markers reach Development, Checks and Production. Checks and
Production removal (owner devices and machines, in the cross-set order of design
d1) arrives with Checks delivery; today only Development converts markers.

Cost: removing a write member adds one indexed read for their grant, one per set
kind (at most three) and one patch per set it marks; removing a reader adds only the
grant read. A team change adds, per project it gives write to, one empty
indexed read per set kind when the project has no sealed set, and reads no team
member. Only a project with a set reads team members, at most 100 per mutation,
and checks write access only for the members its sets list. A removal write is one read
and one write, at most once per marked batch. Idle costs nothing.
