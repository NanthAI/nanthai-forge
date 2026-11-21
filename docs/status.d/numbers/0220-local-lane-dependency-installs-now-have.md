Local Lane dependency installs now have a 4 GiB soft LRU budget with a GiB override,
automatic sweeps and `nforge prune` preview/apply. Existing checkout links and live
install/link locks retain their trees, including sealed installs and relink rollback.
Explicit prune reports allocated bytes including downloads, deduplicates hard
links and identifies a busy sweep. Policy-suffixed npm links follow changed lockfiles automatically.
[dependency sharing](../../parallel-work-defaults.md#sharedependencies).
