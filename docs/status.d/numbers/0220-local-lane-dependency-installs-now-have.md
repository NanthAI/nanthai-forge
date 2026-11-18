Local Lane dependency installs now have a 4 GiB soft LRU budget with a GiB override,
automatic sweeps and `nforge prune` preview/apply. Existing checkout links and live
install/link locks retain their trees, including sealed installs and relink rollback.
Policy-suffixed npm links follow changed lockfiles automatically. Details:
[dependency sharing](../../parallel-work-defaults.md#sharedependencies).
