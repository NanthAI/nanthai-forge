# Forge queue shape replay

Replay the current singleton landing path under four workload changes, with a
Forge-shaped baseline in the same batch. High traffic has separate 30 and 60
offer/hour cells. The model uses synthetic changes and arrivals with measured
Check and publication inputs. The [specification](spec.md) lists the assumptions
and the boundaries of the model.

Run from the repository root with Python 3.10 or later. Both commands use only
the standard library and checked-in inputs. Each prints JSON to stdout and
runs with seeds **137, 311 and 571**.

```sh
nforge heavy -- python3 -B models/queue-shapes/shapes.py
nforge heavy -- python3 -B models/queue-shapes/shapes.py --refit
```

The second command reproduces the measured-load incumbent from the queue refit
at 15, 30 and 60 nominal solo-green offers/hour, with and without sampled
historical holds. Its rates refer to a different denominator than the shape
cells' raw offers/hour. This arm retains the historical random main-race
rechecks and historical competing jobs for reproducibility.

- [base.json](base.json) retains the Forge profile, measurement counts, hold
  samples and needed columns from the refit's synthetic traces.
- [shapes.json](shapes.json) sets the baseline and one override per scenario.
- [Publisher measurements](publisher/measurements.json) retain draws for the
  serial publication station. [Background jobs](publisher/background.json)
  contain clipped release times, durations and purpose labels.
- [collect.py](publisher/collect.py) and [measure.py](publisher/measure.py)
  reproduce those inputs from retained local records. They read local files and
  emit anonymous timing data. The replay requires only their checked-in output.
  From this directory, run `python3 -B -m publisher.collect LEDGER.csv` or
  `python3 -B -m publisher.measure CACHED_RESPONSES LANDING_PAGE.json [...]`.
  These helpers accept the prior ledger and landing-page formats. Keep the raw
  job and receipt records outside the repository.

For an independent check of the order rules, the refit's current-controller arm
used the repository's [bench replay](../../tests/queue-sim/replay-runner.mjs)
and [pass-age fixtures](../../tests/hosted-landing-pass-age.test.mjs). With the
Lane's core compiled, run the same fixture set from the repository root.

```sh
nforge heavy -- sh -c '
  FORGE_QUEUE_REPLAY_CELLS=1/1,1/2,1/3,3/1,3/2,3/3,5/1,5/2,10/1,10/2,10/3 \
    node --import ./tests/check-runtime.mjs --test tests/queue-sim/replay-runner.mjs &&
  FORGE_REPLAY_COVERAGE_CHILD=1 \
    node --import ./tests/check-runtime.mjs --test tests/hosted-landing-pass-age.test.mjs
'
```

Fixture and model runs use zero hosted CI. The fixture run exercises actual
queue code over the existing traces. The shape run estimates sustained load
and its synthetic timing at larger scales.
