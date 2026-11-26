Antigravity gets the first-write check and the turn-end guard/snapshot. A person runs
`nforge connect antigravity` once; it adds the `forge` and `forge-coordination` MCP servers to
`~/.gemini/config/mcp_config.json` and one `forge-first-write` hook entry (`PostToolUse`,
`PreInvocation`, `Stop`) to `~/.gemini/config/hooks.json`, idempotent, with a private backup and
one undo. The write check runs after each write and its notice reaches the next model call once;
`Stop` fails open and returns `decision: "continue"` on a normal first stop with unfinished Forge
work, running the advisory turn-end snapshot on an allowed normal stop. Every open Lane is also a
coordination session from `start` until land, abandon or supersede, written inside the Lane's
existing presence writes (no added call, nothing at idle). Overlap notices on start, save, status,
the hook reply and MCP replies carry one short coordination line, and the first start on a machine
shows a one-time tip.
