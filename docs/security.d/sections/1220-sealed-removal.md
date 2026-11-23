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
- Trashing a project revokes every grant but the owner's, and a restore brings
  none back, so the trash marks every other account its sealed sets list (an
  entry or a waiting join request) in the same mutation. The markers outlive the
  restore: a marked device opens nothing even if its person is invited back, and
  the owner's next person write removes and re-keys. Machine entries name no
  account and are never marked. Permanent deletion purges the sets and their
  history with the project's rows.
- Ending one device's sign-in from elsewhere marks that device alone, so a lost
  laptop is removed and re-keyed on the next owner write and its rotate list is
  printed. Signing a device out in Account settings, or removing it there or from
  the device, marks it in each project where that sign-in is linked to a sealed
  device, and drops its waiting join request. The first four projects are marked
  in the same mutation and the rest in scheduled steps of four; the sign-in has
  already ended, so the device cannot read a set meanwhile. The server links a
  sign-in when it writes a sealed set or asks to join one, and a device that only
  reads links itself once per project after its first verified read, when the
  read reply says it has no link yet. Only an entry of the sign-in's own account
  is marked. `nforge logout` on the device itself marks nothing: the person holds
  the device and its keys stay for its next sign-in. The set's last unmarked owner
  device is never marked, because no device could act on it. "Sign out
  everywhere" with devices (Account settings, by passkey or a fresh GitHub check)
  marks every sealed entry of the account, owner devices included, in every
  project where one of its swept sign-ins is linked, including sign-ins already
  ended by `nforge logout`; a sign-in issued after it started is kept. It is
  issued from a browser, which holds no sealed device, so no device is spared as
  the issuer. When the account holds every owner device of a set, that leaves
  none unmarked, so the device at hand clears its own mark: sign it in again
  (`nforge login`) and approve it in the browser that pressed "Sign out
  everywhere", after a fresh passkey or GitHub check there; the approval page and
  the checkbox hover say so. That action ended every other browser session of the
  account, the lost laptop's included, and keeps only the issuing one (the GitHub
  route keeps the fresh session it opens in that tab, and a GitHub check from it
  hands the role to its new session). The role lasts a week. A device approved in any other
  browser stays marked, so whoever holds the lost laptop signing in first clears
  nothing. Only an owner-role entry of the account is cleared, only while no owner
  device of the set is unmarked and the account still writes the project, so at
  most one sign-in per set is cleared; the set records it, so the sweep's later
  marking steps leave it alone, even after a write. Its next owner write removes
  the other marked devices and re-keys, with the rotate list. An approval that
  runs before the sweep's marks reach a set, or from a sign-in not yet linked
  there, clears nothing in it: the device reads the refusal and is approved again. A later sweep or an operator
  suspension voids the issuing browser, and a new sweep makes its own browser the
  issuer: if the issuing browser was signed out meanwhile, sign out everywhere
  again from the browser at hand. Residual: anyone who passes the account's own
  passkey or GitHub check can also sign out everywhere and become the issuer; a
  lost laptop holding a synced passkey or a live GitHub session is that case, so
  remove its passkey and end its GitHub sessions first. Approving a device code
  someone else sends you in the issuing browser clears that device, as for any
  device sign-in. Marking runs in scheduled steps, and
  the result is the same in any order.
  suspension signs devices out and marks none: it is a reversible switch. A device that
  was marked and signs in again reads `SECRETS_ROSTER_REFUSED` saying Forge
  marked it, until an owner device removes it. After that it is shared again:
  automatically under Automatic when its account has no other device in the set,
  otherwise from that account's other device with a code. One sign-in tracks at
  most 100 projects; at that bound links to deleted projects are dropped, and a
  sealed write or join in a further project is refused with `SECRETS_NOT_ALLOWED`.
- A marker that names no entry of the roster asks for nothing. A marker on the
  holder itself or on a machine is never acted on: the notice names a machine,
  and only `nforge secret unshare DEVICE_ID` removes it. A marker on another device
  of the holder's own account is acted on like any other (a lost laptop of the
  same person).
- Only an owner device removes another account's entry, marked or not. A write
  member's device removes only its own account's entries, so no roster step ever
  depends on a marker, which the server clears with the step that acts on it.

Markers are a request: the server changes no signed record itself. A removed person
cannot read the set from Forge at all, because the read checks project write
access. Removing a person also drops their waiting join request, and the server
refuses an automatic addition whose join request is no longer waiting, so a share a
holder signed from an earlier read cannot add a device of someone who has just left.

Residual: holders act on a marker without asking. A compromised server can mark a
member who is still in the project, and the next person write removes that member's
entries in a signed step; adding them back needs a code (an account left with no
device counts as new under Automatic). Every holder sees each marker on its reads and
each removal it made. A compromised server can also mark another device of the
writer's own account, which is removed the same way, and can mark the last owner
device (the last-owner rule is the server's, which a compromised server can skip),
leaving the set with no device that can read it. It cannot make a device remove
itself, and cannot stop a removal from re-keying.

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
and checks write access only for the members its sets list. Trashing a project
adds one empty indexed read per set kind when it has no sealed set; with sets, it
reads no grant or member and patches each set it marks. Ending a device sign-in
that never wrote or joined a sealed set reads nothing more; one with links reads
each linked project's set kinds (at most three each) and patches each set it
marks. "Sign out everywhere" adds no read to its sweep pages. It covers every
swept sign-in with links, including ones signed out earlier, and marks each
(project, device) pair of a page once, in steps of up to 100 pairs (at most one
step per swept sign-in); each step reads the set kinds of four projects at a
time and patches each set it marks. The sweep start writes its issuing browser and
epoch on the account row it already patches. A device approval reads nothing
more unless it is in that browser with a fresh check and the device has links;
then it reads each linked project's set kinds (four projects in the approval,
the rest in scheduled steps of four that re-read the account row), the project
row and its write check only for a set it clears, and patches each such set. The
approval page reads the account row once for a known device with links. A sealed write or join patches its sign-in once, the first time per project
and device, and reads nothing more. A read tells an unlinked sign-in so from its
credential row, already read; that device then makes one link call per project,
once (one set read and one patch). A removal write is one read and one write, at
most once per marked batch. Idle costs nothing.
