### Protected-path notice before checks

On a server advertising `protected-path-notice`, CLI and MCP save replies carry
`result.protectedPathNotice` when the captured Lane changes a currently protected
path. It names the changed paths and the configured approver role: the project
owner (a person) for owner-approval paths and check entry files, or a person allowed
to accept for `acceptance.protectedPaths`. The notice also appears on direct
preflight and `land --save`, before inline preflight or the landing check starts.
It appears even when save replies `settling`; later ordinary saves continue to
name a retained protected edit. Reverting that edit removes its notice.

`message`, `paths` (at most 10 and 1,200 total path characters), `more` and `coverage`
remain visible in compact replies. Missing local base-manifest coverage is marked
`unavailable`, never treated as no protected paths. Read `policy` for the full
current lists; acceptance rechecks current policy. This is advance information:
no approval step, default or enforcement changes. The policy and derived check
entries ride on capability discovery's existing project read; notices add no
Convex calls or DB reads/writes and no idle activity. First-local-write monitoring
and consolidating `protectedPaths` with `ownerApprovalPaths` remain owner questions.
