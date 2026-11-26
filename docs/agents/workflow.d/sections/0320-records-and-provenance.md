`records {collection,parentId?|status?|id?,version?,cursor?}` pages canonical
retained work and pins each immutable version; a page is not a project snapshot.
For a source job, use `records {"collection":"jobs","id":JOB_ID}` with the job ID
from a source operation or the jobs page. Omit `version` for the current record
or supply it to read that retained version. A missing ID or version returns
`NOT_FOUND`. The read checks current project access.

Project members can page the live rows behind landing attempts with
`records {"collection":"landing-attempts"}`. Use `parentId` for one submission
or `id` for one attempt. Rows preserve the recorded base, candidate, check
binding, replacement cause and progress, including unnamed rechecks. An
exact live read also includes the check binding and scrubbed failure explanation.
Use `records {"collection":"retained-landing-attempts"}` to page the compact
index, including relocated rows. Exact reads fall back to that index after relocation. A submission's
attempt history retains the richer archived evidence. Follow `nextCursor`
with the same selection. Each page uses one project-indexed read of up to
16 rows with a 48 KiB read target and no writes.

`provenance {candidateId,file?,lines?,cursor?}` reads one changed file and up to
20 Lane history versions, including syncs. Continue the returned cursor with the
same selection. Partial history/dependencies mark line attribution partial;
requester accounts do not establish an unrecorded executor identity. Both readers
reuse current project authority, including after cached source reads, with no
writes, wakes or idle observers. Provenance uses at most three metadata queries
plus batch R2 descriptor/download pages; source bytes stay in R2.
