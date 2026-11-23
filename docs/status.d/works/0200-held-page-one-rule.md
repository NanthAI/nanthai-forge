The Needs me › Held, redone or refused page lists every Lane Forge holds now, whether it waits on the reader
(decided on Needs me) or on its agent, and everything it redid or refused, newest first, with the same filter and
Clear all as FYI. One rule says who a hold waits on (`needs/count.ts`): the sidebar badge, the top bar, the line's
held counts, the F, the Now headline, the Held page and the yard all follow it, and only a landing held for review
says Needs you. A hold never reads "why not reported": a failed end names its reason from its error code, and a hold
whose landing is gone says so and names the next step. A Lane that only shares saved files with another is never
Conflict; Conflict means a landing that ended in a conflict (`lane-state.ts isConflict`).
The Lanes read (`projectHostedLiveLanes:list`, and so `nforge agent lanes`) carries `landing.cause` for an ended landing: what Forge observed (conflict, check-failed, not-run, cancelled, stale-head, rejected), from the record it already reads. The yard and the Who is touching what page use it for Conflict.
