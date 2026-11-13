# Benchmark coordination audit: 2026-11-13

Issue **83e6d0d3-adf8-4390-814c-60b680607098**. Three scored cells, ten tasks each, at concurrency 10, 5 and 3. This is a retrospective audit of the frozen experiment, not a new scored result.

## What reached an agent

Only **one of 30 task executions** received an exact-conflict notice. That agent moved a test before landing and avoided the reported conflict. The backend retained **three recipient notices**: two sides of that peer conflict at concurrency 10, and one main conflict at concurrency 3. The latter never appeared in a recorded agent reply, despite its flag preceding the first landing by two seconds. Flag-to-land lead time therefore does **not** prove delivery.

| Concurrency | Tasks | Exact recipient notices stored | Notices delivered | Tasks that acted on a notice | Forge conflict episodes | GitHub conflict episodes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 10 | 2 | 1 | 1 | 2 | 2 |
| 5 | 10 | 0 | 0 | 0 | 1 | 2 |
| 3 | 10 | 1 | 0 | 0 | 2 | 2 |
| Total | 30 | 3 | 1 | 1 | 5 | 6 |

An episode is a reported composition/merge conflict followed through recovery; a landing conflict and the subsequent sync draft count once. The proactive test move is separate: it is rework after a useful notice, not a failed landing. The existing rework classifier reports 6 Forge rework episodes and 7 GitHub rework episodes, including work outside the conflict-episode definition. Those totals must not be substituted for the 5-versus-6 comparison above.

| Signal | Backend evidence | Delivered to task executions | Observable response |
| --- | --- | --- | --- |
| Exact conflict | 3 retained recipient rows, covering one peer pair and one main conflict | 1 reply, 1 task | t27456 at concurrency 10 moved its test; both peer rows cleared on the next save |
| queueAhead / queueAheadUnavailable | Hosted finite reads did not compute this advice | 0 / 0 | No queue-ahead continuation was available to follow |
| behindMain | 22 positive reply observations, across 12 task executions | 22 replies | 4 observations on 3 task executions named own-file drift; no proactive manual sync attributable to this signal |
| behindMain nudge | Threshold is distinct accepted landings touching saved work, not all intervening commits | 0 | No nudge-driven action observed |
| Board notes | No project/Lane-targeted note was posted during any cell; no task issued a board command | 0 | The board was unused; this does not test whether agents respond to a delivered note |
| Presence | All recorded task identities collapse to one agent run; retained incident Lane rows agree | 0 | Same-run suppression applies; distinct-agent presence was not fairly exercised |
| peers | No task issued a peers command | 0 | Saved peer evidence was not inspected through this command |
| Stacking offer | 1 offer on t19456's concurrency-10 status reply | 1 | No stackOn command followed; the agent later synced main after a terminal conflict |
| Conflict recovery | 5 terminal conflict continuations plus their 5 sync drafts | 5 episodes, 4 task executions | Every episode was followed by sync, edits, resolve and resubmission |

Presence identity is a material confounder: all 30 executions expose the same display identity despite separate provider sessions in the transcripts. The current presence rule deliberately hides another Lane with the same account and agent run. This audit establishes the repeated identity and the suppression rule; it does not claim which inherited session setting caused the identity. That requires harness qualification before a replacement experiment.

The stacking offer arrived on a concurrent status read while t19456's first submit was still returning. The status offered a peer head; the task did not use it. This is one observation, not evidence that stacking itself saves or wastes time.

## Every task, paired with GitHub

`Exact` counts returned exact-conflict notices. `Behind` counts positive behindMain replies, including repeated observations. Queue advice, board delivery, presence, peers calls and nudges are zero for every row. `Stack` is returned offers. Conflict recovery was followed for each nonzero Forge episode.

| Concurrency | Task | Exact | Behind | Stack | Forge episodes | GitHub episodes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10 | t26563 | 0 | 0 | 0 | 0 | 0 |
| 10 | t26770 | 0 | 0 | 0 | 0 | 0 |
| 10 | t27069 | 0 | 0 | 0 | 0 | 0 |
| 10 | t27456 | 1 | 2 | 0 | 0 | 0 |
| 10 | t22302 | 0 | 0 | 0 | 0 | 0 |
| 10 | t19456 | 0 | 2 | 1 | 2 | 1 |
| 10 | t23938 | 0 | 0 | 0 | 0 | 1 |
| 10 | t23766 | 0 | 0 | 0 | 0 | 0 |
| 10 | t27514 | 0 | 0 | 0 | 0 | 0 |
| 10 | t27521 | 0 | 0 | 0 | 0 | 0 |
| 5 | t26563 | 0 | 0 | 0 | 0 | 0 |
| 5 | t27069 | 0 | 0 | 0 | 0 | 0 |
| 5 | t26770 | 0 | 0 | 0 | 0 | 0 |
| 5 | t19456 | 0 | 2 | 0 | 0 | 0 |
| 5 | t22302 | 0 | 2 | 0 | 0 | 0 |
| 5 | t27456 | 0 | 0 | 0 | 0 | 1 |
| 5 | t23766 | 0 | 1 | 0 | 0 | 0 |
| 5 | t23938 | 0 | 3 | 0 | 1 | 1 |
| 5 | t27514 | 0 | 2 | 0 | 0 | 0 |
| 5 | t27521 | 0 | 0 | 0 | 0 | 0 |
| 3 | t27514 | 0 | 0 | 0 | 0 | 0 |
| 3 | t27521 | 0 | 0 | 0 | 0 | 0 |
| 3 | t22302 | 0 | 0 | 0 | 0 | 0 |
| 3 | t27456 | 0 | 2 | 0 | 1 | 0 |
| 3 | t19456 | 0 | 2 | 0 | 1 | 1 |
| 3 | t27069 | 0 | 0 | 0 | 0 | 0 |
| 3 | t26770 | 0 | 1 | 0 | 0 | 0 |
| 3 | t23938 | 0 | 2 | 0 | 0 | 0 |
| 3 | t23766 | 0 | 0 | 0 | 0 | 1 |
| 3 | t26563 | 0 | 1 | 0 | 0 | 0 |

## Exact t19456 replay

All times below are UTC. A save's `at` is its retained operation clock, not proof of the physical commit completion time. Client call intervals, immutable Lane versions, saved source hashes, resolution pins and acceptance receipts were joined by operation identity. Eight saved States were rebuilt byte-for-byte and verified against their original SHA-256 identities. Original repository bytes remain private; committed guards use synthetic byte equivalents of the same failure shapes.

The five original Lanes all began on State `b182082fa0f8`. None of the four peers issued sync or resolve. Their initial land calls were t22302 02:57:42.482–02:58:12.821, t23766 02:57:52.063–02:58:14.143, t27514 02:58:03.384–02:58:35.000 and t27456 03:00:12.559–03:00:36.960. t27456's explicit first save returned pending at 02:59:33.278 and its later save wait completed at 02:59:45.353.

Saved source pins:

| Task | Lane | Save operation | Saved head | Save clock |
| --- | --- | --- | --- | --- |
| t22302 | 752fc749-850d-41f1-ba96-feee0449f9db | b207596f-e0f1-4494-9384-b35d382b03b7 | 85bec05a97e3 | 02:57:46.938 |
| t23766 | 7690a42e-045e-47db-8f02-6bc87e0d31f9 | 068a11e2-860d-4155-a223-15e72b503ea0 | c770a6f943bd | 02:57:56.532 |
| t27514 | a268d0c7-fd7e-486c-882f-c9f6e142cca2 | 9e6122cc-bb4b-4ed5-9cdc-4b46f72cfb03 | f7e25b9af53a | 02:58:08.318 |
| t27456 | 40bd9793-480e-49cc-966c-ac0d4faa0738 | 54a9cc43-7acc-48cd-a7f7-acb3f4795524 | 134724841669 | 02:59:31.070 |
| t27456 after its notice | same Lane | 09553f48-8243-466c-8e38-bfd2cc4b364b | 4ad40481282d | 03:00:16.866 |
| t19456 | 8836f86c-3c7b-464d-bf13-6837d68dafe7 | 9a639781-991a-4e3f-ba3c-be7e06ebbaa1 | 684b3b4121f7 | 03:03:46.524 |

The actual conflicting edits are t22302 and t27456 against t19456's preview tests. t23766 changed the codex client and t27514 changed the Pi provider. Their receipts refer to cumulative accepted States containing other tasks' preview edits; they are not themselves preview-editing peers.

| Time | Exact event |
| --- | --- |
| 02:59:42.674 | The trial of t27456's first save flagged both sides against t22302. |
| 02:59:47.315 | t27456's transcript received the notice for save 54a9cc43. It subsequently moved the added test. |
| 03:02:17.501 | t22302 landing 7193b7a8-e499-41b1-94ee-a560c7f78abf accepted receipt d42a343c-cb1a-4eef-a1a4-a826ed84e992, State 64a2d248b8da. |
| 03:02:49.405 | t23766 landing 0eaaf2a3-7ddd-4935-a66e-96933eb2fc4e accepted receipt 9d2d6168-8f31-4264-a046-77db4e4e5eb4, State 5504dcad6b6a, containing t22302's preview changes. |
| 03:03:41.615–03:04:06.031 | t19456's first land --save, d5ec5db0-3c2d-458f-8c3c-c5dbfc6af569. The reply named six intervening main commits and own-file drift, but no exact conflict. |
| 03:04:43.292 | The wait call ended with COMPOSITION_CONFLICT. Its transcript output was recorded at 03:04:47.115. |
| 03:04:53.631–03:05:35.389 | Sync da814b66-cada-40c7-9d0b-49a40de71743 opened resolution Lane 534610a5-1a88-4859-9000-53cc741143a4 from exact main 5504dcad6b6a and origin 684b3b4121f7. |
| 03:05:53.964–03:06:22.260 | Resolve c3ace6c7-bcb9-4cd1-90a2-0edf6469609b saved e7e1be3c8394 through save 034aefbd-8a6e-410c-a58d-8da4851a8a80, then produced resolved head 8ebefd968118. |
| 03:06:27.707–03:06:43.346 | Second land --save, 968bc6c1-ae93-44b3-8a18-f37cf8749b59. Again no exact-conflict notice. |
| 03:07:32.474 | t27456 and t27514 accepted in one batch, receipts 3f2d7257-7066-481c-b33a-5b39f44f1ecb and 7e0843e9-4f0b-491c-8359-33f2cd765a04, State 6556186f99d8. |
| 03:10:13.722 | Second wait ended with COMPOSITION_CONFLICT: 203.614 seconds after the wait began, 226.015 seconds after land --save began, and 161.248 seconds after the predecessor batch accepted. These are distinct timing denominators. |
| 03:10:24.580–03:11:19.309 | Sync 1092a243-dd67-43ab-9a2b-4438b534a3ad opened resolution Lane 86833be3-2d19-4b26-8649-0fa85377795c on main 6556186f99d8. |
| 03:11:37.750–03:12:06.308 | Resolve 929724ef-11cb-403c-b3d4-63620a9b9bac saved 11e3e70e52ae through save 3af2f27d-0035-4d26-a8df-633b03fb20dd, then produced resolved head 7473a9f3e490. |
| 03:12:10.840–03:12:26.309 | Third land --save, c775befa-1b76-4aaa-a36f-ce3c2d30d054. No remaining conflict was expected after the second resolution. |
| 03:15:21.822 | Accepted receipt 11ce3b08-c1ac-471b-84da-abeda77872cc at State 7473a9f3e490. |

### Why each save-time signal missed

1. **First save, 9a639781.** Both conflicting files were raw packed objects below 1 MiB; the State manifest was below 16 MiB, with fewer than eight peers and 24 selected files. The planner selected the relevant main paths. The action then tried the logical main blob digest as a standalone raw-object key. That is not the packed object's physical binding. A missing main blob made the trial leave the entire file unavailable, also preventing its subsequent peer comparison. Replaying the actual bytes finds the main test conflict (own lines 528–745 versus main 511–556) and the pending t27456 fixture conflict (60 versus 60–61). This is a byte-read/physical-binding failure, not a recipe exclusion or path/peer bound.
2. **Resolution save, 034aefbd.** Its overlap projection retained the save delta's marker draft as `before`, although the Lane's real base was main 5504dcad6b6a. The trial's older-peer check therefore treated the peer as conflicting with the draft and skipped it. The actual t27456 conflict is found when the exact pinned base replaces the marker draft (own 60 versus peer 60–61). Resolution scope also retained only the marker-file delta instead of all inherited origin work. The next unchanged land --save did not replan because the saved head had not moved. The miss was not caused by the unrelated t27514 task.
3. **Final resolution save, 3af2f27d.** Main already contained the relevant predecessor work, the markers had been resolved, and no original peer remained open. Absence of an exact notice here is expected. The final composition accepted those resolved bytes.

There is also an independent delivery race: save completion and the overlap read can precede the scheduled trial's record mutation. The concurrency-3 t27456 notice was stored but did not reach an agent reply. This evidence proves delivery loss, but the retained records do not preserve every historical server request ID or the exact earlier overlap-query read clock. Backend logs available during this audit had already rolled past the experiment. Operation IDs above are exact retained identities; missing server request IDs are not invented.

## Evidence and coverage

The audit joins the three cells' result records, instrumented command records, provider transcripts, client save journals, retained Lane versions, saved-object metadata and exact-conflict summaries. It counts 97 distinct structured replies from task transcripts; command-help calls and tool transport chunks are not replies. Server flag counts come from complete exact-conflict summaries, not from absence of CLI text. Project/Lane board-note counts were checked with bounded read-only indexed queries. Issue-targeted board notes were not independently enumerated; no task board action or delivered notice exists in the recordings.

All five terminal Forge conflict episodes have observable recovery actions. No recorded board or peers action exists. The retrospective cannot observe an agent's unspoken reasoning or reconstruct every discarded finite read, so it does not label every delivered drift warning a behaviour change, or every absent presence line a server failure.

The project-attributed per-function meter does not list the trial action, its record mutation or its main-State lookup, even though retained notice rows prove trial work occurred. Missing function entries must not be priced as zero; the recorded cell totals cannot establish a per-trial billed-cost delta.

The frozen source/runtime pins did not move during these cells. Any replacement experiment must qualify independent agent identities, save-time notice delivery and the cost budget on its new accepted pins. The retrospective results above remain unchanged by subsequent fixes.

## Repair boundary

The repair reads packed main bytes through verified physical bindings, derives trial sides from pinned
source States, and preserves all origin paths when a resolution starts. Save publication remains
independent of the advisory trial. A new or changed notice advances the Lane's existing inbox in the
trial's existing result mutation; the existing wait subscription returns it without polling or an
admission fence. Synthetic guards cover the two replay shapes, reactive wait delivery, duplicate
records and a trial dying before its result. Deployed delivery, request IDs and billed cost require
separate qualification; the original experiment's missing notices remain historical misses.
