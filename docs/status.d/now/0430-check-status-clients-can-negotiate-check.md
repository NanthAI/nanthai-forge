Check status clients can negotiate `check-report-detail` for header-only replies. The shared
server action serves exact paged reports from retained inline or paged runs and understands pinned
R2 report objects. New runs use the writer only with the server setting
`FORGE_CHECK_REPORTS_R2=1` (default off). Failure lists are bounded to 8 KiB with
exact counts, including mass failures. CLI/MCP `status {runId,reports:"failed"}` and the landing
page's Test reports disclosure read detail on demand. Uploader, provider webhook and verdict confirmation coalesce report ingestion; settled replays skip report I/O while unfinished timing and output work remains repairable.
