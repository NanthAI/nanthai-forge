### Check report detail

Capable check status readers send `check-report-detail`: the status response carries a bounded
file summary and no `contractReports`. `status {runId,reports:"failed"}` reads failed and flaky
files with retained excerpts through a server action. `reports:true` pages every report;
`reports:{files:[...]}` selects up to 256 named files. Pass the returned `cursor` to continue.
Each reply is at most 256 KiB; storage keys and URLs never leave the server. The action uses the
same project access and public identity mapping as status and reads legacy inline and paged runs.
The landing detail's Test reports disclosure uses this same server action only while open.

New report writers are enabled only by server environment `FORGE_CHECK_REPORTS_R2=1`
(default off), captured on each new run. Install capable readers and runners first.
R2 runs require `check-report-detail`; older clients or runners receive
`CLI_UPGRADE_REQUIRED`. Existing runs keep their legacy protocol. The collector
passes durations in its settling mutation, paging above 768 KiB with replay stamps;
cancelled provider conclusions never feed timings. The report object follows the
existing check-log retention and cleanup. Legacy row removal is tracked by Issue
589601f7-9593-42ee-b89b-01954d438251.

Preparing landings appear in `queue` after admitted entries, with `position:null` and
`waitingOn.kind:"source-preparation"`. They wait for their server source/landing
controller, not another queue entry; dispatch rank is assigned at admission.
`waitingOn.sourceStep` names the source step in progress, and a step whose last
attempt failed adds `waitingOn.sourceFailure:{step,code,stage,attempts,maxAttempts,retryAt}`.
A `wait` on a stalled landing prints the stall, that failure, the original land replay
and, for a Lane far behind main, the sync to run. It shows when the next attempt may
start if the reply includes `retryAt`. Otherwise it reports the retry schedule as unknown.
Replaying the original land request repairs a failed preparation wake under the same
submission and operation identity. A running wake is fenced, never cancelled.
