# Performance and cost claims: interleaved pairs and bootstrap intervals

Status: **method adopted by the owner on 2026-11-04** for every Forge performance or cost claim. The shared helper script that computes the interval is **not written yet** (tracked in the Bet 2 metrics Issue); until it exists, report the numbers by hand as below. Briefs for performance or cost work reference this page for their acceptance.

## Why

A before/after comparison of two different periods mixes the change with load, time of day and luck (see the [Bet 2 re-measure](../research/bet2-metrics.md): 14 landings at a load 3.5× lower than the baseline proved little). The method adapts one used in published engineering practice: X's engineering team counted a performance change only when 11 interleaved old/new run pairs gave a 95% bootstrap interval that excluded zero ([Rebuilding the global town square from scratch](https://blog.x.com/en/engineering/rebuilding-the-global-town-square-from-scratch), 2026-11-04).

## Rule

1. **Interleave.** Run baseline (A) and candidate (B) in alternating pairs on the same machine and conditions: A1 B1 A2 B2 and so on, or randomize the order within each pair and record it. Never run all A then all B.
2. **Pair.** The unit of analysis is the per-pair difference (B minus A, or the ratio if the quantity scales).
3. **Report the median difference with a 95% bootstrap interval.** Resample the pair differences with replacement (at least 10,000 resamples), take the median of each resample, and report the 2.5th to 97.5th percentiles of those medians.
4. **Call a change real only when the interval excludes zero.** If it includes zero, say "not distinguishable from no change", not "no effect".
5. **Label small samples.** With few pairs (for example N = 2), state N and call the result an observation. Eleven pairs is the bar the method was adopted from, not a requirement to invent samples that cannot be run.
6. **State what the interval does not cover**: load, unmodeled differences between the two builds, and runs that were voided (list each void; do not drop it silently).
7. **Cost claims** use the same pairing on the measured quantity (calls, bytes, billed minutes), plus a check against real billed usage: per [AGENTS.md](../../AGENTS.md), runtime and storage work is done only after billed usage and byte placement are checked.

## Helper contract (to be built)

A small shared script, `scripts/bootstrap-interval.mjs`, taking per-pair values from JSON on stdin or a file and printing `{ n, medianDifference, ci95: [lo, hi], excludesZero }`, with a fixed seed option for reproducibility. It needs a test with a synthetic pair set. Until then, do not hand-wave: show the pair values and the interval you computed.
