# Agent efficiency evaluations

This directory holds the recorded trials that compared an agent working through Forge with the same agent working through plain Git. `agent-efficiency-results.json` and the related JSON files hold every observation, including failures, with prompt and harness hashes and per-call token counts. Private source and original logs are not committed.

## What was measured

Paired tasks ran on matching synthetic repositories and one real 670-file repository. They were source investigations and small deliveries (edit, check, accept). Each pair used the same model through the Codex CLI. Both conditions started from identical trees, which a guard checked before dispatch. Hidden tests graded the results. Tokens, tool calls, commands and wall time were recorded, including setup and failed attempts.

There were three series: an original series of 14 sessions, a second series of 14 sessions after the interface was simplified, and a final series of 3 pairs after guidance changes. Each task and condition has one observation, so variance is unknown.

## Conclusion

Forge did not show a general advantage over Git.

- In the latest paired guidance trials, Forge used 14.2% more total input and 7.27% more time than Git.
- The first series was worse. Forge used about 2.8 times the total input and 2.4 times the time, with three times the calls.
- The second series cut that overhead. Uncached input was lower for Forge, but total input, output, commands and time were still higher.
- The one best result was the repeated 670-file task, where Forge used fewer tokens and less time.
- Agents often ignored the graph tools and read files directly. Lower uncached input mostly reflected cache accounting, not graph savings.
- All deliveries passed in both conditions. The invalid pair in the first series was caused by a harness bug.

These trials used one agent harness, single observations and no billed-cost data. They cannot show that Forge is cheaper or faster, and they do not show it is worse in every case. They do not measure the multi-agent coordination that Forge is designed for.

## Reproducing

The scripts `scripts/agent-efficiency-trial-*.mjs` prepare, run and summarize trials, and `agent-efficiency-trial-report.mjs` regenerates the sanitized JSON. They need a privately installed package, a supported Node and the Codex CLI. Never reuse an operation ID for a different request.
