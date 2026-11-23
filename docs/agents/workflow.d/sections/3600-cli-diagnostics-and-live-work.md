### CLI diagnostics and live work

`agent ROOT lanes '{"limit":50}'` pages open hosted Lanes with Lane/Intent id,
actor, last save and latest Intent landing (`scope:"intent"`). Follow
`continueCursor` as `cursor`. One query/page, zero writes/idle calls, at most 100
indexed Lanes and O(page) metadata reads; no client follow-ups or source downloads.
Lifecycle overlays can shorten pages; missing facts are `null`.

No-Lane friction attaches to project/actor; inside a Lane it infers that Lane:

```sh
nforge agent ROOT save --friction '{"title":"…","detail":"…","area":"cli"}'
```

Recording uses one mutation; field errors use zero network calls. Hosted roots
need no Git; explicit `url` plus `projectId` works from any folder. When ROOT does
not exist (a project id typed as ROOT), its client state lives in Forge's state folder
(`$XDG_STATE_HOME/forge/addressed`, default `~/.local/state`), never beside ROOT, and
later calls with the same ROOT still find the address.
`FORGE_ROOT_UNAVAILABLE` names an unaddressed root and next steps.

`heavy --help`, `-h`, no command and `--status` acquire no slot and use no network.
Status lists each holder (slot, pid, Lane id, elapsed time, executable and same-folder
`selfHeld`) and each waiter in queue order (position, pid, Lane id, executable, time waited),
never folders or arguments; older holders can lack metadata. Slots are granted first come,
first served, and a waiting `heavy` prints its queue position and an estimate. Run bounded
batches under heavy, dev servers directly.

`heavy node --test FILES` (and wrapped test commands: `sh <script>` or `sh -c` with `node --test`)
first runs `npm run build:core` when `dist/` is missing or older than `src/`
(one stat pass when fresh; a failed build stops the batch and prints the command).
It also names any `--import`/`--require` preload that the project's own `test` script passes to
`node --test` and the command leaves out, since tests that depend on that setup can fail only there,
and warns on stderr when `--test-name-pattern` matches no top-level test.

Pull preserves ROOT and surviving directory inodes; see [recovery](../../../operations/source-exchange.md#hosted-main-client-checkout).
`CWD_UNAVAILABLE` precedes hooks and gives `cd` advice: `cd /`, then
`cd /absolute/path/to/your/Forge/checkout`, then retry.

Preflight time estimates use the measured wall time per selected file, including its
build, averaged over the last 8 successful local runs (or the latest run when no window
exists yet); the same figure fits the local time budget and the run re-checks that budget
between groups (see parallel-work defaults). Sibling Lanes reuse the same
clone-local sample. The single disposable local
sample is replaced after a completed successful run; failed runs do not train it.
A cold/corrupt sample uses four seconds per file. Estimates are approximate when
the selected mix or machine load changes. Learned estimates never expand the set
of runs made mandatory by the existing fixed-cost gate budget. This adds no hosted reads or writes.
