# Project access

Who can do what in a Forge project, and where the server enforces it. The rules follow GitHub's model, frictionless but secure: three roles, invitations by link and email, agents that never get more than their person. The screen is **Settings → People and access** in the rebuilt app (`/{handle}/{project}/settings`).

Status: the roles, verbs and resolver below describe what runs today. The parts marked *proposed* wait for the owner's approval on the Items named beside them.

## Roles

| Forge | GitHub | Who |
| --- | --- | --- |
| **owner** | admin (repository owner) | The account that owns the project. One per project today; an organization owner is *proposed* (`1e474c35`). |
| **write** | write | People the owner invited with write access (stored as contributor grants). |
| **read** | read | People the owner invited with read access (reader grants). On a private project this is the only way to see it without writing. |
| public | anyone, on a public repository | Anyone, signed in or not, on a public project. Not a role: it grants reading only. |

There is no maintainer or triage role. A guidance-maintainer assignment authorizes agent guidance and project metrics only ([security](security.md)).

The role is resolved in one place, `projectRole` in `convex/projectRole.ts`, from current grants only: the owner costs no database read, a write member one indexed read, a reader at most two. A grant can also come from a [linked team](#teams); the effective role is the highest of the direct grant and every linked team. There is no cached membership, so removing a person, lowering write to read, or removing them from a linked team takes effect on their next call, and on every call of their agents. The same resolver answers the access checks in `convex/projectAuthority.ts`, the public identity rule (`convex/publicPeople.ts`) and member labels (`convex/projectActorNames.ts`).

## What each role may do

The table is `projectVerbs` in `convex/projectAccessContract.ts`; `projectMay` gives one answer and `projectAnswers` all of them. The server functions named here enforce each verb; the screen only shows the answers.

| Verb | public | read | write | owner | Agents | Enforced in |
| --- | --- | --- | --- | --- | --- | --- |
| Read code, history and plan (`readSource`) | public projects | yes | yes | yes | same as their person | `accessibleProject`; signed out, the cached public route (`publicCode`, `projectCodeBrowse.visitorRead`) |
| Read Lanes, receipts and checks (`readWork`) | public projects; Lane titles follow the project's opt-in | yes | yes | yes | same | `accessibleProject` |
| See the roster by handle (`readPeople`) | no | self and nobody else | yes | yes | same | `publicPeople` |
| Full Work archives (`readArchives`) | no | no | yes | yes | same | `memberProject` |
| Start, save and abandon own Lanes, edit the plan (`changeWork`) | no | no | yes | yes | same | `activeProject` |
| Land own Lane with a check (`landWithCheck`) | no | no | yes | yes | same | `activeProject`, abuse limits |
| Land without a check (`landWithoutCheck`) | no | no | if the policy picks them | yes | never | `projectUncheckedLanding` |
| Act on others' Lanes and landings (`actOnOthersWork`) | no | no | no | yes | same | per-member authority ([security](security.md)) |
| Invite, add people, give read (`addPeople`) | no | no | no | yes | held for the person | `projectContributorActions`, `projectReaderActions`, `projectMemberRequest` |
| Remove people, end invitations (`removePeople`) | no | no | no | yes | same | `projectContributors.remove`, `projectReaders.set` |
| Change settings and policy (`changeSettings`) | no | no | no | yes | held | `projectAutonomy`, `projectSettingApprovals` |
| Approve a protected path (`approveProtected`) | no | no | no | yes | never | `projectHostedApprovals`, `projectHostedAcceptance` |
| Secret values, permanent delete, runner keys, public or private, public or members-only plan (`ownerPersonOnly`) | no | no | no | yes | never | `requireOwnerPerson`; visibility: `projectVisibility.setVisibility`; plan: `publicDiscovery.setSettings` |

Agent coordination (sessions, messages, handoffs, claims, activity counts and the feed), the board and the agent session holding a Lane follow one [audience rule](#audience): they belong to the project's team.

Sealed secret writes are authorised by device keys in the signed roster. The
storage endpoint accepts a write member (the owner included, write access re-read
in the same call) on an unrestricted stable device sign-in with source-write
access; only the project owner starts a set. The head must be signed by a device
of the caller's own account with write authority in the roster (any Development
holder device; owner devices only for Checks and roster changes reserved to
owners). Scoped, read-only, browser-only and keyless agent credentials cannot
write sealed records. Readers verify the
roster and signatures locally; the server stores ciphertext without decrypting.
Agent and
non-interactive entry points can add new Development names in slice 1; changing
or removing an existing name needs a person until proposals ship.

"Held" means an agent's request opens an exact approval request that its person approves or declines in a browser; nothing changes until then. "Never" means an agent's credential is refused even when its person may.

## Agents

Agents act through a device their person approved with `nforge login`. A device narrows its person's rights and never widens them; the device record, its settings and its sign-ins are owned by `df06081d` (sign-in, devices and sessions). A live session is presence, not an access row: it holds a Lane, and the People and access screen lists devices inside their person, never sessions as grants. Agent-run names (`account/slug`) resolve to their person by the public identity rule.

### Account changes from devices

Changing the handle is browser-only for the person signed in on the web. Every
device credential, including an unrestricted one, receives `AUTH_SCOPE_DENIED`:
“Change your handle on the web: Settings → Account”. The CLI keeps its earlier
handle command as that same refusal and does not send a write.

Account → Your data is person-only: its inventory, metadata export, the deletion
review, the cleanup itself and its receipts answer only the person signed in on
the web. Every device, agent and legacy CLI credential, including an unrestricted
one, receives `AUTH_SCOPE_DENIED` before any account row is read. A cleanup leaves
exactly the shared teams, projects (as a contributor or a direct reader), imports
and Source Zones the person reviewed, with the access each gave them when it was
read (a changed maintainer flag counts as a change): if any of them changed after
that review, it refuses before registering anything, and the person reviews again.

Closing the account (Your data, once it holds nothing) is person-only too, behind
the typed handle. Another person's handle is refused, so nobody closes an account
but its own person. The close refuses with the next step while the account holds
or is shared anything, or while an earlier deletion runs. The close then ends
every device sign-in, every waiting device code and every native browser session.
Only after that does it check the holdings again. In one transaction it then
removes the passkeys, username, current handle and account row. If anything is
held by then, the account stays whole. The native user gets a fresh account key
and keeps only a GitHub numeric id (and any conflict mark). The next GitHub
sign-in therefore starts a new, empty account and never acts as the closed key.

Selected-project and read-only devices cannot make account-level writes, including
team changes, project creation, import starts and saved-view writes. The public
wrapper decides from the credential it already reads. Public actions and
mutations without a resource selector declare their account device rule at
registration. Unrestricted devices keep their existing account-write rights,
subject to the same person-only rules. Adding team members by handle or email
requires the person in a browser: the existing membership approval store is
project-bound, so team additions use the refusal alternative and grant nothing
from a device. Project membership additions retain their existing held request.

## Protected-path approvals

An owner's approval of a held landing (`projectHostedAcceptance:approve`, the owner person in a browser; agents never) is bound to what the protected paths will contain when it lands, not to the main head (Item `fe2b0a86`).

- **Binding key.** The protected entries of the Candidate's changed-file listing: each path the current policy protects (owner-approval paths, `acceptance.protectedPaths` and derived check entries, by the same matcher as the hold), with its status and before and after content hash and mode, plus `.forge-secret-allow.json`. The listing is the pinned R2 object compose already writes; no file contents are read.
- **Equality rule.** When main moves under a held or approved submission, the recomposed Candidate keeps the approval only if its binding key equals the approved one and the owner, Lane inputs, dependencies and policy digest are unchanged. Before-content is part of the key, so main changing an approved file asks again even when the merged result is the same.
- **Fail closed.** The whole changed-file list must match, as before, when the hold has any reason besides protected paths (supervised review, auto-accept list, unknown coverage), for a folder-grant landing (the owner's acceptance also stands in for its grant check), when either Candidate's changed paths are unknown, when the project has no derived check-entry list, or when the approved Candidate has no protected entry. A removed or mismatched listing, an unparsable one or a changed Candidate record asks again. A failed R2 read retries the finish instead, so an outage does not ask the owner again.
- **Audit.** The receipt's `previous` names the main the carry was checked against (the accepted attempt's base), and the landed submission's `acceptance.acceptedBy.carried` is true.
- **What a carried acceptance covers.** The owner approved the protected entries. The rest of the merged result is main's already-accepted content plus the Lane's unchanged content, so `acceptedBy` names the owner for the protected paths only.
- **Later submissions of the same work.** A held agent submission of the same Intent (a fix after a failed check, or a conflict-resolution Lane's submission: a resolution Candidate keeps the conflicting Candidate's Intent) reuses the owner's approval for its protected paths only. At submission it reads the Intent's recent held submissions once (`by_project_and_intent_and_held_intent`, at most 4 rows, newest first; `heldIntent` trails the existing Intent index, so no landing row writes an extra index entry). It takes the newest approval: a grant, or one a later submission verifiably carried. The search stops at a landed or declined submission. While held, the finish compares the approved and current listings' protected entries once per Candidate (`protectedCarry.verified` or `.refused`), with the same binding key as above. It first reads the Intent's recent held submissions again, so a decline or landing since the submission ends the approval. A match releases the hold the way an approval does. Publication then removes only the paths that comparison recorded (`protectedCarry.paths`) from the hold reasons: the submitter stays the acceptor, so supervised review, the auto-accept list, folder grants and any path protected only through the run's own check entry still apply. Another owner, a changed policy, no exact check, a gone or changed record or attempt, an approved submitter who no longer has access, unknown paths or check entries, or no protected entry all ask again. Intents belong to the project: another writer's submission of the same Intent with byte-identical protected entries reuses the approval for those entries, and everything else in it still goes through that writer's own policy. `acceptedBy` stays `auto` and records `protectedApproval` (the approved submission, when, and which paths).

Scale: no Convex call, read or write is added. The scope comes from the project row the finish step already reads; the comparison reuses its two R2 listing reads. Idle work stays at zero. For later submissions: unheld submissions add nothing. A held one adds one bounded indexed read at submission (at most four rows). When it finds an approval, each Candidate is compared once: one attempt read, the same bounded indexed read again and two Candidate record reads in the finish step, one listing query and two R2 reads in the finish action, one resume and one small field write. Only the paths that comparison found equal are lifted at publication.

## Private projects answer not found

Without a role, a private project answers exactly like a missing one: `PROJECT_UNAVAILABLE` from every function, and "No project here" on the page. An agent refusal reads the same. A visitor can never learn that a private project exists from an address, an invitation link, or the error.

## What leaves Convex

The owner reads their whole project row. Everyone else, members and signed-in readers of a public project, gets an allowlist from `projectWork.state`: id, creation time, owner, key, name, address, visibility, plan setting, selected source, revision, Work pointer and removal state ([convex/projectViewerFields.ts](../convex/projectViewerFields.ts)). Policy, purges, retention, pending owner operations, project guidance and storage internals stay in Convex. A new project field stays owner-only until it is added to that list.

Policy copies (the `policy` read, landing settings, agent capabilities, the workspace, pinned landing attempts, capsules and briefings) still show the project's rules to every reader. The public boundary ([convex/publicPeople.ts](../convex/publicPeople.ts)) removes stall-alert addresses (`email`) and check-runner credential references (`credentialsRef`) from every public result for anyone but the owner. Changing policy is owner-only, so no reader needs them for a compare-and-swap. Both projections use rows the read already loaded, so they cost no Convex read. Guard: `tests/project-viewer-fields.test.mjs`.


## Invitations

The owner invites by Forge handle or email address, choosing read or write access.
Every invitation is pending until its recipient presses **Accept**. Creating an
invitation or signing in grants nothing. Until acceptance, the owner sees only
what they typed and the invitation state; Forge does not look up an email during
creation. Handle invitations bind to the selected account; email invitations bind
to the signed-in person's current, unique verified address at acceptance. A read
invitation never lowers existing write access. Accepting write replaces read.

Recipients see **Accept**, **Decline**, and **Decline and block inviter** on Home
(`/account`) and the invitation page (`/account/people`). A link opens that
page and carries no credential, email or private project identifier. Signing in
preserves the destination. Choose **Use another account** on the invitation page
to sign in with the invited account and open its inbox. A forwarded link grants
nothing and reveals no other account's invitations. Blocks belong to the recipient, apply across projects,
suppress later invitation mail, and can be undone in **Blocked inviters**. They
are never exposed to the inviter.

Invitations expire after seven days. Expiry is checked when answering, resending
and preparing delivery, with no expiry timer, polling or background deletion.
Expired invitations leave the recipient inbox; the owner's history retains them.
Accepted, declined, cancelled, replaced and expired invitations cannot be resent;
send a new invitation instead. Replacing an invitation ends the earlier one. A
resend keeps the original expiry. An interrupted send becomes retryable after ten
minutes; a late completion cannot settle a newer attempt. Invitation states and
mail state are retained and paged on People and access. Existing invitations use
their creation time plus seven days when they have no explicit expiry.
The older Access settings show pending invitations from the same pages. Use
**More invitations** to continue through earlier pages.
Rows from before this change must prove their inviter through the original
invitation operation, and that inviter must still own the project.

Removing a member or lowering them to read ends their earlier open invitations to that project, including
email invitations accepted by that account. A fresh invitation can be accepted
even if created in the same millisecond as removal. A project generation and a
recipient removal marker enforce this without scanning invitation history or
looking up pending email addresses for the owner. Unbound email rows retain the
owner's original projection; removal reveals no address-to-account match.

An email invitation uses the existing alert sender's account, token and from
address, but only when `FORGE_INVITATION_EMAIL=1`. The invitation switch is off by
default; configuring alerts alone does not enable invitation email. A sender
needs a verified identity (a verified email or connected GitHub identity).
With email off, a verified owner can still create the invitation and copy its
link. Every accepted send shows the same receipt, "email submitted", with Resend
and Copy link as the next steps. A provider rejection or network failure is an
operator log line (status only), not shown to the inviter, because a suppressed
send can never fail and a visible failure would reveal it. A send that never
settles shows "send interrupted" after ten minutes. Email content uses the inviter's handle, the project's
current address and the role, with no tracking pixel or rewritten link. The
production sender domain remains part of the Phase 8 production move.
The switch must remain off until the email-enablement requirements on
[invitation email Issue c6629fda](https://dev.forge.nanthai.tech/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=c6629fda-c29f-48e9-b677-5094e5cf0d9b)
are complete, including on dev.

Invitation limits are checked together before any write, including explicit resends:

| Scope | Limit |
| --- | --- |
| Inviter, across projects | 20 invitations per UTC hour and 100 per UTC day; handle, email and explicit resends share the allowance, including with email off |
| Invitation | 3 resends per UTC day |
| Project | 50 open email invitations; accepted, ended and expired rows do not count |
| Deployment, across projects and accounts | 500 invitation emails per UTC day |
| Recipient address, across projects and inviters | 3 invitation emails per UTC day |

Over an inviter, resend or project limit, the operation refuses with
`RATE_LIMITED` and writes and schedules nothing. Retry the same operation id after
the relevant window. The deployment and recipient caps never refuse: the
invitation is created (or the resend recorded) and stays pending, its row reads
"Email not sent today (daily email limit)", no send is queued and neither cap is
charged; copy the link, or resend after the UTC day ends. Exact completed retries
charge nothing and send nothing again. Counters reset in place, inside the
existing send transaction. Recipient counter keys contain a digest, not an extra
copy of the address. Deployment, recipient and resend-email allowances apply to
actual queued email; with email off only the inviter allowance is charged.
Invitation targets longer than 254 characters are refused before database reads.

Mail to a recipient who blocked the inviter, or who was removed after the
invitation, is suppressed without telling the inviter. The queue and the send use
one check (`invitationMailSuppressed`). It always makes the same reads and checks
every verified account on the address, so an address shared by two accounts keeps
each account's blocks and removals. A suppressed pair is never charged to the
recipient's daily counter (a blocked inviter cannot use up someone's allowance);
it is charged to its own per-pair counter with the same limit, so one inviter meets
the cap at the same send either way and both paths write the same number of rows.
The queue-time decision travels with the scheduled send: mail queued while
suppressed stays unsent even if the block ends before delivery, so it never
reaches the recipient without its charge. A suppressed send records what a real
send with that sender setup records (`sent`, or `off` without a sender) and makes
no provider request. Every send, real or suppressed, settles 10 seconds after its
action starts; the provider request gets at most 8 seconds and never runs past
that deadline, so the settlement time does not reveal suppression either. The
check's result is never returned to the inviter. Two cooperating inviters can
still compare the recipient's shared counter; that is the cost of keeping blocked
inviters from using it up.

The first four inviter/project limits above were approved by the owner. The
500/deployment/day and 3/recipient/day caps, separate off-by-default email switch,
and verified-sender requirement are reversible lead defaults under the owner's
delegation for security defaults, recorded on c6629fda; the owner can change them.

The person approves an agent's membership request before it creates a pending
invitation. That approval grants no invitee access: the recipient still accepts.
The older project add and reader-sharing entry points follow the same pending
path. Devices cannot accept, decline, block or unblock for their person.
The legacy `add` and `addByEmail` retry keys cannot create another invitation
after their first one ends; they return `BAD_ARGUMENT` with the next step to send
a new invitation in People using a new operation id. Explicit invitation and
answer operation ids retain their original retry behavior.

### Team invitations

Adding someone to a team, by address or by Forge handle, is an invitation:
nothing is granted until that person accepts on Home. Teams carry project roles
([Teams](#teams)), so a direct add could give project access the person never chose.

An owner invites an email address to a team in **People and teams**. Creating
the invitation looks up no account and asks no identity provider. The owner sees
the typed target and "pending" and can cancel it; that read is the same whether
or not an account uses the address. The invitation becomes team membership only
after the person with the current verified address chooses **Accept** on Home.
Declining leaves membership as it was. Blocking uses the same recipient-owned
preference as project invitations. Removing a member ends earlier invitations to
that account. A new invitation can be accepted after removal.

The same inviter counters cover project and team invitations (20 per UTC hour
and 100 per UTC day for an inviter, owner-approved 2026-11-21). The team path
uses Home for delivery and sends no mail. Before address invitations became
pending, an address could be added directly; a retry of such an original add
replays its retained receipt and grants, charges and invites nothing.

An invitation by Forge handle (`teamActions.addMember`, `@handle` or the bare
handle; the web People and teams forms take a handle or an address in one field and route by the `@` after the first character) binds to that account and asks no identity provider. It charges the same
inviter counters, and the owner sees the typed target and "pending". It appears
on that account's Home with **Accept**, **Decline** and **Decline and block
inviter**; another account neither sees nor answers it. A block also keeps the
person's verified address, as for project handle invitations, so it suppresses
later invitation mail too. A handle that is already a member (the owner
included) writes nothing. An exact retry with the same operation id returns its
first answer from the retained row, even after a rename or acceptance; the same
id naming anyone else is refused (`WORK_OPERATION_CHANGED`). Before handle
invitations became pending, `addMember` granted at once and kept no receipt. A
retry naming a current member grants, charges and invites nothing; after that
member left, the retry is a new request and becomes a pending invitation.

## Teams

Decision (`b6588425`, owner 2026-11-07: a shared team object, as GitHub organizations have; lead 2026-11-22: a separate link row per project). Teams are owner-managed groups (**People and teams**). They already choose who may land without a check and who reads analysis imports. A team can also hold a role on a project:

- The owner links one of their own teams to a project with **read** or **write** (`projectTeamAccess.set`, owner person in a browser only; devices are refused, as for adding people). A project can link up to 50 teams, each with its own role. Room is left for a later maintain or admin role; this slice adds no land-approval policy per role.
- Every current member of a linked team gets that role on the project. The effective role is the highest of the person's direct grant and every linked team: a direct reader in a write team writes.
- The link is its own row (`projectTeams`), never a field on the project or the team, so one team serves many projects and an organization can own teams later (`1e474c35`). The project keeps only a count of its links, written with each link change, so a project without teams resolves roles with no team read.
- Each change bumps the project's team-access revision; `set` names the revision the owner read, so a stale screen or a retry sent after a newer change (an unlink, say) is refused instead of granting again. A retry of the change that already applied returns.
- Removing a person from the team, unlinking the team or deleting it removes the access on the next call. A team being deleted grants nothing while its rows are purged; its links go with it. Trashing a project revokes its team links with the direct grants, so a restore starts with none; purging it deletes any left.
- A member writing through a team has no contributor row, so the daily member work budget (checks, composes, submissions) is kept on their team row, shared by that team's projects.
- People and access shows the linked teams to the owner in a **Teams** section: each team with its role, a Write switch, and a menu to change the role or unlink it, and a **Link a team** form that offers the owner's own teams not yet linked. Each change calls `projectTeamAccess.set` with the revision the screen read, then reads the links again. The page reads the links once when it opens (`projectTeamAccess.list`, at most 50) and the owner's teams (`accountTeams.list`, 20 a page) only when the link form opens; nothing polls. The people list above it shows direct grants only.
- **Listing.** A project someone reaches only through a linked team is listed in their Account > Projects and in the device project picker (`projectContributors.shared`), on the first page only, with the team's role. It is read when the list is read (`convex/teamGrant.ts`): the person's team rows (at most 20 teams), each live team's links (at most 25), and per candidate project one point read and one lookup of the person's own order row, which skips projects they hold directly; at most 25 projects are shown (the first page never holds more than 100 rows in all) and 40 candidates read. A project past those caps, or one linked through a team beyond a person's 20th, is not listed (the project is still reachable by link); team projects sit in activity order on the first page only, so they can appear ahead of older direct ones from page two. The picker skips this for a device limited to one project. A person in no team reads one empty range and no document. Nothing is stored per person, so leaving a team, unlinking it or deleting it removes the project on the next read.
- **Direct readers.** `tests/project-contributors-callers.test.mjs` lists the direct readers with their reasons and fails when a new module reads the table directly.
- **One reading of "can work here".** Every check that asks whether a person may work in a project goes through `projectRole` or `hasWriteRole`, so a writer through a team counts as a direct writer: the CI-status publish check, the landing history view, the actor-name check, the reader-grant check (a person who already writes through a team cannot be made a reader) and the list a partial stats close marks (`planningMembers`, which also reads the linked write teams' members, at most 100, on that rare path only). Only a module that manages or inspects the direct grant row reads `projectContributors` itself: the owner's roster and grant changes, accepting an invitation, the member work budget, the guidance-maintainer flag (a per-person grant that no team role confers), Account > Projects order and leaving a shared project. People and access changes the direct grant: giving write to a person who already writes through a team still creates their own grant, and removing it leaves the team's access to be changed on the team link. Removing a direct write grant marks the person for sealed secrets only when no linked team still gives write. A team change marks the same way ([sealed removal](security.md)): removing a member or leaving the team, unlinking a write team or lowering it to read, and deleting the team mark each member who held a sealed entry and no longer writes through a direct grant or another write team.
- **Not yet.** A project that someone reaches only through a team is not listed in that person's Account > Projects or in the device project picker (`projectContributors.shared`): both follow direct grants. `tests/project-contributors-callers.test.mjs` lists each with its reason and fails when a new module reads the table directly.

Cost: an owner and a direct member read nothing more than before. When the direct grants miss on a project with links, the check reads the project's links (one bounded indexed read), the person's team rows (one indexed read, at most 51 rows; a member of more teams reads one row per linked team instead) and the matching team (one point read). No call is added, nothing polls, and idle costs nothing.

Listing cost (line 4e): no landing, save or grant write changes, so $0.00 per 1,000 landings. A person in no team: the first page of Account > Projects and of the picker adds one empty indexed range (0 documents, 0 bytes, no call). A team member adds, on the first page only, one range of at most 20 team rows, at most 20 team gets and 20 link ranges (25 rows each), then at most 40 candidates of one project get and one order-row lookup each, and a normal Account > Projects row for each of at most 25 shown projects; the picker adds no row. Later pages, polling and idle add nothing. The bounds are tested (`tests/team-reached-projects.test.mjs`); the per-row bytes are the existing Account > Projects row's and were not re-measured.

### Organizations (proposed, `1e474c35`, `517523cf`)

The rest of GitHub's model is still a proposal:

- A project is owned by a person or an organization. Existing projects stay person-owned with no change in behaviour.
- Organization roles: owner, member, billing manager (invoices, plan, card and limit, nothing else). Outside collaborators are added per project only.
- A team can be a configured protected-path approver, under the existing exact-change binding rules.
- Base permission for organization members on organization projects: none, read or write; read by default.
- One landing pool per account owner (person or organization), unlimited people; no per-seat billing.

Every public function's access test gains organization owner, member, outsider and removed-member cases.

## Audience

Decision (`b6588425`): one rule, `audienceOf` in `convex/projectAudience.ts`, decides who reads and writes the board, agent coordination and Lane holders. Its input is the current role from `projectRole`, direct or through a team, and the project row the call already loaded; it reads nothing itself.

| Who | Board | Coordination | Lane holder |
| --- | --- | --- | --- |
| **Team**: owner and write members, direct or through a team | read and post; messages go to team members only | read and publish; messages go to team members only | shown |
| Reader of a private project, direct or through a team | no | read | hidden |
| Reader of a public project | no; with `team-and-contributors`, post to the team and read only their own notes and the replies to them | no | hidden |
| Anyone else, including source Zone readers and people who left | no | no | hidden |

- **Board audience** is a project setting, `agentDefaults.boardAudience`: `team` (default) or `team-and-contributors`. There is no `everyone`: the schema refuses it, and the board is never open to all readers of a public project. An agent's switch to `team-and-contributors` is held for the owner; switching back is not.
- **Contributors** are the project's readers, named by the owner. Outside proposal authors join them when outside proposals ship. A contributor posts a note to the team (`project`, a team member's Lane or an Issue); the note reaches only the team. They read a note of theirs with `board {"id":…}`, with its replies, and reply or withdraw only there. They have no inbox, see no other contributor's notes, and cannot publish coordination messages, which reach every coordination reader. Under `team`, a contributor's earlier threads close too.
- **No messages to outsiders.** A board note to a Lane, and a coordination message or hand-off to a session or person, needs a recipient on the team now; a Lane or session left by someone off the team refuses with `BAD_ARGUMENT`.
- **Refusals.** Someone without access gets the private project's `PROJECT_UNAVAILABLE`; a contributor asking for a note that is not theirs gets the missing note's `NOT_FOUND`. Actor names (`projectActorNames.authorize`) count sessions and messages only for a coordination reader, so an outsider cannot learn whether a member ran a session or sent a message.
- **Lane holder.** The session holding a Lane names a person, so it follows the public identity rule (`convex/publicPeople.ts`): only the team sees it, on the Lane list, detail, head and history reads (`laneHolderFor`) and at the response boundary (`publicPeople`).
- **Paths.** Every board and coordination reader can read all of the project's source, so their paths need no masking. Source Zones scope paths of an analysis import and grant no project role, so a Zone reader sees nothing here.

`tests/board-audience.test.mjs` covers the rule: team links and revocation, the effective role, outsiders, messages to people off the team, contributors and the cross-surface refusal. `tests/coordination-team-only.test.mjs` names every coordination query.

## Owner questions

1. **Decided:** the role and verb table above is approved (`b987e608`).
2. **Decided:** readers of private projects see only themselves; write access is needed to see the roster (`b987e608`).
3. **Decided:** the sending limits and lead defaults are listed above (`c6629fda`).
4. The organization model, its default base permission and whether organization admins may stop sessions (`1e474c35`).
5. Team approvers for protected paths (`517523cf`).

## Scale

Permission checks add no Convex round trip: the role is read inside the call that is already running. Idle costs nothing: no access function polls or schedules work. The People and access page makes one bounded read per view (its first pages of people and invitations) and re-runs on changes to the records it reads. The recipient inbox uses two
parallel bounded queries (25 handle invitations and 25 email invitations), each
with its own cursor; blocked preferences load only when opened, 25 per page.
Sparse pages preserve their continuation. No live read uses clock-derived arguments.
The legacy `pending` query returns up to 50 live invitations, reading at most 50
rows each from indexed handle, email and pre-change selectors (150 total), rather
than scanning 1,000 history rows. People and access retains its full paged history.

Email invitation creation is six function executions including delivery (action,
owner query, mutation, scheduled delivery, details query, settlement); with email
off it is three. Resend is four including delivery. All four email counters (five
on resend) are small existing rate-store rows read and written inside the queuing
mutation. Handle and email-off creation use the two inviter counters. Creation
also reads one project generation row; removal reads and writes that same row
and the existing member provenance row atomically. Self-leave reads the project
owner once when it is not already available. Page and answer reads check the
recipient marker, cached per project/account within a page. Legacy inbox rows
also read their original operation to prove the inviter. People makes no per-invitation operation lookup: the invitation row
projects mail state. Answering is one mutation, and no permission check or landing
adds a call. The modeled change per 1,000 landings is $0; this is not a new billed
cost baseline. At both 400 and 800 retained invitations, the transactional fixture
measures removal at 8 documents / 364 read bytes and 4 writes, with no invitation
history read or rewrite. A legacy pending page reads 104 documents / 10,508 bytes,
including 52 invitation documents; a recipient page reads 101 documents / 11,726
bytes. These are synthetic transaction measurements, not live billed usage.
Memory is bounded by the selected pages (at most 150 invitation rows for the
legacy query), not retained history.
At the provider's [listed email price](https://developers.cloudflare.com/email-service/platform/pricing/),
1,000 invitations cost at most $0.35 for mail beyond included allowance, plus
Convex executions and I/O; the existing sender plan is reused and no purchase is
authorized here. Live billed invitation usage has not been measured.
