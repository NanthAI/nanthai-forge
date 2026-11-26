Check status clients can negotiate `check-report-detail` for header-only replies. The shared
server action serves exact paged reports from retained inline or paged runs and understands pinned
R2 report objects. Every new run uses the writer (inline readers go on 2026-12-31). Failure lists are bounded to 8 KiB with
exact counts, including mass failures. CLI/MCP `status {runId,reports:"failed"}` and the landing
page's Test reports disclosure read detail on demand. Uploader, provider webhook and verdict confirmation coalesce report ingestion; settled replays skip report I/O while unfinished timing and output work remains repairable.

Check status also reads the retained test selection, ordered shard groups and
pool cuts on demand. New Actions plans pin the exact timing snapshot used to
balance their shards. The snapshot stays in R2 until check-log expiry. The run's
selection and recipe remain available.

Landing status, observation, waits and compact receipts carry the bound check
run ID. Status and observation use that ID to read the exact CI duration of a
named test file from its retained report.
