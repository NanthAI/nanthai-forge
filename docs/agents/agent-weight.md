# CLI and MCP weight

The accepted-main reference and measurement samples live in
[`tests/agent-weight-baseline.json`](../../tests/agent-weight-baseline.json) (Issue
92dbde9d). It records Node 24.22.1, source State, dependency boundary, logical
installed bytes and CPU/module counts. This is an execution regression guard;
it changes no user limits, access or command steps.

`npm run smoke:package` already builds the CLI, runs `npm pack` with its locked
production dependencies and installs that archive into a new temporary prefix,
offline, with an empty cache and lifecycle scripts disabled. It now calls
[`check-agent-weight.mjs`](../../scripts/check-agent-weight.mjs) on that same
installation. There is no second CI install. Reproduce independently with
`npm run smoke:package -- --artifact-dir NEW_DIRECTORY`, then
`node scripts/check-agent-weight.mjs NEW_DIRECTORY/installed`.

The probe warms a private Node compile cache once, then takes five fresh-process
samples for each path. Diagnostic `--version` and `--help` run the installed entry.
Agent `status`, `planning`, `save` and `land --save` reuse the existing
`perf-harness --cli-cold-start` source-build probe: it exits at the first Convex
call/fetch, or land's detached-submitter hand-off. This excludes release freshness
and remote execution; installed freshness is exercised by package smoke's separate
synthetic release service. No command contacts hosted services. Module counts
include only file modules, not Node builtins. Failed guards also list added module
and chunk names against the recorded inventory. Paths are relative and chunk
content hashes are normalized, so a rebuilt chunk is not reported as a new one.
The added names come first in the failure, each named once with every command
that loads it, so a landing receipt's cut excerpt still lists them all (ad80e037).
Removed names follow so a split chunk can be distinguished from a newly loaded module.
An older baseline without an inventory prints the loaded graph and labels the
missing reference; `--record` includes inventories for later comparisons. The MCP fixture boots the installed
ESM SDK server and real hosted agent registration, connects an in-memory client
and calls `tools/list`; its startup includes that synthetic client. UTF-8 bytes
are guarded here; per-harness token/schema budgets remain owned by Issue
47558a99 and `tests/mcp-tool-list.test.mjs`.
The shorter wait summary leaves 43 UTF-8 bytes between the 5,771-byte listing
and the 5,814-byte installed ceiling (09961b44). A previous optional field
addition took 24 bytes, so that size now fits within the existing ceiling.
The same offline package smoke measured 141,293,832 installed bytes against
the 151,289,995-byte ceiling, and loaded 170 modules for status, planning and save,
and 175 for land.

When adding a dependency to a lazily loaded CLI module, check the chunk report
for shared helpers split out of the eager bundle (de03613f). An eager caller can
pass a helper it already loads as a function argument to the lazy operation.
See [the weakened-test preflight reader](../../src/preflight-weakened-tests.ts),
which uses this pattern for the object store, digest and State parser.

The runtime boundary retains TypeScript (source analysis/public SDK), Lezer
parsers/common/highlight (syntax analysis and merge), Convex and its helpers,
MCP SDK, Noble, ignore, undici and Zod. React, React DOM, react-markdown
and remark-gfm are web-only development dependencies bundled by Vite. Every bare
runtime import in emitted CLI/SDK modules and packaged scripts must belong to
`dependencies`. The real CLI bundle rejects imports of web source, UI packages
and assets, including dynamic imports. Package smoke rejects UI packages anywhere
in the installed closure. Its existing archive assertions exclude web assets
apart from the required notice. The growth guard's action-name inventory is pinned in the same baseline: a new or
changed action fails until its weight and call/read assessment is recorded.
New agent actions share that bundle boundary,
installation and startup guard, and need a synthetic command call/read fixture
when they introduce network work.

## Noise and baseline changes

Bytes, module counts and synthetic calls/reads are deterministic, with zero
allowance. Logical installed bytes sum regular files under the temporary
`node_modules`, including the actual bundled dependency closure and npm metadata;
symlinks and filesystem allocation blocks are excluded. The baseline records
before/after installation and package inventories. No compressed tarball number
is substituted for installed bytes.

CPU uses user plus system time, not elapsed time. Two unchanged-archive batches
of five runs showed large scheduling variation. The shared allowance ratio is
twice the largest relative full range among those paths (recorded as
`cpuNoiseRatio`); each path allows its ten-run median plus the larger of 10 ms
and that ratio times its median. This is a coarse CPU guard on shared hardware,
not evidence that smaller CPU changes are absent. Existing `src/speed-budgets.json` CPU budgets still apply through the
same performance-harness judge inside this check. CPU is judged at reference-runner
speed (10fbb67b): before each measured batch the probe also loads a fixed synthetic
module graph that shares no code with Forge (100 modules, its own warm compile cache,
50-100 ms of CPU locally depending on load; seven samples). Every CPU value and sample is divided by the
runner scale, `max(1, calibration median / baseline calibration.cpuMs)`, and judged
against the unchanged ceilings and budgets. A slow or loaded runner raises the
calibration and the CLI paths together, so it cannot fail the check; a CLI path that
grows raises its own samples alone, so it still fails. A runner faster than the
reference keeps the absolute ceilings, and a report or baseline without calibration
is judged unscaled. Passing package smoke checks keep one summary line with raw
land CPU, calibration CPU, scaled land CPU and version CPU. Version CPU gives
older reports a comparison point from before the calibration probe existed.
Failures keep the full report, including the scale. Two days of
landing checks before this showed every command, the version probe included, about
1.5 times slower on one runner class with unchanged module counts. There is no
in-job repeat. Deterministic byte, module, dependency and action-surface failures
fail immediately. There is no wall-clock timing assertion. Samples record
child peak RSS; the guard reports its wall time and parent peak RSS. The guard
adds seconds inside existing package smoke, targets under 60 s, and adds no
Convex calls, DB I/O, timers, production or idle work. Source and Work placement
are unchanged.

A changed baseline needs an Issue and a measurement reason in
`tests/agent-weight-ledger/`, reviewed with the change. Each record is named by
the baseline's SHA-256 and pins its fields. A clean merge of independent baseline
edits can use their existing evidence when it includes the complete edits from
the same recorded parent. Sequential edits retain their own parents, so a
superseded ceiling cannot be revived by composing unrelated records.

For a new action, add its synthetic call/read fixture and run package smoke
with a retained installation. Then update the pinned action list and regenerate
the ledger record with the measured action inventory and samples:

```sh
node scripts/check-agent-weight.mjs NEW_DIRECTORY/installed --record 'ISSUE_ID: measurements and reason'
```

This preserves ceilings and uses the baseline before recording as its parent
when that baseline has evidence. For a separately reviewed, hand-edited pin,
keep the original baseline in a scratch file before editing. Gather the
measurements and record the edit against that file:

```sh
node scripts/check-agent-weight.mjs --record-ledger --base ORIGINAL_BASELINE 'ISSUE_ID: measurements and reason'
```

Keep the baseline edit and its new SHA-256 ledger entry together in the Lane.

## Command calls and database reads

The same baseline owns exact budgets consumed by existing synthetic fixtures;
there is no duplicate landing model or live benchmark. Counts are for the named
scenario, not a promise for every repository size or compatibility path:

| Command fixture | Convex calls | DB reads | Existing evidence |
| --- | --- | --- | --- |
| Status, fresh transport, selected Lane | 3 | 11 conservative document probes | `agent-weight.test.mjs`, real capability/head handlers |
| Planning filtered open Issues, two matches on a 1,500-item board | 3 | 10 returned documents | `hosted-agent-planning.test.mjs`, real indexed reader |
| Planning counts, 397-item Initiative on a 1,500-item board | 1 | 399 returned documents | `hosted-agent-planning.test.mjs`, real indexed reader |
| Save, unchanged 3,000-file Lane | 2 | 38 conservative document probes | `hosted-save-sync-efficiency.test.mjs` |
| Save, ten changed files on a 3,000-file Lane, direct protocol | 7 including nested executions | 285 conservative document probes | Same real source fixture, including publication; live Lane line ownership |
| Land with save and required inline preflight, one document | 16 client calls | Server below, save separately above | `agent-inline-preflight.test.mjs` |
| Solo server landing from enqueue through check and acceptance | 35 including nested executions and observer | 494 conservative document probes | `landing-cost-guard.test.mjs`; live Lane line 482 → 492, lead-approved pending-only scheduler safety 492 → 494 (`1122c9c9`); existing six-landing cost ledger also applies |

The Lane fixture counts an empty lookup as one conservative probe, while the
planning meter counts returned whole documents. Neither is billed usage. The
status fixture executes an added round trip and verifies the guard rejects it;
the bundle fixture imports web source statically/dynamically and a UI package and
verifies rejection. The unchanged fixtures pass. The existing cost/idle guards
remain in place; no hosted benchmark or polling is added.

This merges the old scattered diagnostic/agent module ceilings and MCP byte
assertion into one baseline, reuses package installation and call fixtures, and
removes five direct UI runtime dependencies and their unused production closure.
