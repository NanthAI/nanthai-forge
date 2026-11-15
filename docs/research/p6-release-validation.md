# Phase 6 release validation

The fixed release-validation series is terminal. The owner-approved disposition
on 2026-11-15 retains **n10-r1 as the validation result** and moves the overlap
rerun to Phase 7 Item `0a9df3cd`. No cell is retried or restarted for this report.
The published v2 headline, historical flags and comparisons remain unchanged in
[the descriptive report](p6-exit-bench-results.md); the new observations are the
separate `release-a01baea7` validation series in its [JSON record](p6-exit-bench-results.json).
One rep does not establish final-build medians or a replacement headline.

The accepted release is Git `a01baea77dd0001a03b99c01db86199d1cae1f9c`,
Forge State `aea148219c1818f96d4de76d3e095148e8d1560f53243b12e5b030b98435d27b`.
CLI, harness and deployment pins match for the completed cells. Deferred S2
reader/writer work is outside this release. The fixed registration digest is
`28c404c9dfd87aac7ca675d7702076cbc21e0f629b25c61929e4c3b00960cc5b`.

## N10 validation

Both arms landed all ten tasks, with no task or cell voids. These figures were
generated offline from retained run folders by the pinned `summarize.mjs` and
the Lane's `stats.mjs` / `stats-render.mjs`, using the published classifier pin.

| N10 rep 1 measure | Forge | GitHub |
| --- | --- | --- |
| Landed tasks | 10 | 10 |
| Time to main/task, median s | 375.362 | 474.429 |
| Wall to all landed, s | 860.677 | 1112.053 |
| CI minutes (billed-equivalent) | 27 | 65 |
| CI jobs | 9 | 29 |
| Cached input tokens | 20123776 | 34940800 |
| Output tokens | 79360 | 111099 |
| Agent turns | 322 | 504 |
| Recovery turns, cell total | 0 | 9 |
| Strict correctness, of ten | 6 | 7 |
| Lenient score | 0.757 | 0.763 |

The strict 6 versus 7 result is retained openly. The owner treats that difference
as LLM variance; it is not chased with extra runs. Recovery counts use the same
offline classifier as the published series. These observations do not isolate a
causal release effect or replace the registered historical results.

## Overlap disposition

Attempt 1 finished with Forge offer and auto each landing 8/8, both strict 8.
GitHub landed 6/8, with a harness error on o08. That error voids the whole batch,
including both Forge arms, so none supplies a valid comparative overlap result.
Their exact input digests and void disposition remain in the generated record.

Attempt 2 was stopped by the lead with SIGINT; the series runner reported
`SERIES STOP` and exit 130. Its interrupted GitHub cell is voided and supplies no
result. Missing completed Forge arms are not zero observations. The five leftover
GitHub PRs were closed and their runs cancelled before this reporting task.
There is no valid overlap rerun or stacking-default conclusion from this series.
Phase 7 Item `0a9df3cd` owns that rerun; this report starts no further workload.

## Reproduction and scope

Use the descriptive report's reproduction command with its retained historical
input locations. Add one `--validation-series release-a01baea7=CELL_DIRECTORY`
for each of the six non-dry retained run folders from this fixed series. The
four completed/voided overlap inputs remain separate from the two valid N10
inputs. Retain the enclosing batch metadata so whole-batch voids are respected.
Dry qualification is separate and is not included in this validation series.

The primary remains `--primary rerun`, with classifier State
`0759c451bed7dbc64e47bb0b09f6b3f24646addbe7ce1d5ab74353357ccbdc34`.
Regeneration was checked against the published JSON: all pre-existing series,
task flags, history and classifier digests are equal, and the headline table is
byte-identical. Raw inputs are unchanged. No benchmark, deployment, registration,
setting or harness behavior changes are part of this reporting slice. No new
billing, byte-placement or runtime-memory measurement was made.
