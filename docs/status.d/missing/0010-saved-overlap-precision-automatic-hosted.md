- **Saved overlap precision.** Automatic hosted notices omit disjoint saved edits,
  identical results and resolve-origin/sibling self-overlaps. Shared symbol names
  alone do not block. Exact-base touching ranges and path-operation collisions
  retain blockers; unknown evidence reports incomplete coverage. The deterministic
  B1.5d fixture covers all 66 notices and 22 missed pairs using reconstructed final
  deltas; it does not prove timely delivery during live concurrent edits. Cross-file
  advisory notes (a changed exported symbol that a peer's changed lines use) were
  replayed on a 64-Lane overnight fan-out from final heads (0.036 notes per active Lane
  pair, at most 3 per Lane); live delivery is not yet measured.
- **Contract signal in every language (native).** TS/JS contracts are matched by import; Python, Java and Rust export changes, and any change to code in a language without export facts (contract unknown), hold optimistic landing by package through the manifest package graph, both ways, with the holding Lane named in `view.optimisticHold`. The contracts config lives in the root `forge.json` (`contracts.interfaces`). Hosted cross-file symbol notes remain TS/JS only. See [contract changes](../../agents/workflow.md#contract-changes).
- **First-write hooks.** First-write overlap hooks install on the first successful CLI command for Claude Code and Codex, with user/project off switches and an exact undo command. One Lane-independent hook resolves edited paths; hosted reads reuse the bounded peers query before the first save. Notices are advisory, cache per path/session, fail open within one second and exclude unsaved peer edits. Shell writes are outside coverage; hosted first-write delivery telemetry remains incomplete. See [first-write hooks](../../agents/workflow.md#overlap-before-the-first-write).
