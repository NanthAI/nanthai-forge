Needs me is one page. FYI starts with the first six rows. Show all opens the bounded history and current FYI rows
in place, newest first, six more at a time. The kind filter and Clear all stay in FYI. One rule
(`needs/count.ts`) supplies Needs you, the shell badges, the attention cue and the marks for Lanes that wait on
the reader. Needs you lists actions the reader can take. Agent-owned holds, parks for an agent, audit reverts
without a decision for the reader, recent main fixes and recent deploy failures stay in FYI with their facts
and links. A main fix still open an hour after it was
recorded asks the project owner to investigate the Lane when the read identifies it, or open the landing evidence.
Deploy failures use the project's deploy attention window. The shell redraws at the next known deadline using the
same read and clock as the page. Recovery clears the row on the existing update.
A hold never reads "why not reported": a failed end names its reason from its error code, and a hold
whose landing is gone says so and names the next step. A Lane that only shares saved files with another is never
Conflict; Conflict means a landing that ended in a conflict (`lane-state.ts isConflict`).
The Lanes read (`projectHostedLiveLanes:list`, and so `nforge agent lanes`) carries `landing.cause` for an ended landing: what Forge observed (conflict, check-failed, not-run, cancelled, stale-head, rejected), from the record it already reads. The yard and the Who is touching what page use it for Conflict.

Old Held and Loose ends addresses open the corresponding FYI and Loose ends regions. Each FYI and Needs you
card puts its time, status and actions above a full-width title and detail, with the next step on its own line.
