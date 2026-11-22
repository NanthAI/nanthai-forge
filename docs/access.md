# Project access

Who can do what in a Forge project, and where the server enforces it. The rules follow GitHub's model, frictionless but secure: three roles, invitations by link and email, agents that never get more than their person. The screen is **Settings → People and access** in the rebuilt app (`/-/{handle}/{project}/settings`).

Status: the roles, verbs and resolver below describe what runs today. The parts marked *proposed* wait for the owner's approval on the Items named beside them.

## Roles

| Forge | GitHub | Who |
| --- | --- | --- |
| **owner** | admin (repository owner) | The account that owns the project. One per project today; an organization owner is *proposed* (`1e474c35`). |
| **write** | write | People the owner invited with write access (stored as contributor grants). |
| **read** | read | People the owner invited with read access (reader grants). On a private project this is the only way to see it without writing. |
| public | anyone, on a public repository | Anyone, signed in or not, on a public project. Not a role: it grants reading only. |

There is no maintainer or triage role. A guidance-maintainer assignment authorizes agent guidance and project metrics only ([security](security.md)).

The role is resolved in one place, `projectRole` in `convex/projectRole.ts`, from current grants only: the owner costs no database read, a write member one indexed read, a reader at most two. There is no cached membership, so removing a person or lowering write to read takes effect on their next call, and on every call of their agents. The same resolver answers the access checks in `convex/projectAuthority.ts`, the public identity rule (`convex/publicPeople.ts`) and member labels (`convex/projectActorNames.ts`).

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
| Secret values, permanent delete, runner keys, public or private (`ownerPersonOnly`) | no | no | no | yes | never | `requireOwnerPerson`; visibility: `projectVisibility.setVisibility` |

Sealed secret writes are authorised by the owner device key in the signed roster.
The storage endpoint accepts only the project owner account on an unrestricted
stable device sign-in with source-write access. Scoped, read-only, browser-only
and keyless agent credentials cannot write sealed records. Readers verify the
roster and signatures locally; the server stores ciphertext without decrypting.
Secret Objects values stay owner-person only until their retirement. Agent and
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
Secret objects shared with the person are never listed, counted or part of the
review, so nothing in it can show whether one exists. Leaving everything also
leaves every secret grant the person held when they read the reviewed list, by
the time the review's token carries: a grant given, or given again in place, at a
later time stays. Those grants stop giving access as soon as the cleanup starts;
their rows are then deleted in bounded background work, which never changes what
the cleanup reports.

Selected-project and read-only devices cannot make account-level writes, including
team changes, project creation, import starts and saved-view writes. The public
wrapper decides from the credential it already reads. Public actions and
mutations without a resource selector declare their account device rule at
registration. Unrestricted devices keep their existing account-write rights,
subject to the same person-only rules. Adding team members by handle or email
requires the person in a browser: the existing membership approval store is
project-bound, so team additions use the refusal alternative and grant nothing
from a device. Project membership additions retain their existing held request.

## Private projects answer not found

Without a role, a private project answers exactly like a missing one: `PROJECT_UNAVAILABLE` from every function, and "No project here" on the page. An agent refusal reads the same. A visitor can never learn that a private project exists from an address, an invitation link, or the error.


## Invitations

The owner invites by Forge handle or email address, choosing read or write access.
Every invitation is pending until its recipient presses **Accept**. Creating an
invitation or signing in grants nothing. Until acceptance, the owner sees only
what they typed and the invitation state; Forge does not look up an email during
creation. Handle invitations bind to the selected account; email invitations bind
to the signed-in person's current, unique verified address at acceptance. A read
invitation never lowers existing write access. Accepting write replaces read.

Recipients see **Accept**, **Decline**, and **Decline and block inviter** on Home
(`/-/account`) and the invitation page (`/-/account/people`). A link opens that
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
link. Failed sends show the HTTP status or network failure with Resend and Copy
link as the next steps. Email content uses the inviter's handle, the project's
current address and the role, with no tracking pixel or rewritten link. The
production sender domain remains part of the Phase 8 production move.
The switch must remain off until the email-enablement requirements on
[invitation email Issue c6629fda](https://nanthai-forge-dev.netlify.app/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=c6629fda-c29f-48e9-b677-5094e5cf0d9b)
are complete, including on dev.

Invitation limits are checked together before any write, including explicit resends:

| Scope | Limit |
| --- | --- |
| Inviter, across projects | 20 invitations per UTC hour and 100 per UTC day; handle, email and explicit resends share the allowance, including with email off |
| Invitation | 3 resends per UTC day |
| Project | 50 open email invitations; accepted, ended and expired rows do not count |
| Deployment, across projects and accounts | 500 invitation emails per UTC day |
| Recipient address, across projects and inviters | 3 invitation emails per UTC day |

Over a sending limit, the operation refuses with `RATE_LIMITED` and writes and
schedules nothing. Retry the same operation id after the relevant window. Exact
completed retries charge nothing and send nothing again. Counters reset in place,
inside the existing send transaction. Recipient counter keys contain a digest,
not an extra copy of the address. Deployment, recipient and resend-email
allowances apply to actual queued email; with email off only the inviter
allowance is charged. Email creation no
longer performs recipient directory lookups, so that lookup has no budget to spend.
Invitation targets longer than 254 characters are refused before database reads.

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

### Team invitations by address

The team email invitation path is staged behind `FORGE_TEAM_EMAIL_INVITATIONS=1`.
The switch is off by default. With it enabled, an owner invites an email
address in **People and teams**. The owner can see and cancel the typed pending
target regardless of whether an account uses that address. The invitation
becomes team membership only after the person with the current verified
address chooses **Accept** on Home. Declining leaves membership as it was.
Blocking uses the same recipient-owned preference as project invitations.
Removing a member ends earlier invitations to that account. A new invitation
can be accepted after removal.

The same inviter counters cover project and team invitations with the switch
on (20 per UTC hour and 100 per UTC day for an inviter). The team path uses
Home for delivery and is independent of the project invitation mail switch.
Leave the team writer off until the owner approves applying the shared counters.

## Teams and organizations (proposed, `1e474c35`, `517523cf`)

Teams exist today as owner-managed groups used for the landing-without-check choice and for read sharing of analysis imports. The proposal, GitHub's model:

- A project is owned by a person or an organization. Existing projects stay person-owned with no change in behaviour.
- Organization roles: owner, member, billing manager (invoices, plan, card and limit, nothing else). Outside collaborators are added per project only.
- A team can be granted read or write on many projects; its people inherit that access, shown with its source ("write, from team core"). Leaving a team or the organization removes the access on the next call.
- A team can be a configured protected-path approver, under the existing exact-change binding rules.
- Base permission for organization members on organization projects: none, read or write; read by default.
- One landing pool per account owner (person or organization), unlimited people; no per-seat billing.

Membership lookups stay indexed: one more read per access check at most. Every public function's access test gains organization owner, member, outsider and removed-member cases.

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
