Preflight runs a learned guard set first for every project and runner: test
files that failed landing checks at least twice while preflight skipped them,
picked by `p x C / r - t`, inside the local budget. The server learns it from
the whole project, writing only when a check fails; Lane start replies deliver
it, so fresh sandboxes get it on their first start. It is Automatic, with a
`preflight.guardSet` pin, unpin, manual or off override.
