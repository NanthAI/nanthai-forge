Local prune batches lifecycle reads across projects on each deployment (250 identities per page),
retains inaccessible or missing records with a recovery reason, and preserves live/unknown-process
copies. Snapshot stat refreshes no longer keep finished Lane copies on disk when their
saved baseline still matches and no snapshot is running. Test files use private temporary
roots; the supervisor reclaims them after timeouts, and
normal file exit fails on leaked Forge temporary entries.
