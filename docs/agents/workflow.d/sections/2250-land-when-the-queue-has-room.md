### Land when the queue has room

`land {"maxChecks":N}` (MCP `forge_task` land, same field) submits only while the project's
queue holds fewer than N checks, so at most N run or wait once it joins. The server judges it inside the submitting mutation,
so a queue read and a submit can no longer race past a check cap the project or its lead set:
two submits that both saw room conflict, and the one Convex re-runs counts the other.

Checks counted: the queue's service groups (a batch is one check), held entries left out, plus
landings still preparing their source. Without room the server refuses with `WORK_BUSY` and
writes nothing; the land then subscribes to the queue's room count and submits again when it
drops under N. The server re-runs that live query when the queue's order, phases or holds change
or a preparing landing changes, plus the queue row's progress clock once the queue spans 8
or more pages (never on a timer), so a waiting land wakes when a check ends,
with no polling loop and no idle calls. Past its wait budget the land refuses with `WORK_BUSY`
and names the replay: the same land command with the same `operationId` keeps waiting (and
keeps its maxChecks). Nothing was submitted, so landing with another maxChecks, without it, or
on new saved source is new work, never a replay of the refused one. A cancel (Ctrl-C, SIGTERM,
an MCP cancel) stops the wait with `CANCELLED`, closes the live query and submits nothing.
A replay of an admitted landing is never judged again. `maxChecks` with `accept:false` (a
check-only run, which never queues) is refused.

The server switch `FORGE_QUEUE_LAND_WHEN_ROOM=1` turns it on (off by default, a queue-path
guard); with it off, or on a server without the `land-when-room` feature, a land naming
`maxChecks` is refused before the landing is submitted (a `land --save` still saves first). Lands without the field are
unchanged either way. Cost per judged submit: up to 8 queue directory pages (compact keys) and
at most N preparing rows read, plus the queue row when the queue spans 8 or more pages; nothing
written.
