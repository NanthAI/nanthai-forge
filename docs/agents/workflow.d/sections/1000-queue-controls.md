### Queue controls

`nforge queue list` (MCP `forge_queue`, action `list`) lists local finish/check
operations with position, Lane, phase, age and holder. `nforge queue prioritize
OPERATION` moves a waiting operation ahead of other waiters; active non-audit
checks keep their slots. `nforge queue cancel OPERATION` cancels the finish,
kills its check process group including children, and releases check capacity.
Both mutations are safe to repeat. Cancellation does not change accepted source;
start a new finish to try again. Catchable termination signals cancel a finish's
own check. Dead process tickets are reaped during observation/admission; an
orphaned live process group remains visible until it exits or is cancelled.

A new finish for the same Lane heads, dependencies, composed source, check
definition and environment adopts the original live or completed passed/failed run and its Candidate.
A retained passed run may also be adopted across owner restarts and Node patch
changes when its content reuse key matches the current inputs and an explicit
expected environment, if supplied, matches the current owner. Partial test-list
runs are never adopted as full check evidence. Other changed pins require a fresh
check. The original run identity and evidence are retained. Prioritization follows a finish into its short Channel landing wait.
