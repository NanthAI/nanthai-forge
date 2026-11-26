## Intent proving-test contracts

`agent tests {"candidateId":"CANDIDATE_ID"}` proposes the new/changed tests
and derived affected set for that clean Candidate. Proposals include per-file
timing estimates from native timing history where available; unknown timings are
`null`. Add `runId` to use complete measured reports from an existing run on the
exact Candidate. Hosted mode reads the same machine reports from verified, sealed
check output. Proposal reads never run project code.

Use [`tests {runId}`](3900-check-report-detail.md) to inspect an existing
check's suite outcomes and browser shard using just its run ID.

Confirm or edit with one CLI command (MCP: `forge_check`, action `confirm-tests`):

```sh
nforge agent ROOT save --contract '{"operationId":"UUID","candidateId":"CANDIDATE_ID","expectedVersion":0,"runId":"RUN_ID","tests":["tests/example.test.mjs"]}'
```

Omit `tests` to confirm the proposal, or supply the exact edited list. Confirmation
requires complete timing measurements from a completed run on that Candidate;
historical estimates alone cannot confirm. Missing measurements return
`CONTRACT_TIMING_MISSING`. A summed measured duration of 90,000 ms or more returns
`CONTRACT_OVER_BUDGET` with the measured total and slowest tests. The sum is test
file execution time, not parallel wall time. Measure missing files through the
existing Candidate check path, then confirm with its run ID.

The Intent retains versioned contracts with the proposed and confirmed tests,
per-file durations, total, Candidate, measured-on head and run. Reuse the original
operation ID and parameters after an unknown outcome. Edits name the current
contract version; earlier versions and their receipts remain available. CLI and
MCP receipts and the Intent/Review pages show the contract and exact measurement
pins. A later Candidate does not inherit measurements from an earlier head.

Both contract-bearing and contract-less Intents retain the existing acceptance
policy and complete check gate. Contracts do not authorize contract-only acceptance.

A clean composition with another accepted or included queued Intent also checks
both declared contracts on the exact composed Candidate. The union deduplicates
test files and augments the existing selection; complete reports from that check
satisfy it without another run. Native custom commands and hosted self-hosted-machine checks (legacy `mac`) run
uncovered files in the same workspace after the configured command. Actions keeps
files already assigned to shards there and covers missing files in its existing
static job. Original run identities and content-keyed passing-check reuse remain
in place.

A failing covered union records `INTENT_SEMANTIC_CONFLICT`, naming both Intent
IDs and outcomes, contract versions, Candidate/head, run and failed tests. Landing
status, agent responses and review reads retain that record. Source composition
remains clean: the semantic conflict is separate from a text conflict. A clean
union raises nothing. Incomplete reports and failures outside the union retain
ordinary check outcomes; they do not establish a semantic conflict. A contract-less
pair keeps the existing behavior. This is observed pair failure, not proof that
either Intent fails alone or that the pair is minimal.

The B2.1 budget also applies per pair: unique measured test-file time must stay
under 90,000 ms. An over-budget completed union returns
`CONTRACT_OVER_BUDGET` with its measured time and both Intent IDs. Earlier declaration
timings never refuse a new composition before it runs. Conflict records
use existing landing writes; composition carries selected contract metadata, and
idle queues add no function calls or scheduled work.
