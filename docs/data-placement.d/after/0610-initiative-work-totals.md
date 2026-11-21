Initiative Work reads one project-owned summary and at most 201 active Lane heads,
plus one Intent head and one Item root per distinct selected Intent and Item. It
checks applied lifecycle changes for the selected Initiative's unpinned Lanes. The
view uses one Convex query and makes zero idle calls. Its history and file membership
rows stay in Convex as indexed metadata. Source bytes stay in R2.

Acceptance completion schedules one fold per receipt with Item links. The fold
resolves their current Initiative roots, stores one receipt marker and the distinct
paths from its retained Candidate, then updates the summary. A fold transaction
handles at most 500 paths and schedules the next page only if needed. A failed
fold runs independently of the completed acceptance and can be repaired by a
rebuild. An Issue move, archive, deletion or restore rebuilds affected Initiatives
from retained notes and older Lane stamps. That scan also repairs missing reverse
Intent links where the Item's recorded chain proves the link. Replacing the selected
Work partition schedules reconciliation of the existing summaries. They remain
project-owned and carry the partition against which their counts were computed.

To backfill or rebuild one Initiative on the selected deployment, run
`npx convex run projectInitiativeWorkRebuild:backfill '{"projectId":"PROJECT_ID","initiativeId":"INITIATIVE_UUID"}'`.
The command returns the scheduled rebuild ID. Rebuilds advance in bounded
mutations and replace stale totals when their scan completes.
