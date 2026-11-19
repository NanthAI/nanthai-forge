## Exact conflicts at save

Every hosted save (including `land --save`, a sync and a resolve) that moves an open Lane's head
trial-merges the files it shares: against main when main changed one of its saved files after the
Lane's base, and against the latest saved head of every other open Lane that saved the same file.
The merge is composition's own: the per-file rule, `mergeNativeText` and the compose syntax gate,
so a notice and a real compose agree (two independent insertions at one place merge, as on land).
Only a real conflict is reported, to both Lanes, as `conflictNotice` on their next start, save,
status, board, peers or land response, or a running landing-operation, source-operation, peer or run wait: each item names the file, the line ranges in your file and in theirs, the
reason, and the other Lane's goal (member-written data, quoted, at most 160 characters) or `main`.
`next` says what to do: sync for a main conflict; for a Lane conflict, agree an order or split with
that Lane (a board note) or change your edit, then save. There is nothing to acknowledge. A notice
clears when a later save of either Lane no longer conflicts, or when one side lands or is abandoned.
Hidden or automatic snapshots never run it; only Lane-record head moves do.

Save publication does not wait for its advisory trial. When a trial records a new or changed
notice, that same mutation advances the Lane's existing inbox clock. The running wait's existing
subscription delivers the notice as `conflictNotice` and returns `IN_PROGRESS`, reason `message`,
with its original resume command. The existing two-second batching timer applies; exact conflicts
bypass the member-note cooldown. Run waits negotiate `run-board-wait` on their existing
capability read before sending the Lane cursor to the existing check-status subscription.
Source-operation waits negotiate `source-board-wait` for save, sync and compose progress.
Every wait returns the notice at the top level beside its original resume selection. If the same
subscription update also settles the wait, its current exact-conflict notice accompanies that terminal
outcome immediately; completion does not discard it while the batching timer is pending. This also
applies when source progress compacts to a terminal receipt or a chained resolve result. Member notes
keep their batching behavior. Wait replies include `board.cursor` and `board.noticeIds` derived from the existing notice generation and contents; older servers retain content-only dedupe. A new own or peer head therefore wakes once even when its displayed ranges are unchanged.
The CLI remembers the latest 64 conflict identities per Lane separately from the message cursor, so an older two-note page
cannot redeliver the same conflict on every reconnect. Notes already read in another Lane and
messages addressed to another Lane cannot interrupt this wait. Live wait delivery reads only the
directed Lane inbox. Its local wait position is separate from ordinary board delivery: neither a directed-note wake nor a conflict-only wake acknowledges unread project or Issue notes. With server feature `board-lane-after`, ordinary board reads, save advice and first-write hooks send the delivered-directed-note watermark as `laneAfter`. The server applies it only to the Lane inbox before filling the page; project and Issue inboxes retain their ordinary cursor. This reuses the existing indexed reads, so already-delivered Lane notes cannot crowd out an unread project or Issue note. Explicit note/history reads ignore `laneAfter`. Older servers receive no new argument and retain client-side filtering. If a server rollback leaves a cached feature that the validator now rejects, board reads, hooks and overlap/save advice retry once without `laneAfter`; other errors retain their existing handling. Healthy delivery stays one query; this validator-recovery path uses two queries and never repeats a save mutation. After a rollback, each first-write hook keeps using two queries until the next Lane action refreshes the cached capabilities. Project and Issue notes remain on ordinary board reads, so their backlog cannot
hide an unread directed note. A new conflict, a directed unread
note, operation progress or the wait budget remains observable. Retrying the same trial does not wake the Lane twice. A notice generation advances only when its exact source pair, ranges or currently visible early-resolution advice changes. Cleaning up advice hidden by the current policy updates the stored metadata without a new inbox wake. A failed predecessor read preserves stored advice only while both saved heads are unchanged, avoiding remove/restore wakes for the same source pair. A changed head discards advice for the old pair even when the read fails. Recording shares the existing queue/policy context across both notice directions. Board-note
switches do not suppress source conflicts. A trial that dies cannot leave a save unpublished.
Saved-peer conflicts remain advisory: they never hold admission or cancel a landing; main's own
composition still decides. There is no guarantee that the trial finishes before the save or land
reply; a notice recorded later reaches an active wait, or the next Lane action.

A truncated slim presence row includes a fixed 512-character Bloom filter of every saved path, including paths
omitted from its ten-path list. A definitely disjoint peer costs no full overlap-row read; possible
shared paths still trial-merge, and older rows without the filter keep the conservative read until
their ordinary presence refresh. No backfill or extra call is needed.

Cost: a save that shares no file with main's newer changes or another open Lane reads one slim
presence window inside its existing record write and schedules nothing (no added call). A save
that shares files schedules one Convex action that reads the bytes from R2 and one mutation that
records the result (two calls); no file bytes reach Convex. Bounds: 8 peer Lanes, 24 files, 1 MiB
per file, a 16 MiB main manifest; a file past a bound, or one stored only as a recipe, is left out
(no notice) and the landing's composition still decides. Each run logs one `FORGE_TRIAL_MERGE` line
(files, merges, conflicts, bytes, ms). Each notice row keeps when it was flagged, when its Lane
first ran land and when the Lane started, for reading lead time later.
