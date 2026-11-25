# Public project governance

Public visibility grants read access, never membership or write authority. Forge checks
current membership again at each write and final main publication. Source authority,
exact Candidate/check pins, current policy and the main head/receipt CAS still apply.

## Roles

| Role | Work and source | Landing and settings |
| --- | --- | --- |
| Signed-in stranger / reader | Read public source and Work. Cannot start, save, compose, sync, finish, register a project runner or upload a proposal to this project. | Cannot accept, approve, change policy/check definitions/runner configuration, publish source, grant membership or change the mirror. |
| Invited contributor | Start and save hosted Lanes, compose, sync, check and submit finish; use their own local runner or submit an archive proposal for an authorized Intent. Shared Lane writes remain visible as contributor work. | Ordinary server-authoritative public changes may land under auto-on-pass with an exact passing check. Selecting person authority does not bypass these rules. Protected changes need the owner. Cannot change project execution settings, membership, policy, source authority or mirror settings. |
| Owner | All project operations, including inviting contributors and accepting proposals. | Can explicitly accept an exact prepared Candidate with person authority. The owner person's own landings and settings writes are direct. An agent signed in with the owner's account is an agent: the owner-approval paths and `acceptance.protectedPaths` hold it for the owner person, and its policy, check and runner changes become approval requests (below). Review mode turns automatic landing off. |

Public visibility and contributor membership confer no secret access: sealed secrets
are opened only by the devices their signed roster lists (see the security document).
A user can import a GitHub repository into a new project they own; that does not
grant writes to an existing project. Analysis imports and signed GitHub webhooks
update derived import observations, not accepted Forge main.

Native-owner projects retain their owner-only hosted Channel and source-publication
boundary. Contributor archives are proposals, not accepted source. A local native
owner is a trusted OS process, not a sandbox for untrusted contributors.

## Protected paths

For server-authoritative public projects the default owner-approval list is:

- `.github/**`
- `scripts/forge-check.mjs`
- `.forge/**`
- `forge.config.*`
- `netlify.toml` and `netlify/**`
- `scripts/deploy*` and `scripts/deploy/**`

The list applies on every project, public or private, to every agent, the owner's own
agents included (any device sign-in, such as `nforge login`, is an agent); on a public
project it also applies to contributor persons. Only the owner person skips it.
Owner-only provenance (below) marks inputs no contributor wrote; it no longer exempts
an agent from this list.

Check definitions and hosted runner configuration are database settings, owner-only.
Source-controlled policy/configuration belongs in the protected paths.

## Settings changes from agents

A person approves changes to what landings must pass. When an agent sign-in (the
owner's own CLI included) changes the project policy in a way that alters what a
landing may accept (gate, mode, protected and owner-approval paths, `autoActors`,
checks, lifecycle, enforced trust) or the GitHub mirror, or changes a check
definition, the runner configuration or the main-audit setting, nothing is written.
The write records one approval request instead (one row per setting, keyed
`setting:policy`, `setting:runner`, `setting:main-audit`,
`setting:check-definition:CHECK_ID` or `setting:check-import:…`; a new request
replaces an open one) and replies `rule:"held"` with the owner's link
`/approve?project=…&lane=setting:…`. The owner person opens it signed in (or opens the
request under Needs me, Asked ahead), reads one summary line and a before/after row per
changed field, with each script as a wrapped line diff; the request exactly as sent, internal
ids included, stays behind Details. The owner's read (`observe {detail:1}`) adds the setting
as it is now and as the grant would leave it, at most one indexed read and only for an
open request. The owner approves or declines in one step (`projectHostedApprovals:decide`;
agents, device sign-ins and contributors are refused). A grant applies exactly that
request as the agent's own operation, so the agent's retry returns the applied
receipt; a policy request applies only while the policy parts it would change are as
they were when it was asked. A check import names its Work check by name or id only, so
holding it reads that check from hosted Work once and stores its definition with the
request (`pinned`): the page compares that definition and shows it under Details apart
from what the agent sent, and the grant applies it without
reading Work again, even if Work has changed since. An agent cannot supply `pinned`
itself, and an import held before definitions were stored is refused at grant
(`WORK_STALE`; decline it and ask again). The agent's `wait {approval}` returns on the decision.

Two cases apply directly and say so: an agent's writes on a project with no accepted
landing yet (`rule:"bootstrap"`, so scratch, zoo and bench setup keep working), and
policy edits that change only fields listed as exempt in `OWNER_GATE`
(`src/policy-digest.ts`: most `agentDefaults`, `notify.awaySummary`, the `preset` label,
trust in shadow mode, and relax-only fields moved toward more oversight: `rule:"no-gate-change"`). Each
exempt field states its reason there. Every other field is held, including alert email
recipients and any field not yet listed; a test fails until a new policy field is listed.
Relax-only fields are held only when a change lowers owner oversight: switching fast landing
on, or turning stall alerts or their webhook off. Turning them back on applies at once. The owner person's writes are
`rule:"owner-person"`; granted ones are `rule:"owner-approved"`. Settings requests
never hold a landing and the landing path reads nothing more for them; a held write
costs one approval-row write, and the bootstrap test one indexed read on agent
settings writes only.
Put future deploy-step files under `.forge/`, `.github/`, `netlify/` or
`scripts/deploy/`, or add their paths before enabling a step that receives secrets.
These globs cannot infer a new deployment entry point at an arbitrary filename.
Owner approval controls landing; it does not sandbox check execution or make
credentials passed to arbitrary check code safe.

A trusted compose result retains the exact main-to-Candidate changed-path set,
including deletion, rename sides and mode-only changes. The fixed source worker
compares the State manifests already loaded for composition; it reads no extra
file blobs. The default bounded Convex source steps compose one selection at a
time, so their durable cursor keeps each changed path's main entry and signs the
same net set across steps and actions. A cursor from older code has no such
entries; its result carries no paths and the Candidate waits for the owner.
Publication copies this set only from the signed result. The server
matches it at the final acceptance boundary used by both the finish driver and
acceptance mutations. Client-supplied paths, graph coverage and check display facts
cannot substitute for this evidence.

A hosted finish with a trusted composition that touches a protected path shows the
owner approval link while its first full check runs. The owner can review the change
and check evidence in the same view. The hold yields queue order, and later main moves
leave the attempt and its check record available for review. Once the first check settles,
no check or background polling runs during the owner wait. Requirements that first
become known from check results are applied at publication. Missing legacy path evidence
still requires owner approval at publication.

`queue {submissionId}` and `wait` show whether the entry is held, the owner has
approved, approval carried to the updated attempt, or changed reviewed source or policy
requires another approval. The held landing has no queue position. See
[held landings](../agents/workflow.md).

A signed-in owner approves or declines a held landing in Needs me or on the Lane page.
If no check has run on the Candidate, approval asks once for confirmation. **Approve before
the check finishes** leaves a pending check in place; **Approve without a check** is shown
in the confirmation only when none is planned for that Candidate. **Not now** leaves the hold unchanged.
An older `/approve?project=…&submission=…` link opens the same decision. The agent gets that link from `nforge agent ROOT approve-link {"operationId":"…"}` (one query; the
link carries no attempt id, the page reads the current attempt). Both call
`projectHostedAcceptance:approve` or `projectHostedOwnerReview:decline` with the exact
`projectId`, `submissionId` and `attemptId`. They are explicit person acceptance:
device/agent credentials and contributors are refused. Approve publishes through the
same guarded transaction and records the owner in the receipt and in the landing's
`acceptance.acceptedBy` (`kind: "person"`, handle, time, accepted head, protected paths;
an automatic acceptance is `kind: "auto"`), which `land`, `wait`, `observe`, `landings`
and the web landing view show; the landing's Lane gets one board note. Retrying returns the
original receipt. Decline ends the submission with `REVIEW_DECLINED` and the owner's
reason. The submitter's `wait` is subscribed to the submission, so it returns on either
decision with no polling.

Approval names one exact attempt. A current exact pass can publish once it has its
turn. If main moved, the finish composes on current main. It compares the pinned file
listings for the change the owner saw and the new Candidate, including each path,
before and after content hashes, and file modes. When the hold is about protected paths
alone, only the protected entries (and the secret-allow file) are compared, so main
landing work in other files the Lane also changed keeps the approval; anything else, or
anything that cannot be proven, compares every changed file
([binding rule](../access.md#protected-path-approvals)). The grant carries when that
comparison, the selected inputs and dependencies, the owner and policy are the same, and
the receipt names the main it was checked against (`previous`; the submission's `acceptedBy.carried` is true).
The replacement takes a publication turn while its exact full check runs. CI does not
hold a publication lease. A changed reviewed diff gets a fresh approval link for the
current attempt. Agents cannot create a grant. A later held submission of the same Intent
reuses the approval for its protected paths only, when their entries match
([later submissions](../access.md#protected-path-approvals)).

A held landing stays pinned to the policy its attempt was prepared under. A policy edit
never re-checks it, and no sweep, alarm or recompose touches a held entry. Both `approve-link`
and `observe {submissionId}` return `policy` (the pinned attempt, when it was pinned, and
whether the policy changed) and `policyNote` (when it re-reads the policy). Once the policy
changes, the held reason in `observe`, `wait`, `status`, and the owner page includes that note.
Only a fresh attempt re-reads the policy. The owner can approve after main moves or the
policy changes, which runs a full check on current main. The builder can also withdraw and
land again. The approval carries to a fresh attempt only while the policy is unchanged.
After a policy edit, the fresh attempt holds for the owner once more if the current policy
still needs review. Otherwise it lands without review, and its receipt names the submitter
(an agent), not the owner. That is how held submission 991a1a94 landed on 2026-11-09: the
owner approved after main had moved, and the protected path had been lifted while it was
held.

A builder can also ask for the owner's go on any saved Lane, whatever the path rules:
`request-approval {laneId,reason}` writes one row per Lane
(`projectHostedApprovals:request`, the Lane author or the owner) and one project board
note, and replies with `/approve?project=…&lane=…`. While the request is open, landing
that Lane holds after its check with `REVIEW_REQUIRED` naming the reason (a batch member
lands alone). The owner person approves or declines in one step on that page
(`projectHostedApprovals:decide`, refused for agents, device sign-ins and contributors).
A grant covers exactly the Lane head the owner saw (a stale head is refused); if the
Lane's landing is already held, the grant is that landing's exact approval and a decline
ends it `REVIEW_DECLINED`. Approving or declining the held landing directly settles the
request the same way. Landing with the grant ends the request; a declined request holds
the next landing until the owner grants or the builder withdraws it. `wait {approval}`
subscribes to the one request row: no polling, idle costs nothing. A publish reads one
index (live requests, normally none) and only then the landing's input pages.

Owner-only provenance is retained server evidence that every input Lane and dependency
Candidate came from the owner account with no contributor write. It lets the owner's
agent landings batch together; it never excuses an agent from owner approval. Its rules:
all input Lanes and dependency Candidates must be owner-only. Any contributor write clears a Lane's owner-only flag;
later owner writes do not restore it. Missing legacy provenance cannot grant the
exception. Recomposition retains the original provenance. Creating an owner request
around a contributor Candidate does not make it an owner-only Candidate.

Conflict recovery retains the authenticated input aggregate separately from changed
paths, including the creator and authority epoch. A conflict summary cannot stand
in for complete clean-Candidate paths. Resolution drafts inherit that aggregate;
saves and resolve preserve it only while the Lane remains owner-only. Sync combines
both sides, including an unaccepted stack parent. Batch conflicts include the
composed prefix's provenance. Mixed inputs, unknown legacy conflict provenance and
evidence from another authority epoch cannot grant the owner exception. Pending
syncs prepared before two-sided provenance validation cannot seed owner-only drafts. Recovery
reuses the aggregate already validated over selected manifest pages; publication
never scans source history or re-reads the original selections. Finishing a
multi-input resolution keeps every original suffix and dependency pin.

## Edit the list

The owner uses the existing policy command. `acceptance.ownerApprovalPaths` replaces
the public default list; omit it to retain the defaults, or explicitly set `[]` to
disable this public path gate. The defaults also cover the files that every check
definition of the project and its setup action runs (for example `.bench/ci.sh`),
so a contributor cannot change any of them without owner approval, and the contract
gate treats them the same way; an explicit list replaces that too, so include them. Existing `acceptance.protectedPaths` remains the
separate all-agent review list. `acceptance.mode: "review"` stops automatic acceptance,
including the owner's. Other projects retain their existing policy behavior.

```json
{
  "action": "set-policy",
  "operationId": "00000000-0000-4000-8000-000000000001",
  "governanceVersion": 1,
  "acceptance": {
    "ownerApprovalPaths": [".github/**", "scripts/forge-check.mjs", ".forge/**", "deploy/**"]
  }
}
```

Generate a fresh operation UUID for a new edit; retries retain the original command.
Use `expectedPolicy` for compare-and-swap edits. Send `dryRun: true` to preview the
resulting policy and receipt with no writes or approval request. CLI and MCP replies
report `invalidatedLandings`, `invalidatedSubmissionIds` and `invalidatedByPhase`.
The preview is current as of `impactAt`. The queue can change before you apply.
The applied receipt records the selected attempts that became stale at commit.
Replaying an edit returns its original receipt, even after those attempts are
withdrawn or recomposed. `heldForReview` counts review holds excluded from the scan.

The scan checks ready, checking and queued landings in that order. When it cannot
verify every pin, `impactComplete: false` marks a bound. If 41 landings were verified
as newly stale and `impactUnexamined` is 212, the edit invalidated at least 41
landings and the total is between 41 and 253. A path edit can affect an unexamined
landing if the changed patterns match its paths, its path coverage is unavailable,
or its owner grant requires the exact policy. The first 1,000 verified
IDs appear in submission order. `idsTruncated: true` marks a longer list and
the count still covers every verified match. Older stored receipts keep their
original impact coverage. New runners send `governanceVersion:1` on landing/desired-finish
requests, including recovered pre-upgrade requests. Old strict servers reject that
field rather than silently accepting without governance. List edits require the
same version marker, so old strict policy servers also reject them. Old runners on
a new server remain subject to final server enforcement.

Deploy the server schema/mutations and fixed source-worker build together first,
then runners/CLI and web. An older worker's missing coverage remains pending until
explicit owner acceptance or recomposition with the new worker. Edits to the
gate, acceptance mode, owner approval paths or enforced trust still invalidate
all affected in-flight pins. An edit limited to `acceptance.protectedPaths`
invalidates a pin when its Candidate changes a path matching an added or removed
pattern, or when its changed-path coverage is unavailable. A shared check whose
cohort contains an invalidated member follows the batch fallback workflow. A
landing already held for owner review follows the original review workflow.
No backfill, timer, idle call or new provider operation is required.

## Outside contributions and the GitHub mirror

An outsider can prepare a local contribution bundle/Lane and give it to the owner
for Forge import. Import creates a separate Lane for review, never moves a Channel.
For hosted archive proposals the owner first invites the contributor and assigns
or permits their Intent; public read access alone cannot upload one. See
[contributor proposals](../workflows.md#contributor-proposals).

This is Forge's equivalent of branch protection plus CODEOWNERS (and of GitHub's rule that
workflow files and repository settings need a person with admin rights, not a bot token acting
for them): changed-path
ownership is enforced at acceptance, and a passing check alone cannot approve a
protected contributor change. GitHub `main` is a read-only mirror for contributors;
only the Forge mirror App updates it, with force-push and deletion blocked by the
GitHub ruleset. CODEOWNERS on that mirror can document the same ownership, but
Forge's server-side policy is the authority for native landing. The mirror receives
only accepted source; it grants no route around Forge owner approval.

Pending compose and sync operations created before authenticated aggregate versioning cannot grant new owner-only provenance at publication. Their source results remain usable with unknown provenance.
