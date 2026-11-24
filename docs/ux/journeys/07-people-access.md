# Journey 7: people and access

Inviting a teammate, roles, approvals and review holds.

Walked: the Access, contributors, device, review and approval sources, `help auth`, `help queue`, `help wait`, the governance and workflows docs. **Not walked:** an invitation, an approval request and a held landing.

## Steps today

### Inviting a teammate

| # | Step | What happens |
| --- | --- | --- |
| 1 | Owner opens Settings → Admin → Access | "People": the owner's row ("@handle · Owner"), then a field "@handle or email" and **Invite contributor**. Empty: "No contributors yet." (source) |
| 2 | Owner enters a handle | A pending invitation appears with the starting read or write role; access waits for acceptance. |
| 3 | Owner enters an email with no account | A pending row offers End invitation and Copy link. Email is sent when the separate invitation sender is enabled, within its approved limits. The invited account accepts explicitly; sign-in alone grants nothing. |
| 4 | Teammate arrives | Signs in with the invited account, opens Invitations on Home, and presses Accept or Decline. Invitations expire after seven days. After accepting, opens the project and runs `nforge login` for the CLI. |
| 5 | Owner removes someone | **Remove contributor**: "Contributor access removed." Access is checked again at every write. |

There is no CLI action for inviting.

### Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Reader (anyone on a public project, or a reader grant) | Read source and Work. | Start, save, land, change anything. |
| Contributor | Start and save Lanes, land ordinary changes under the project policy. | Change settings, checks, runner, membership or the mirror; land a protected path without the owner. |
| Owner | Everything. | From an agent sign-in: accept a protected change or change what landings must pass. |

Any device sign-in (`nforge login`) is an agent, the owner's included. Agents act under the person's handle with a generated run name.

### Approvals and review holds

| Situation | Agent sees | Person does |
| --- | --- | --- |
| Supervised project | The landing stops after its check; `REVIEW_REQUIRED`. | Candidate review: "Your decision" with **Accept into main** and **Ask for changes** (advisory; adds no gate). |
| Protected path changed | The landing is held: "needs owner approval: protected paths X, Y". It stays in `queue` with no position. `approve-link '{"operationId":"…"}'` returns `/approve?project=…&submission=…`. | "Review a landing. Accept this landing? Submitted by an agent. Its check passed." **Accept into main** or **Decline**. If main moved: "this exact source is checked again on current main and lands with your approval." |
| Builder asks first | `request-approval '{"laneId":"…","reason":"…"}'` returns `/approve?project=…&lane=…`; `wait '{"approval":"LANE_ID"}'` blocks until the decision. | "Approval request. Grant this Lane? Requested by NAME. Landing it holds until you grant it." Grant or decline. "This exact Lane work can land. A later save needs your approval again." |
| Settings change from an agent | `rule:"held"` and a link. | "Apply this policy change?" (see [journey 6](06-settings.md)). |
| A fork pull request on the mirror | n/a | "Run the check of fork PR #N? A pull request from a fork waits for you." |
| Decline | `REVIEW_DECLINED` with the owner's reason. | |

Needs you lists these as "Ready to accept", "Approval request", "Handoff to you", "Check failed", "Reverted from main" and "Fix needed".

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J7-1 | S1 | **The invited person is told nothing.** No email, no link to copy. The owner must tell them out of band, and must also tell them which address to open. Sharing pattern: the recipient lands in the shared thing in one click; here there is no click. | docs, source |
| J7-2 | S2 | **One role can be given.** The invite always grants contributor. No control was found for giving read-only access to a private project, although reader grants exist and Home lists projects shared with a reader. | source, docs |
| J7-3 | S2 | **"Maintainer" is named but cannot be assigned.** "Only the owner or a maintainer can change this." appears under How agents work. Access offers owner and contributor only. | source |
| J7-4 | S2 | **Five words for the owner's yes.** The landing page says **Accept into main**; the Lane request says **Grant**; the settings request says **Apply**; the URLs, the page titles ("Approval request"), the Needs you kind, the CLI (`approve-link`, `request-approval`, `wait {approval}`) and the sign-in page say **approve**; the codes say **review** (`REVIEW_REQUIRED`) and the queue says **held**. PRODUCT.md bans "approve" in product UI and fixes "accept". | source, ran |
| J7-5 | S2 | **The owner's request reaches them only if they look.** An approval request appears in Needs you and as a board note. The agent holds the link and must pass it to the person through its own chat. Nothing notifies the owner. Open Issue e88f503d covers notifications. | docs, source |
| J7-6 | S2 | **"Ask for changes" does not block.** It records feedback and "adds no acceptance gate". A person who knows GitHub expects a requested change to stop the merge. | docs |
| J7-7 | S2 | **An owner at a terminal cannot say yes there.** Every protected-path landing and every settings change needs a browser. This is deliberate (a device sign-in is an agent), but the reply an owner sees is the agent's reply; nothing says "you are the owner; open this link to decide". | docs |
| J7-8 | S2 | **A held landing can land without review after a policy change, under the agent's name.** If the protected path is lifted while a landing is held, the fresh attempt lands without review and its receipt names the submitter. This is documented and correct, but the owner who "approved" sees an agent as the acceptor. | docs |
| J7-9 | S3 | **All of a person's agents share one identity.** Roles apply to the person; an agent cannot be given less. Open Issue df06081d covers agent actors. | docs |
| J7-10 | S3 | **A removed or uninvited person gets a plain refusal.** `AUTH_SCOPE_DENIED`: "the account lacks access to this project; ask its owner for access." There is no request-access step, and the owner is not named. | ran |
| J7-11 | S3 | **The settings request shows raw JSON** (open Issue 16093ed1). | source |

## Dead ends

- The invited person, until someone tells them (J7-1).
- A person without access: the refusal names no owner and offers no request (J7-10).
- Giving read-only access to a private project (J7-2).

## Naming and tone

- Roles: reader, contributor, owner (docs and web); "maintainer" (one web line); "write" and "read" (Issue b987e608); "member" (governance doc). The product needs one set.
- The approval pages are short and plain. "Only approve if you just ran nforge login yourself." is exactly the right sentence for its moment, apart from the banned word.

## What each persona needs

- **Agent, not person:** to know before it starts whether its landing will be held and for which paths; one command that returns the link; a wait that ends on the decision (present).
- **Person, not agent:** to be told when something waits for them; to see who can do what at a glance; to give the least access that works. The invited person needs a link.

## Decisions

- An invitation offers email and a copyable link bound to the recipient. Private projects allow read-only invites. Link support is delivered (Item c6629fda); enabling the email sender belongs to rollout (Item ab3fab64).
- Use **owner**, **write** and **read**; there is no Maintainer role. Use **Approve** for the person's yes ([product vocabulary](../../../PRODUCT.md#capabilities-and-constraints)).
- **Ask for changes** holds a landing only if the project requires approval (Item 3607c6d6). At beta, approval is in the browser only (Item 0a99ab23). Neither decision enables agent approval.
