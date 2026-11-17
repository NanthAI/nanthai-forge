# Run evidence

A passing command, the tests that command reports and an agent's own verification
claim are separate facts. Forge records the command outcome against exact source.
Test-file counts, coverage and file timing from the checked code are self-reported
via CI. They are not independent measurements by Forge. CI time is reported by
the runner; the interval between Forge's recorded timestamps is observed by Forge.
Missing test reports mean **not reported**, even when an older runner retained an
empty report summary. They do not mean that zero tests ran.

Saves accept optional `notVerified` and `outside` declarations in the hosted save
request. They are retained on the immutable save and its original terminal receipt,
with the authenticated author and exact source head on the save. The receipt links
to that immutable save through `saveId`. Retrying the original request
returns the same claim. They add no approval or landing block.

- Omit `notVerified` when the agent has not reported its verification limits.
- Send `notVerified: []` when the agent claims it verified everything it changed.
- Send a list of strings to describe the work it did not verify. This is an agent
  claim, separate from recorded check evidence.

`outside` contains `{kind, what, where?}` summaries. Kinds are `deploy`, `migration`
and `external-setting`. Forge records that the agent made the report; it did not
observe or authorise the external action. Summaries redact token-shaped values,
URL details, private paths and private hostnames. Do not send credential values,
private device labels or settings payloads.

The proof read returns the exact save and check source pins. A composed Candidate
can contain more than one Lane: a claim is never silently moved from its save to a
different checked head. If the association cannot be established, the page says so.

The proof page’s full-check action requests a fresh execution of the configured
command on the original Candidate and source pins, even when an older pass is
reusable. It does not land, change policy or substitute current main. If those
check or runner pins are no longer available, the existing structured error is
shown. Retries use one operation identity derived from the original run.

The check screen links to proof for its displayed run. The proof page uses the
existing receipt-based revert operation directly: it creates a new checked landing
that removes the selected change and preserves later work. A lost reply retries
the same operation; no additional review step is introduced.

Landing requests accept the same optional declarations. The original landing request can
retain them without forcing a redundant save. The CLI/MCP writer is a separate
rollout after these readers; its capability is `save-declarations`.
The proof page gives that request's declaration precedence, binds it to the
accepted source, and links follow-up Items to the immutable landing identity.
Older requests continue to mean “not reported”. Outside summaries are sanitized
before replay identity and persistence on both paths.

Compact successful landing receipts use `selfReportedTestFiles` for the number of
test files reported by the checked code via CI. `null` means no file report, not
zero tests executed. Failed/flaky details keep their source label; `--detail`
keeps the complete original record, including zero counts.

## Stats

Stats shows a project owner what Forge measured in their project, and compares it with the same
project's own history replayed through a GitHub-style flow. The comparison never applies the
published benchmark's ratios to a project: a project is not the benchmark.

### Measured figures

Facts from the project's accepted landings, each with its unit:

| Figure | Unit and source |
| --- | --- |
| CI minutes per landing | Runner minutes of the accepted check plus the checks its earlier attempts discarded, reported by your CI. A batch member carries its share of the shared check. |
| First-try rate | Share of landings accepted on their first attempt. |
| Time to main | Median from "land" to on main, observed by Forge, with its stops: in queue, checking, landing. |
| Wasted CI minutes | Runner minutes of discarded checks. |

A landing whose runner minutes are unknown is left out of every CI figure and counted ("12 landings
without runner minutes"); it is never priced as zero.

### Own-history replay

The contract is `src/stats-estimate.ts` (Issue `a61d3c91`). It is pure and display-only: never an
input to a verdict, a queue or a bill.

- **Full check.** One replayed run costs the median billed runner seconds, and takes the median
  check time, of the day's checks that ran the whole command. With no full run that day it uses the
  scoped checks Forge ran, which can only understate a GitHub run, and says so (`basis`).
- **CI minutes, a range.** Lower bound: each change runs the full check once as a pull request and
  once in a merge queue. Upper bound: plus one rerun for each landing that reached main while it
  waited (between its "land" and its own arrival on main, from Forge's recorded times), as when
  branches must be up to date. Stats headlines the lower bound ("at least ... fewer").
- **Time to main.** The same arrival times through a merge queue that checks one change at a time,
  each run taking the full-check time; one pass, oldest first. The queue carries across days.
- **Tokens.** Shown only as a measured Forge figure with a link to the published benchmark; never a
  per-project "saved" claim.
- **Left out.** Review time, flaky reruns and conflicts found after CI, so the real GitHub figure is
  likely above the lower bound.

The comparison starts at 50 landings in the window (`STATS_COMPARE_MIN_LANDINGS`); until then Stats
shows only the measured figures.

### Interface

- `StatsLanding`: one accepted landing from fields its receipt and landing row already hold
  (`submittedAt`, `landedAt`, check start and end, `runnerSeconds`, `discardedRunnerSeconds`,
  `attempts`, `ranInFull`, `who`). `null` means unknown.
- `replayEstimate(landings, freeAt)`: the CI range (`runs`, `reruns`, `replayRunnerSeconds`), the
  replayed seconds to main and the full check it used, over priced landings only.
- `statsDay(day, landings, freeAt)`: one closed UTC day as a `StatsDay` (`statsDaySchema`): counts,
  sorted seconds for medians, the day's replay and its `freeAt` for the next day, and landings by
  who (at most 40, the rest under `others`). A day past 2,000 landings is marked `partial`.
- `statsWindow(days)`: what Stats shows for a window of closed days: `measured`, `comparison`
  (null under 50 landings), and `who`.

Days are additive, so a month is the merge of its days and medians stay exact.
