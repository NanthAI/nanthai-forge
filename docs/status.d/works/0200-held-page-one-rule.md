Needs me is one page. FYI starts with the first six rows. Show all opens the bounded history and current holds
in place, newest first, six more at a time. The kind filter and Clear all stay in FYI. Current holds remain
visible in the expanded list. Needs you is where the reader decides. One rule says who a hold waits on
(`needs/count.ts`): the sidebar badge, the top bar, the line's held counts, the F, the Needs me headline and the yard
all follow it, and only a landing held for review
says Needs you. A hold never reads "why not reported": a failed end names its reason from its error code, and a hold
whose landing is gone says so and names the next step. A Lane that only shares saved files with another is never
Conflict; Conflict means a landing that ended in a conflict (`lane-state.ts isConflict`).
The Lanes read (`projectHostedLiveLanes:list`, and so `nforge agent lanes`) carries `landing.cause` for an ended landing: what Forge observed (conflict, check-failed, not-run, cancelled, stale-head, rejected), from the record it already reads. The yard and the Who is touching what page use it for Conflict.

Old Held and Loose ends addresses open the corresponding FYI and Loose ends regions. Each FYI and Needs you
card puts its time, status and actions above a full-width title and detail, with the next step on its own line.
