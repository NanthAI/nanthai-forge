Local Lane dependency installs now have a 4 GiB soft LRU budget with a GiB override,
automatic sweeps and `nforge prune` preview/apply. Main, recent or pinned Lanes,
selected CLI builds and running work retain their dependencies. Forge restores links
to evicted installs when a Lane wakes. Explicit prune counts allocated download
bytes toward the budget and can evict old, unused stores. Its retained install
report lists allocated bytes and the locally idle Lanes whose links keep each
set. It also reclaims clean idle Lane cache copies after owner-confirmed
permanent project deletion, or for unreachable projects past the grace period with
explicit `--unreachable [--apply]` (never `AUTH_REQUIRED`, never automatic). Kept
dirty copies list up to 20 unsaved paths (`added`, `modified`, `deleted`) and flag
stale checkout markers (`staleMarkerHead` / `staleMarkerVersion`); `status {"files":true,"laneId":"LANE_ID"}` inspects
a registered Lane locally from the project root, and snapshot workers skip finished
Lanes.
[dependency sharing](../../parallel-work-defaults.md#sharedependencies).
