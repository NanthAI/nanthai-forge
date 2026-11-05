# Gate parity: disposition matrix

Status: a **current disposition of the 2026-10-28 gate-parity plan**, not a new plan. The original plan set out to make Forge's landing gate (the check that runs before a change reaches `main`) match or beat the best agent CI setups: a full check within about 10 minutes on free GitHub-hosted runners, a scoped check within about 5, near-zero cost for public repositories, and zero cost when idle. Those figures were targets written before measurement. They are **not** current commitments and nothing here sets a limit, default, approval rule or price. The one measured outside reference was a developer who reached about 6 minutes with paid, snapshot-based virtual machines (see [marketing scenarios](../marketing/scenarios.md), an unverified outside number).

How to read it: **Built** means code and a document exist on `main`; this extraction read those documents and did not re-run the behavior. **Awaiting evidence** means built or partly built but no published measurement backs a claim. **Superseded** means another design replaced it. **Future** means not scheduled or dropped for the beta.

## Matrix

| # | Item | Disposition | Where to look |
|---|---|---|---|
| G1 | Warm dependencies and build on Actions: cache keyed by lockfile and toolchain; build once and reuse it across shards | Built (needed by the hosted-landing cutover). A single pack download now seeds a job-private cache; there is no persistent runner-local cache. Measured gate time is still unpublished (see G8). | [GitHub Actions checks](github-actions-checks.md) |
| G2 | Shard count from measured timings, balanced on recorded test durations, toward the free concurrent-job limit | Built: omitted `shards` uses the duration-balanced, provider-neutral check plan; a positive count partitions explicitly. The old "about 20 free concurrent jobs" assumption was tied to one account tier and must not be reused as a requirement; read the current limit from the provider. | [GitHub Actions checks](github-actions-checks.md) |
| G3 | Scoped checks on, with post-accept full `main` checks active as the stated precondition | Built: code candidates use the same scoped selection as local checks; explicit full scope and post-accept audits keep full verification. Local scoping is still opt-in with `FORGE_CHECK_SCOPED=1`. | [GitHub Actions checks](github-actions-checks.md), [development](../development.md) |
| G4 | Flake containment: retry a failed test file once, record a pass on retry as flaky, never silently green | Built in part: quarantine, separate failed and flaky file lists, and a "too many flaky tests" limit exist. The exact retry-once rule was not re-verified here; read the operations text before relying on it. | [operations](../operations.md) (quarantine and `contractReports`) |
| G5 | The check report lists every failed test file | Built: hosted `contractReports` retain every named failure, including incomplete files; receipts separate failed and flaky lists. | [operations](../operations.md) |
| G6 | A runner label (`runsOn`) so hosted projects keep their own runners (bring your own CI parity) | Built: `runsOn` defaults to `ubuntu-latest` and can name other labels. | [GitHub Actions checks](github-actions-checks.md) |
| G7 | Per-machine content cache plus direct object-storage reads for self-hosted check workers | **Superseded** by the pack-based machine object store and per-job cache; direct storage reads exist. | [GitHub Actions checks](github-actions-checks.md) |
| G8 | Measure and publish gate time per landing (p50 and p90), dollars per landing, and N-agent composition against a GitHub merge queue; re-run E3 | **Awaiting evidence.** Time to main per task, CI minutes and jobs, and Convex cost are published for B1.5d; gate time per landing on free runners, dollars per landing and the E3 re-run are not. Planned for the launch work. | [B1.5d report](../research/b15d-report.md), [why-forge](../why-forge.md), [roadmap](../roadmap.md) (7.5) |
| G9 | A self-hosted runner for any OS or container (the earlier `mac` provider generalised to `self-hosted`) | Built: provider `self-hosted`, a container recipe and a one-command start; the old `mac` spelling still writes `self-hosted`. | [Self-hosted runner](self-hosted-runner.md) |
| G10 | Runner cache and snapshot slot (bring your own snapshot): a verified local source cache plus an optional declared setup step | **Awaiting evidence.** The runner setup code honours a source-cache directory setting. Whether the optional declared setup slot exists for vendor actions was not verified, and use with vendor sticky disks or snapshots is untested and unpublished. | [GitHub Actions checks](github-actions-checks.md) |
| G11 | CI adapters for GitLab CI and Buildkite | **Future, not committed.** Adapter breadth was dropped for the beta (GitHub Actions plus self-hosted only; revisit on outside-user demand). Do not restore it as a plan from this row. The bring-your-own-CI requirement is separate and stands: checks and the landing queue must not depend on one CI provider. | [Pre-queue checks](../pre-queue-checks.md), [roadmap](../roadmap.md) |

## Related items from the same plan

| Item | Disposition |
|---|---|
| Q1 `.forgeignore` and ignored-path counts in status | Built: a Forge-only ignore file layered on `.gitignore`, and status reports counts of ignored paths. |
| Q2 per-path "who can see this" | Future: tracked as per-path visibility in Phase 8 of the [roadmap](../roadmap.md). Ignore is not privacy. |
| CD1 post-landing deploy step | Future: "deploy after landing" is a Phase 8 candidate. It would need protected paths first. |
| W8 public project governance | Built: roles, protected paths and re-checked membership at each write. See [governance](governance.md). |

## Requirements to keep

These are conditions the plan set for any gate-speed work. They stay requirements, not results.

- **Portable cache and snapshot.** Any cache or snapshot input may change speed only, never pass or fail. Results stay verified against pinned source and check definitions.
- **Runner qualification.** A runner (hosted, self-hosted or container) must authenticate with a machine credential, run a pinned check definition against verified source and return redacted results. A new runner kind is qualified by a test against a fake or sandbox server before it is described as supported.
- **Bring your own CI.** Nothing GitHub-specific belongs in the core landing path; a second adapter, when one exists, should pass the same contract test.
- **Spend.** Any paid compute provider needs explicit owner approval and a hard spend limit first. Account and spend details belong in private planning, not in this page.
- **Measure before claiming.** Gate-speed claims need a before and after measurement; unrun targets stay labelled as targets.

## What was left out

The original plan's account names, the retired native check paths and compute vendors, per-account spend details, and its ordering ("G9, then G10, then G11") are not carried over. The 10 and 5 minute targets and the free-tier job count are kept only as history above.
