## Disjoint fast-path landing

Candidates record `composedMain` separately from the Intent's original `base`.
Composition retains its selected base and inputs. The field records the newest
accepted main actually contained in those States, including main inherited through
a Lane sync.
With `acceptance.disjointFastPath` enabled, finish can select a prior passing Candidate
for unchanged current inputs, and finish/direct acceptance can reuse
current passing evidence when main moved after the check. Inside the short landing
slot Forge revalidates the exact checked Candidate, current input Lane heads, check
definition and runtime fingerprint. It proves that current main descends from the
recorded main, compares exact manifest paths (including adds, deletes, modes and
both sides of a rename),
and composes cleanly before the acceptance CAS. File/directory collisions count as
overlap, even when two additions have identical bytes. Missing provenance, stale evidence, overlaps or conflicts use the ordinary
sync/compose/re-check path in finish. Checks never hold Work, Lane or landing locks.

Native batch landings reuse retained passed checks across resubmissions when the
stored content key agrees: tree (paths, bytes and modes), check definition, lockfile,
Node major.minor and observed declared inputs. New execution and virtual receipts
retain this key alongside the full environment fingerprint and runner runtime.
Old receipts without a key are never reused. Scoped and custom checks also require the original
base/comparison source, ordered Lane inputs and dependencies. Full standard checks
can reuse identical source after acceptance or a main audit changes composition
metadata. Main audits consult the same full-plan evidence before requesting a new
controller. Concurrent requests with the same exact execution inputs adopt one
reserved run and its Candidate before dispatch; its detached controller executes
once, and both requests observe the same result, including failure. Cancelling
one request leaves a check needed by another request running.
Remote reuse also validates the retained runner recipe and selected scope/tests
against a freshly prepared plan. Shard placement and count are scheduling advice. Node patch and runner label are
receipt observations and do not invalidate the key. It adopts the original validated shard
placement despite advisory timing-history changes; selection explanations and shadow
coverage diagnostics and billing safety margins do not change execution. Local reuse requires
matching scope/selection; unobserved declared inputs,
passthrough values and external claims fall back to a normal run. Missing or corrupt
completion/plan evidence, failed and cancelled runs are never reused.

A batch whose diagnostic run is interrupted or whose local controller is dead
also searches for a later identical pass before waiting or reopening the original.
The same content-key, selection and retained-evidence checks apply.
Adoption creates a new virtual receipt and updates the batch prefix; the original
run and diagnosis remain retained. A cancelled request is not revived, and a live
controller is left to complete normally.

A reused run records `reusedFrom.runId` and the original completion time. Progress
and queue status say `reused check <run> from <time>`; the original run owns logs
and compute costs. Virtual receipts have no process (`runner.pid:0`), so older
readers reject them instead of silently dropping reuse provenance. Submitting CLI builds and temporary run/View identities do not
change check inputs. Owner restart, sleep, install-path changes and Node patch
upgrades preserve reuse; Node minor, lockfile or declared-input changes require
a new run. Explicit partial test lists can never satisfy a gate. The `run` action
accepts an explicit `tests` list for a failed-file-only retry and records partial
evidence. Actions does not retry failed test shards.
Check-only commands and `assess-check-inputs` retain their existing behavior.

The acceptance receipt's structured `fastPath` records the policy, checked
Candidate/head/run, definition, runtime, previous and composed main, both path sets and
the required full post-accept check. The accepted Candidate pins the resulting source;
the original checked Candidate remains retained. Retrying the original operation
reconciles that acceptance without composing, accepting or checking it twice.
Dependency and resolution Candidates complete only their pinned input Lane heads;
a later head stays open.

Fast-path acceptances and acceptances checked with a scoped or docs-only standard
check enqueue full main verification. Pending requests coalesce onto the newest
accepted main. One owner worker serializes these main checks through the normal
machine check queue with `FORGE_CHECK_FULL=1`; no landing lock spans a check.
Audit scheduling reads selected main/request/run records. Writer admission never
reconstructs the complete Work history; landing edits also use selected records
on their final under-lock retry. Contended audit drivers back off from one second
to 30 seconds. After 15 minutes without audit progress the driver releases its
slot with `MAIN_AUDIT_STALLED` and writes `post-accept-main-state.json` in the
owner metadata directory. Source, pending requests and run evidence remain
retained, including an unfinished optimistic recovery without a conclusive verdict.
Provider job/log changes and local command output count as progress; GitHub
controller failure/rate-limit diagnostics and unrelated owner commits do not.
A wake received during audit observation triggers another observation before
the pending wake clears. A later wake or explicit retry resumes the same pending
work. Checks execute in detached controllers so a stopped driver cannot starve
completion observation.

Audits have the lowest priority: foreground check admission cancels a running
audit's process group before claiming its capacity. Cancelled or interrupted
audits retain their evidence and are requeued with a new execution identity for
the latest main. Superseded pending requests coalesce onto that audit. Once the
foreground queue is idle the audit runs; `github-sync --push` drains pending
main audits before publishing. If another audit worker holds the queue, it returns
JSON `pushed:false,reason:"WORK_BUSY"` with exit 1. Use
`nforge github-sync ROOT --push --wait-audit` to wait up to 30 minutes for the
retained audit and then publish fresh accepted main. `--audit-timeout-ms MS`
changes that wait bound; progress goes to stderr. Timeout retains the audit and
returns `GITHUB_SYNC_AUDIT_TIMEOUT` with exit 1. Sync always returns a JSON result:
dry runs and up-to-date no-push requests have reasons `dry-run` and
`nothing-to-push` and exit 0, as does confirmed publication/reconciliation; every
other no-push reason exits 1.
It requests a full audit of accepted main even when
that acceptance did not schedule one. It uses the configured `verify` check (or
the sole check); missing/ambiguous check configuration reports `CHECK_REQUIRED`.
Audit failure retains the existing fix-forward handoff; push does not add a
passing-check gate.
A request survives a lost worker and is resumed on owner status or acceptance.
The resulting run is retained with `mainCheck.channel` and linked from Needs you
if it fails. A newer successful main check clears it. A failed, interrupted or
cancelled main check also creates one Intent per failing main head:
“Fix main: <check> failed after <landing>”. Its `mainCheckFailure` links the exact
run and acceptance; its description and decision note contain a copyable agent
prompt with the log command and Intent ID. Start the repair Lane on current main,
preserve later accepted work, and check and accept the fix normally. Worker
restarts and repeated observations reuse that Intent, even if it was closed.
Creating the handoff never changes source or rewinds main. The native post-accept worker
never reverts a landing. On a hosted project the main-audit recovery may land a reverse of a
single proven culprit, or a bounded interacting set when none is proven, through the normal queue and checks, unless `acceptance.autoRevert` is
`false` or the culprit or reverse touches protected paths (then it waits for a person; see
[hosted acceptance gate](../../../workflows.md#hosted-acceptance-gate)). Abandon the Intent to close
the handoff; reopen it to resume.

Hosted recovery keeps one operation for the red episode (`red.since`); later failed audits
append evidence without restarting it. When the failure reproduces but no single landing
is proven (including a passing first check on the change's own source), recovery selects
the interacting set using retained check reports, including detached admission-report pages.
Those pages are restored before judging whether the change passed on its own source. Recovery selects
the two most recent landings whose changed paths or declared contract tests overlap a failing test or its retained
error paths. The landing that added a new failing test also counts as overlap. One match
is paired with the newest other landing; no matches selects the two newest. Exact
reverse Lanes retain the authors' work. Their combined Candidate must pass the full check
before anything is accepted. A failed re-check adds the newest unselected landing, one
at a time up to four; then recovery stops, keeps main held and records the failed checks
and an owner handoff. A source conflict or unavailable check also keeps accepted bytes.

Green landings and idle make no additional calls. Red selection uses the existing bounded
range (at most 100 receipts) and indexed Candidate metadata in the recovery transaction;
source attribution reuses verified manifests in windows of 100. Pair recovery adds two
ordinary reverse source jobs, one composition and one full check. Widening reuses prepared
reverse Lanes and adds at most two more transitions, two compositions and two full checks
(a prior attempted single reverse can add one of each). Runner minutes depend on the
configured full check: three pair/widen checks cost at most three such runs; the replay
models successful pair recovery in eight minutes. No live timing or billed-usage drill
is claimed by this replay.

Fast-path does not grant acceptance authority. Under supervised settings an agent
still returns a checked Candidate for person review. Under trusted settings an agent
can land with current passing evidence; protected paths and actor selection still
require person review. Explicit person acceptance without a check follows
`acceptance.withoutCheck`: `owner` (the default), `selected` people/teams, or all
current `writers`. Selected people and members of selected teams need current
project write access at publication; read-only or revoked members and agent
credentials get no bypass. `check-settings` reports the setting; the owner edits
it with `set-policy` ([landing policy](../../../workflows.md#who-can-land-without-a-check)).
Reusing evidence across a main move still requires the full fast-path proof.

New projects and presets keep fast-path off. The dogfooding owner's approved
option is enabled by its owner after installing the current CLI:

```sh
nforge x OWNER set-policy '{"operationId":"REPLACE_WITH_UUID","acceptance":{"disjointFastPath":true}}'
```

Enabling or using disjoint fast-path promotes Work to format 14; disabling it does
not downgrade retained history. Upgrade every writer before enabling it. Earlier
binaries reject format 14 (their legacy error is “Work metadata is invalid” or a
`INTERNAL_ERROR` on some selected-record routes); current binaries identify a future format with “upgrade
nforge”. Additive post-accept metadata for scoped checks alone retains format 13.

Compatibility audit: the pre-B8 installed CLI rejects normal status, start,
checkpoint, note and policy writes against format 14 without changing retained
bytes. Its low-level embedding API `WorkStore.records().commit()` can publish a
revision without parsing the Work schema; it is not a safe legacy writer after
enabling. Current CLI record transactions guard the format on construction.
