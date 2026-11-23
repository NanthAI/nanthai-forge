Antigravity gets the first-write check. A person runs `nforge connect antigravity` once; it adds the
`forge` and `forge-coordination` MCP servers to `~/.gemini/config/mcp_config.json` and one `forge-first-write` hook entry to
`~/.gemini/config/hooks.json`, idempotent, with a private backup and one undo. The check runs after
each write and its notice reaches the next model call once. Every open Lane is also a coordination
session from `start` until land, abandon or supersede, written inside the Lane's existing presence
writes (no added call, nothing at idle). Overlap notices on start, save, status, the hook reply and MCP
replies carry one short coordination line, and the first start on a machine shows a one-time tip.
