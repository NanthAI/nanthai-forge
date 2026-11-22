Preflight runs a learned guard set first for every project and runner: test
files that failed landing checks at least twice while preflight skipped them,
picked by `p x C / r - t`, inside the local budget. The server learns it from
the whole project, writing only when a check fails; Lane start replies deliver
it, so fresh sandboxes get it on their first start. It is Automatic, with a
`preflight.guardSet` pin, unpin, manual or off override.
Files main's own red audit fails are never learned as a Lane's, even when a
check pinned to the last red head ends after recovery. When a plan is over `preflightMaxMinutes`, `land --save` still runs the top of the run order
for 90 s and refuses on a failure.

An inline budget overrun returns `PREFLIGHT_BUDGET_EXCEEDED` with its continuation
and the exact replay. If a running quick group hits the cap, replay reuses its
receipt and leaves the remaining tests to the hosted check.
Preflight previews hosted secret scanner and queue proof findings from saved
files against observed main. For the standard Forge check, `land --save` can
refuse a confirmed missing or stale queue proof before composition. Compact landing replies retain
the first safe diagnostic line, including its code, for reported static failures.
