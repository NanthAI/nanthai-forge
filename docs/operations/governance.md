# Public project governance

Public visibility grants read access, never membership or write authority. Forge checks
current membership again at each write and final main publication. Source authority,
exact Candidate/check pins, current policy and the main head/receipt CAS still apply.

## Roles

| Role | Work and source | Landing and settings |
| --- | --- | --- |
| Signed-in stranger / reader | Read public source and Work. Cannot start, save, compose, sync, finish, register a project runner or upload a proposal to this project. | Cannot accept, approve, change policy/check definitions/runner configuration, publish source, grant membership or change the mirror. |
| Invited contributor | Start and save hosted Lanes, compose, sync, check and submit finish; use their own local runner or submit an archive proposal for an authorized Intent. Shared Lane writes remain visible as contributor work. | Ordinary server-authoritative public changes may land under auto-on-pass with an exact passing check. Selecting person authority does not bypass these rules. Protected changes need the owner. Cannot change project execution settings, membership, policy, source authority or mirror settings. |
| Owner | All project operations, including inviting contributors and accepting proposals. | Can explicitly accept an exact prepared Candidate with person authority. Own Lanes can auto-land under auto-on-pass, including protected files; review mode turns automatic landing off. |

Secret Objects have separate per-capability grants. Public visibility and contributor
membership confer no secret discovery, use, modification or delegation authority.
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

Check definitions and hosted runner configuration are database settings and already
owner-only. Source-controlled policy/configuration belongs in the protected paths.
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

A contributor Candidate touching one of these paths stays pending with
`needs owner approval: protected paths X, Y`, even after checks pass. Missing
legacy-worker path evidence also waits for owner approval. Review waits schedule
no finish polling, queue work or stall alarm. Status remains a finite read. The
held landing stays listed in `queue` without a position, and `land`, `wait`, `queue`
and `status` name the hold, its paths and the next step (see
[held landings](../agents/workflow.md)).

A signed-in owner accepts or declines a held landing in one step: **Accept into main**
or **Decline** on its review page, or on `/approve?project=…&submission=…`. The agent
gets that link from `nforge agent ROOT approve-link {"operationId":"…"}` (one query; the
link carries no attempt id, the page reads the current attempt). Both call
`projectHostedAcceptance:approve` or `projectHostedOwnerReview:decline` with the exact
`projectId`, `submissionId` and `attemptId`. They are explicit person acceptance:
device/agent credentials and contributors are refused. Approve publishes through the
same guarded transaction and records the owner in the receipt; retrying returns the
original receipt. Decline ends the submission with `REVIEW_DECLINED` and the owner's
reason. The submitter's `wait` is subscribed to the submission, so it returns on either
decision with no polling.

Approval names one exact attempt. A held landing does not recompose while it waits, so
when main has moved the approval cannot publish that stale Candidate. Approve instead
keeps a server-only grant on the landing (owner, attempt, input and dependency
manifest pins, policy digest, changed paths), and the landing makes a fresh attempt on
current main with a full check. That fresh attempt lands with the owner as approver only
if its inputs and dependencies are byte-identical, the policy digest is unchanged, the
owner is unchanged, its own check passed, and it changes no path the approved Candidate
did not. Otherwise it holds for review again. A busy queue does the same without
recomposing: the landing takes its turn. Agents cannot create a grant.

A held landing stays pinned to the policy its attempt was prepared under. A policy edit
never re-checks it, and no sweep, alarm or recompose touches a held entry. approve-link
returns `policy` (the attempt it is pinned to, when, whether the policy changed since) and
`policyNote` (when it re-reads the policy); once the policy changed, every held reason
(`wait`, `status`, the owner page) carries that note too. Only a fresh attempt re-reads it: the owner approves after main moved
or after the policy changed (a full check on current main), or the builder withdraws and
lands again. The approval carries to that fresh attempt only while the policy is unchanged.
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
lands alone). The owner person grants or declines in one step on that page
(`projectHostedApprovals:decide`, refused for agents, device sign-ins and contributors).
A grant covers exactly the Lane head the owner saw (a stale head is refused); if the
Lane's landing is already held, the grant is that landing's exact approval and a decline
ends it `REVIEW_DECLINED`. Approving or declining the held landing directly settles the
request the same way. Landing with the grant ends the request; a declined request holds
the next landing until the owner grants or the builder withdraws it. `wait {approval}`
subscribes to the one request row: no polling, idle costs nothing. A publish reads one
index (live requests, normally none) and only then the landing's input pages.

The own-Lane exception uses retained server provenance: all input Lanes and dependency
Candidates must be owner-only. Any contributor write clears a Lane's owner-only flag;
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
Use `expectedPolicy` for compare-and-swap edits. The new fields are optional in stored
policies and records. New runners send `governanceVersion:1` on landing/desired-finish
requests, including recovered pre-upgrade requests. Old strict servers reject that
field rather than silently accepting without governance. List edits require the
same version marker, so old strict policy servers also reject them. Old runners on
a new server remain subject to final server enforcement.

Deploy the server schema/mutations and fixed source-worker build together first,
then runners/CLI and web. An older worker's missing coverage remains pending until
explicit owner acceptance or recomposition with the new worker. Existing pinned
attempts that race a policy edit retain their normal `POLICY_CHANGED` outcome.
No backfill, timer, idle call or new provider operation is required.

## Outside contributions and the GitHub mirror

An outsider can prepare a local contribution bundle/Lane and give it to the owner
for Forge import. Import creates a separate Lane for review, never moves a Channel.
For hosted archive proposals the owner first invites the contributor and assigns
or permits their Intent; public read access alone cannot upload one. See
[contributor proposals](../workflows.md#contributor-proposals).

This is Forge's equivalent of branch protection plus CODEOWNERS: changed-path
ownership is enforced at acceptance, and a passing check alone cannot approve a
protected contributor change. GitHub `main` is a read-only mirror for contributors;
only the Forge mirror App updates it, with force-push and deletion blocked by the
GitHub ruleset. CODEOWNERS on that mirror can document the same ownership, but
Forge's server-side policy is the authority for native landing. The mirror receives
only accepted source; it grants no route around Forge owner approval.

Pending compose and sync operations created before authenticated aggregate versioning cannot grant new owner-only provenance at publication. Their source results remain usable with unknown provenance.
