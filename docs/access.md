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
| Read code, history and plan (`readSource`) | public projects | yes | yes | yes | same as their person | `accessibleProject` |
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
| Secret values, permanent delete, runner keys (`ownerPersonOnly`) | no | no | no | yes | never | `requireOwnerPerson` |

"Held" means an agent's request opens an exact approval request that its person grants or declines in a browser; nothing changes until then. "Never" means an agent's credential is refused even when its person may.

## Agents

Agents act through a device their person approved with `nforge login`. A device narrows its person's rights and never widens them; the device record, its settings and its sign-ins are owned by `df06081d` (sign-in, devices and sessions). A live session is presence, not an access row: it holds a Lane, and the People and access screen lists devices inside their person, never sessions as grants. Agent-run names (`account/slug`) resolve to their person by the public identity rule.

## Private projects answer not found

Without a role, a private project answers exactly like a missing one: `PROJECT_UNAVAILABLE` from every function, and "No project here" on the page. An agent refusal reads the same. A visitor can never learn that a private project exists from an address, an invitation link, or the error.

## Invitations

The owner invites by Forge handle or email address, choosing the starting role, read or write (write when the CLI does not say):

- A handle, or the email of an existing account, gives that role at once; the person sees the project on their Home. A read invitation never lowers an existing write grant, and a write invitation replaces a read grant.
- An email without an account is an open invitation that keeps its role. It is redeemed only by an account whose verified email matches, at its next sign-in. The project's address grants nothing by itself: a forwarded link reaches the "not found" page for anyone else. A new invitation to the same address replaces the open one.
- From a device, inviting opens a membership approval request for the owner person; the role travels with the request.

One email per open email invitation (`convex/projectInviteMail.ts`), sent through the alert email sender's account, token and from address. The email names the inviter's handle, the project's address and the role, nothing else: no other members, no source, no tracking pixel and no query string or rewritten link. The send state (sending, sent, failed with the HTTP status, or off when email is not set up) sits on the invitation's operation row and is shown to the owner only; the address, token and body are never logged or stored beside it. A retry of the same invitation sends nothing more; Resend is explicit, from the owner person in a browser, and idempotent per resend id; a second send waits for the first to settle.

People and access reads one bounded page (`projectAccess.people`): the viewer's role and every contract answer, up to 50 write and 50 read members per page by handle, and for the owner up to 50 open invitations with their send state. A reader sees only their own row. The owner person changes a member to read or write, or removes them, with `projectAccess.setRole` (retry-safe per operation id); agents keep the CLI paths, where removal stays open and additions are held for the person.

*Proposed* (owner): a per-sender sending limit before invitation emails are enabled beyond development; an "ask for access" button on an ended invitation link, which needs sign-in so the owner sees who asks (ux decision D.13).

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

1. Approve the role and verb table above (`b987e608`).
2. Whether a reader of a private project may see the roster by handle (today: only themselves; GitHub shows collaborators to people with push access only).
3. The invitation email sending limit (numbers on `c6629fda`).
4. The organization model, its default base permission and whether organization admins may stop sessions (`1e474c35`).
5. Team approvers for protected paths (`517523cf`).

## Scale

Permission checks add no Convex round trip: the role is read inside the call that is already running. Idle costs nothing: no access function polls or schedules work. The People and access page makes one bounded read per view (its first pages of people and invitations) and re-runs only when a grant changes.
