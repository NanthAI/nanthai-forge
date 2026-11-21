### Hosted reads and coordination limits

MCP `forge_review` exposes hosted `show`, `diff`, `peers` and `queue`.

- `queue {}` counts distinct Candidates after the first in each listed landing.
  Like its landing receipt, it counts each attempt beyond the first eight as a
  possible recompose. Rebinding a check for a Candidate in the observed history
  does not add a recompose.
- `queue {"submissionId":"SUBMISSION_ID"}` shows why one landing is still in flight.
  Copy the submission ID from the queue or landing reply. The page shows the current
  source reservation, if any, and up to eight installed attempts newest first.
  A reservation's ID stays fixed if another attempt takes its ordinal before install.
  Each attempt shows its retained phase, timed intervals and cause, with check and
  Candidate IDs when available. Open intervals report elapsed milliseconds as of
  `observedAt`. The current source step includes its last retained failure and
  timings. A failed reservation keeps its terminal cause. Phase intervals require
  timestamps attributable to that attempt, so inherited or missing clocks are
  omitted. The read flags gaps it finds in live history as partial.
  For older attempts, pass `nextBeforeAttempt` as `beforeAttempt` with the same
  submission ID. Each page is one authorized read with no source download or writes.
  The history also names the submission's current and origin batch IDs when recorded.
- `queue {batchId}` returns that retained batch's phase, parent, run and member
  submission and Candidate pins. Use the current or origin ID to inspect that batch
  directly, including after a split or supersession.
- `queue {submissionId,attemptId,afterLaneId?}` returns the exact installed
  attempt's main and Candidate pins, both selection roots, and up to 32 indexed
  Lane inputs in ID order. Continue with `nextAfterLaneId` using the same submission
  and attempt. A retained compose gives Lane and dependency counts. A null
  selection means those counts and Lane records are unavailable. A null Lane list
  means the records for a nonempty selection were unavailable at its start.
  A null head means the selected Lane's saved head was never indexed. A zero Lane
  count with an empty list is a recorded empty input set, as for a shared Candidate
  composed entirely from dependencies. Compare the total Lane rows with the count
  to identify incomplete history. The selector uses transactional attempt pins,
  including the terminal attempt retained for a capsule. Earlier capsule-only
  attempts and unavailable batch IDs return `NOT_FOUND`.
  Both selectors use one authorized query per reply, without source downloads or writes.

- `peers {laneId,path?,detail?}` reads saved peer evidence in one query,
  including paths before their first save, as `peerEvidence`. Detail shows 50 items
  instead of five. Count/coverage disclose omissions; unsaved edits remain
  unavailable and missing notices never prove independence.
- `diff {laneId,paths?,byteBudget?,cursor?}` pins base/saved-head R2 States.
  Defaults: 48,000 hunk payload bytes plus path metadata, 50 paths/page. A small
  hunk can fit even when both file versions exceed the reply budget. The source
  read keeps the ordinary small-file window and allows larger comparisons up to
  1 MiB per version and 2 MiB per page. `cost.sourceBytes` reports the source
  verified for the page, including batched cold downloads. Continue
  `result.nextCursor` with the same Lane/paths, retaining the pair after saves.
  A page that is not the last says so in `more` (the paths shown, the total) and
  carries the next-page `command` and `next`.
  A file whose hunks do not fit the remaining page can continue on the next
  pinned page. A file that cannot fit on a fresh page reports
  `truncated` and its `requiredByteBudget` for the context-free hunks.
  `omitted` reports files beyond the text comparison bound with their source
  size. Use exact show for the omitted bytes. `from` compares an
  older saved State with the saved head instead of the pinned base: a full State id
  or a unique 8+ character prefix of the Lane's base or saved States (an ambiguous
  prefix is refused with `AMBIGUOUS_ID`). `summary:true`
  answers "are this Lane's saved changes already on main": per changed path its
  `status` (added|deleted|modified) and `main` (`equal`: main holds the saved
  bytes and mode, or the Lane deleted a path main lacks; `absent`: main has no
  such path; `different`: both have it and differ, or main still has a path the
  Lane deleted), plus whole-set `counts`. Each path also has the reading order
  the web Lane page uses: `group` (`eyes` for a conflict or a protected path only,
  `code`, `tests` or `low`) and `reason`, an
  observed fact (`new file`, `test changed`, `docs only`, `now executable`, …;
  never a score), with whole-set `groups` counts. No hunks, no blob reads: it reads the
  base, saved-head and current-main State manifests (`cost.manifestBytes`) and
  pages by the same `nextCursor` (up to 500 paths or `byteBudget` bytes a page).
- `lane-history {laneId?}` is one query from stored rows for an open, landed or
  abandoned Lane: `openedAt`, `startBase` (the main it started from),
  `lastSyncedBase` (the main its base is now), `synced`, `state`, `head`,
  `lastActivityAt` and `landing {receiptId,commit,head,at,current,revertedBy?,mainRedHolds?}` (null
  when nothing landed or the Lane landed before the landing stamp). `mainRedHolds` lists each
  main-red hold the landing waited under before it landed (`kind` `parked` or `publication`,
  `heldAt`, `releasedAt`), the same list as its receipt and its `landings` row. Once a
  compensating landing takes that landing off main, `current` is false and
  `revertedBy {receiptId,at}` names the revert. No writes. The Lane's save history
  is `records {"collection":"saves","parentId":LANE_ID}`: each save with its full
  saved State id (`head`) and time (`at`), oldest first, 100 per page (one small
  body read per save).
- `revert {target}` prepares a compensating Lane. Its checked landing (`land --save`, the
  browser, or main-audit recovery) records `revertOf` on the landing (shown as
  compensating, with "Reverted by" on the original). When it lands, each Lane of the
  reverted receipt gets one board note with its reopen command
  (`start --reopen '{"laneId":"…"}'`; its saved head is kept), and the reverted
  Intent gets a `reverted` needsFix notice in Now and CLI status (reopened if it
  had completed; an abandoned Intent stays closed). Re-landing that Intent clears
  the notice. Only compensating landings pay this, once per revert.
- `show` selects one exact `{laneId,path}`, `{channel:"main",path}`, `{state,path}`
  or `{candidateId,path}`. `at:"base"` reads the file at this Lane's pinned base (the
  main it started from; use it instead of the project clone to compare with what
  other landings changed) and `at:"main"` is `channel:"main"`. `expected` binds Lane versions. Missing source fails
  without substitution. All source reads exclude drafts and recheck access on
  cache hits.
- `help` and `history --help` expose log, blame and show; MCP `forge_review` accepts
  `action:"history"` with read-only `op:"status"|"log"|"blame"|"show"`. A file filter
  belongs on history, not the UTC-window `landings` ledger. One landing's receipt (checks, costs, agent, acceptance) is `landings {"receiptId":"…"}` with the full id or a unique 8+ character prefix and no window; an ambiguous prefix is refused with `AMBIGUOUS_ID`.
  Add `message:true` to select the stored receipt message and any ordered cohort messages.
  `landings {"submissionId":"…"}` gives project members the stored request and top-level
  messages and the cohort hold evidence. Each selected message reply uses one authorized query.
- `history {op,commit?,path?}` reads the Git history of a project imported from
  GitHub, so log, blame and old versions match GitHub. `op:"log"`
  (`limit` ≤1000, default 50, `skip`, optional `path`), `op:"blame"` (`path`,
  optional `start`/`end` lines; ranges of final lines per commit with author and
  summary), `op:"show"` (exact bytes at `commit` on stdout; binary or over 1 MiB
  needs `force:true`) and `op:"status"`. `commit` is a hex id or unique prefix;
  default `head` is the newest stored main commit: main's latest GitHub-mirrored
  commit when the mirror publishes to the imported repository, else the import
  commit (`headState` names its State when known). Each read is one server action
  that rechecks access; when main's mirror moved past stored history it first adds
  one catch-up pack (coalesced: any number of landings cost one pack). One read per project
  holds a two-minute lease on that fetch; a concurrent or later read inside the lease serves the
  stored packs and reports `HISTORY_CATCH_UP_RUNNING`, so readers never multiply GitHub fetches. Log pages normally return commit metadata only (`readMode:"metadata"`, `downloadedBytes:0`). On the first read of a pack the server reads its existing metadata index when available, otherwise its R2 chunks, and returns a compressed commit/tree index; the client keeps it in the project/deployment-scoped history cache and verifies its hash before reuse. Different pages and paths reuse that index after the same current-access check, with no R2 read of cached metadata. No file-body pack or download link is sent on this path. The server uses the existing 128 MiB scanner working budget plus a chunk/inflate buffer; the inline metadata reply is bounded at 2 MiB compressed, and the local metadata reader falls back before exceeding its working budget. Existing full Git caches and larger or unsupported layouts keep the explicit `readMode:"pack-cache"` path and its reason, preserving existing reads. A fully pack-free promise for every layout is not yet established. Blame, show and this explicit large-history fallback use packs that
  download once per machine into `~/.cache/forge/history` (`FORGE_HISTORY_CACHE`)
  and the local `git` reads them (`GIT_REQUIRED` without Git). Metadata-only logs need no local Git. Deploy the optional log reader before adopting its CLI. An older strict server uses an explicitly reported legacy pack-cache read after refusing the optional selection (two client actions on that compatibility path). Imported projects without a mirror can also expose Forge-built main commits once a plain Git listing has built them ([Git serving](../../../git-serving.md#main-landings-without-a-mirror)). A mirrored project without
  imported history gets it from the mirror on its first plain `git clone` from Forge
  ([Git serving](../../../git-serving.md)). Owners set the
  per-project limit with `op:"limit"` (`bytes`, default 1 GiB, at most 8 GiB) and
  re-run a failed or over-limit import with `op:"retry"`; above the limit no history
  is stored and reads return `HISTORY_OVER_LIMIT`. A project with no stored history
  returns `HISTORY_UNAVAILABLE` with its message (on `status` too), never `INTERNAL_ERROR`.

- Forge has one client mode: hosted. A folder without a hosted marker is refused
  with `FORGE_ROOT_UNAVAILABLE` and the next step `nforge host ROOT`.
- Commands of the removed native mode (`review`, `candidate`/`candidates`,
  `view`/`views`, `brief`, `link`, `handoff`/`handoff-read`,
  `report`, `making-of`, `pending-status`, `improve`, `save --preview`,
  `land --resume-ready`, `x accept`, `x undo-sync`, `x undo-revert`, `x clean`,
  `x take`, `x guidance`, `x pre-edit`, `x define-check`) refuse with
  `HOSTED_ACTION_UNSUPPORTED` and name the hosted command that does the job. The
  [hosted parity table](../../hosted-parity.md) records each migration, fold and removal.

`check-settings` describes project-wide agent eligibility under the current policy.
`agentLandsOnPass:true` means the policy allows agents to land after a passing check;
it does not assess a Candidate's changed paths. Protected paths may still require
approval for that Candidate. Missing check definitions, runners and callbacks stay
in `blockers`; an unknown file list is not a project-wide review blocker.

The top-level `nforge queue` manages local command recovery. Use
`nforge agent ROOT queue '{}'` for hosted landings; a local empty queue says
nothing about the hosted landing queue.
