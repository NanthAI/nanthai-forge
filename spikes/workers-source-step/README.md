# Workers source-step spike

Local-only S8a harness. The recorded 29k compose observation ends Option B under
its 100 MB kill rule. See [results](../../docs/research/workers-source-step-spike.md).
No runtime module imports this folder. No deployment/account configuration exists.

From the Lane root, with the project's pinned Node 24 and dependencies installed:

```sh
nforge heavy npm ci --prefix spikes/workers-source-step --ignore-scripts
nforge heavy npm run build:core
nforge heavy node spikes/workers-source-step/build.mjs
nforge heavy node spikes/workers-source-step/baseline.mjs 29k-compose
nforge heavy node spikes/workers-source-step/qualify.mjs 29k-compose --output private-artifacts/source-spike.json
```

Create the ignored output directory before using `--output`. These are diagnostic
commands, not a new adoption run; do not continue the experiment after its kill.
`qualify` creates and disposes one Miniflare/workerd instance and local R2 binding.
It seeds canonical synthetic bytes, invokes the unchanged compiled `runSourceStep`,
and collects isolate memory through CDP at transport and quantum boundaries.
It does not call Cloudflare accounts or use remote bindings. Generated bundles and
local dependencies are ignored. The nested lockfile pins Miniflare/workerd;
esbuild and TypeScript use the existing root lockfile.

`baseline` uses the existing `scaleFixture` Convex provider harness, its actual
begin/resolve/commit code and synthetic DB/R2. No hosted workload executes.
`fixtures.mjs` preserves the existing 4k deep compose and 12k/29k small-save and
merge shapes with fixed identifiers; 58k extends the same tree. Only 29k compose
qualified before the kill. The other valid shapes remain unrun.

The R2 adapter supplies trusted synthetic descriptors in one request. It uploads
raw content-addressed bytes; it does not reproduce the provider's recipe/chunk
publication, staging, signed grants, retry control plane, or fan-out. Consequently
its request/byte counts describe this adapter. Output equality covers the logical
result pin, not the physical object layout or a production provider contract.

The Worker uses `nodejs_compat` and the entire source-step bundle, including the
lazy TypeScript dependency. No source branch is stubbed, removed or optimized.
The exercised fixture contains `.txt` files; syntax merging, large file recipes,
conflicts and concurrent invocations remain unqualified.

`tests/workers-source-step-spike-metrics.mjs` deliberately distinguishes an observed lower bound on isolate peak
from allocated heap capacity and process RSS. Checkpoints cannot establish a
passing peak. Node compatibility counters returning zero are not measurements.
The inspector affects diagnostic memory; its overhead is not isolated. Paused
wall time is labelled diagnostic and CPU remains unknown. The captured result
predates automatic load/output capture; its missing fields stay null.

A future experiment would require a new agreed decision after this kill. Its
measurement plan is 11 interleaved baseline/Worker pairs per shape, load average
for each sample, CPU profiling separate from wall samples, 10,000 paired bootstrap
resamples with seed 1, and no +5% median regressions beyond the noise rule. It
must capture all voids and check memory independently. This harness does not
claim those unrun pairs, deployed CPU billing or an adoption pass.
