# Roadmap friction import

`roadmap.json` preserves all seven original Workflow friction bullets as
structured capture requests, including exact detail and source evidence. Two
reports of broad lifecycle validation deliberately share a group. Operation ids
are deterministic, so this one-off import can be replayed without duplicates.

`tests/friction.test.mjs` imports these requests into a disposable local native
owner through `AgentWorkflow.dispatch({action:'friction', ...record})`, imports
them again, and checks all details and occurrence counts survived. No live owner
is backfilled. To import an explicitly selected owner's old list, use the same
requests with `nforge agent ROOT friction` (one JSON request per record).

The source roadmap now points to `nforge improve ROOT`; future reports go to Work
rather than editing that shared section.
