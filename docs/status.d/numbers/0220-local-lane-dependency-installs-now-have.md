Local Lane dependency installs now have a 4 GiB soft LRU budget with a GiB override,
automatic sweeps and `nforge prune` preview/apply. Main, recent or pinned Lanes,
selected CLI builds and running work retain their dependencies. Forge restores links
to evicted installs when a Lane wakes. Explicit prune counts allocated download
bytes toward the budget and can evict old, unused stores. It also reclaims clean
idle Lane cache copies after owner-confirmed permanent project deletion.
[dependency sharing](../../parallel-work-defaults.md#sharedependencies).
