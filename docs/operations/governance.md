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
no finish polling, queue work or stall alarm. Status remains a finite read.

The owner can call `projectHostedAcceptance:approve` with the exact `projectId`,
`submissionId` and `attemptId`. This is explicit person acceptance; device/agent
credentials cannot approve. It publishes through the same guarded transaction and
records the owner in the receipt. Retrying returns the original receipt. The existing
browser person-acceptance route can also select that exact Candidate as an owner
request. A main or policy race still requires a fresh pinned attempt.

The own-Lane exception uses retained server provenance: all input Lanes and dependency
Candidates must be owner-only. Any contributor write clears a Lane's owner-only flag;
later owner writes do not restore it. Missing legacy provenance cannot grant the
exception. Recomposition retains the original provenance. Creating an owner request
around a contributor Candidate does not make it an owner-only Candidate.

## Edit the list

The owner uses the existing policy command. `acceptance.ownerApprovalPaths` replaces
the public default list; omit it to retain the defaults, or explicitly set `[]` to
disable this public path gate. Existing `acceptance.protectedPaths` remains the
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
