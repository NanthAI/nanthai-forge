Default agent replies have a per-action byte ratchet: compact conflict files, preflight plans and receipts, and one rendering per board list note (explicit note reads keep full bodies). CLI `--detail` and MCP `replyDetail:true` retain full replies; local actor cursors stop project notes repeating across Lanes ([reply budget](../../agents/workflow.md#default-reply-byte-budget)).

A local landing receipt keeps the test count, outcome, elapsed seconds and
reuse status of the preflight run it used. Replaying the landing keeps that
record after another preflight updates the Lane's latest result.

A timed agent rate-limit refusal reports its reset and the original invocation to retry on the CLI and MCP.
