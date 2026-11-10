# CI status checks (your own CI file)

A project can let its own CI file decide its landing check instead of Forge's runner. Forge
publishes each Candidate as a branch, the project's unchanged workflow runs on that push, and
the CI provider's own record of the run passes or fails the check. Forge's own repository keeps
using [Forge's runner](github-actions-checks.md); this is a second provider behind the same
project setting.

## Setup

1. Turn on the [GitHub mirror](github-app.md) to the repository whose workflow should run.
   Candidate branches start from main's mirrored commit, so the CI repository is the mirror.
2. Add one trigger line to the workflow's `push` branches, and nothing else:

   ```yaml
   on:
     push:
       branches: [main, 'forge/candidates/**']
   ```

3. Select the provider (owner only). `runtime` and `environmentFingerprint` are recomputed by the
   server from the setting; pass any 64-character hex value:

   ```sh
   nforge agent ROOT configure-runner '{"configuration":{"provider":"ci-status","ci":{"adapter":"github-actions","repository":"OWNER/NAME","workflow":".github/workflows/test.yml"},"runtime":"0000000000000000000000000000000000000000000000000000000000000000","environmentFingerprint":"0000000000000000000000000000000000000000000000000000000000000000"}}'
   ```

The setting is refused while the mirror is off or points at another repository.

## What happens per landing

1. The check run publishes `forge/candidates/<runId>` with the mirror's Git data API push: the
   changed blobs, one tree and one commit on main's mirrored commit, then one new ref. The branch
   is created once and never moved; Forge never writes main this way.
2. GitHub runs the workflow on that push.
3. GitHub's signed `workflow_run` webhook (the Forge App's existing webhook) reaches Forge. Only
   the configured workflow file's `push` run of the published commit on that branch, first
   attempt, counts. The first such run binds the check; every later or other run is ignored.
4. `completed` with `success` passes the check; `failure` fails it; `cancelled` cancels it. The
   run link in the receipt points at the GitHub run.

Calls per landing: one publish action (one prepare and one record mutation, plus one source read
per 100 changed objects) and one webhook mutation per workflow event (requested, in progress,
completed), so about five or six. Nothing polls; an idle project costs nothing.

## What a pass attests

A pass needs the CI provider's own record of the run, read on a channel the job cannot write:
the signed webhook for GitHub Actions, or Forge reading the provider API itself. A job that
reports its own status never passes a check, and a job report can only ask Forge to read the
provider record. Changing the CI file needs the owner's review, as changing a check script does:
the file is a protected check entry.

## Outside contributors

The workflow runs with the mirror repository's secrets. Forge publishes only Candidates whose
author and requester are the owner or a contributor. An outside contributor's Candidate settles
`runner-unavailable` with that reason and needs a check on Forge's own runner.

## Limits today

- GitHub Actions publishes. GitLab CI is verified by the contract test (its pipeline record read
  through the GitLab API decides; its webhook is only a wake) but cannot publish yet, so the
  setting refuses it.
- When main's commit is not on the mirror yet, the check settles `runner-unavailable`; check
  again once the mirror is synced.
- A Candidate over eight 100-object windows fails visibly. Git LFS paths publish pointers and upload
  missing objects through the mirror's existing LFS transport before creating the Candidate ref.
- Candidate branches stay on the mirror; delete them on GitHub when you no longer need them.

Code: `src/ci-status.ts` (adapters and verdict), `convex/projectCiStatus.ts` (run, events),
`convex/projectCiStatusPublish.ts` (branch publish), `tests/ci-status-contract.test.mjs`.

## Optional proof on landing

Run `nforge x ROOT set-policy '{"acceptance":{"proofOnLanding":true}}'` to retain optional
proof evidence. It defaults off. This field is explicitly exempt from owner-gate classification:
it adds evidence, changes no acceptance rule, and never invalidates a queued landing's policy pin.
Proof never passes or fails the provider check; a project without a reporting step has no proof.

Any CI can submit the provider-neutral report after comparing the same head tests against base
and head. Supply the exact Forge run ID, Candidate State head and bound provider execution ID.
With an existing Forge project credential in your CI secret store, the step can use the Convex
client (the credential must already have project write access):

```js
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
const client = new ConvexHttpClient(process.env.FORGE_CONVEX_URL);
client.setAuth(process.env.FORGE_CI_TOKEN);
await client.mutation(makeFunctionReference('projectLandingProof:report'), {
  projectId: process.env.FORGE_PROJECT_ID,
  runId: process.env.FORGE_RUN_ID,
  head: process.env.FORGE_CANDIDATE_HEAD,
  executionId: process.env.FORGE_EXECUTION_ID,
  report: JSON.stringify({kind:'proof', reports:[
    {file:'tests/regression.test.mjs', base:'failed', head:'passed'},
  ]}),
});
```

Run each changed head test once on the base source, then on the head. Report `error` when setup
or execution cannot establish a test result, `passed` when it passes on base too, and `failed`
when it fails on base. Reports name at most twenty distinct test files; the same report can be
retried, while a different report cannot replace it. This is job-reported evidence, not an
independent provider attestation. GitHub Actions and GitLab CI share this report contract; the
existing GitLab publishing limitation above still applies.

Forge's runner adds the optional `hosted-proof` job only for its standard check when changed test
files are present and the installed workflow supports it. It reuses verified base blobs already
in the plan's cache, reconstructs the base with head tests, installs/builds it and runs each file
once with the same Candidate isolation as shards. A cold cache missing base blobs, setup failure
or unavailable isolation gives inconclusive evidence without extra source calls. Opaque commands
can report from their own CI using the step above. Forge joins base outcomes to its normal head
reports; a failed or flaky head test never proves a change.

The job is excluded from the required-job verdict, so acceptance never waits for it. One mutation
retains the report beside the run. Acceptance reads and `land`/`wait` summaries join that evidence
on the exact run; it can arrive after landing, and the immutable receipt stays unchanged. With
proof off there is no proof output, job, artifact data or call. With it on, budget one optional
job (roughly 2–4 runner-minutes plus tests), one mutation and one small run-side metadata field.
Public runners are paid for by their repository's existing CI arrangement; no new service is used.
