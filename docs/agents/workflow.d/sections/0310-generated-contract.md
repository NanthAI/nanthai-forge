<!-- hosted-agent-contract:start -->
| Hosted command | Accepted parameters (`?` = optional, `*` = required for a new agent session unless `FORGE_AGENT_MODEL` supplies it) |
| --- | --- |
| `pull` | `operationId?` |
| `save --friction` | `laneId?, title, detail, area, cost?, workaround?, evidence?, operationId?` |
| `friction-list` | `id?, status?, area?, laneId?, search?, limit?, cursor?` |
| `x friction-triage` | `frictionIds, status, reason?, laneId?, planningItemId?, id?, itemId?, operationId?` |
| `save --decision` | `conversation?, target, decidedBy, what, why, decidedAt?, overrides?, supersedes?, delegation?, actor?, tool?, operationId?` |
| `decisions` | `target?, cursor?, operationId?` |
| `tests` | `candidateId, runId?, timingBasis?, tests?, expectedHead?, expectedVersion?, operationId?` |
| `save --contract` | `candidateId, runId?, timingBasis?, tests?, expectedHead?, expectedVersion?, operationId?` |
| `start` | `model*, outcome?, constraints?, intentId?, initialHead?, stackOn?, stackEntry?, planningItemId?, id?, itemId?, scope?, path?, open?, installScripts?, operationId?` |
| `start --open` | `laneId, takeover?, acceptHandoff?, reason?, handoff?, expected?, paths?, operationId?` |
| `save` | `laneId?, message?, model?, supersedeFinish?, park?, notVerified?, operationId?` |
| `save --candidate` | `laneId?, message?, intentId?, inputs?, dependencies?, operationId?` |
| `save --sync` | `laneId?, message?, candidateId?, target?, ontoMain?, stackOn?, predecessor?, apply?, cleanOnly?, operationId?` |
| `recover-apply` | `applyOperationId, operationId?` |
| `resolve` | `laneId?, message?, keep?, operationId?` |
| `save --check` | `checkId, expectedDefinition?, expectedConfiguration?, expectedEnvironment?, candidateId, expectedHead?, operationId?` |
| `land --save` | `model?, laneId?, message?, intentId?, inputs?, dependencies?, check?, candidateId?, composeOperationId?, after?, accept?, notVerified?, keepOpen?, closes?, priority?, tokens?, allowEmpty?, maxChecks?, retry?, reason?, operationId?` |
| `x prioritize` | `submissionId, priority, asOwner?, operationId?` |
| `preflight` | `laneId?, run?, budgetSeconds?, trim?, retry?, message?, operationId?` |
| `x source-pack` | `operationId?` |
| `x snapshots` | `laneId?, undo?, redo?, restore?, paths?, purge?, operationId?` |
| `x undo` | `laneId?, saveId?, version?, apply?, operationId?` |
| `cancel` | `submissionId, operationId?` |
| `land --withdraw` | `laneId?, submissionId?, reason?, operationId?` |
| `revert` | `message?, target, operationId?` |
| `abandon` | `laneId?, reason, authorityEpoch?, intents?, saveFirst?, keepPatch?, target?, operationId?` |
| `x complete` | `laneId?, operationId?` |
| `x pin` | `laneId?, pinned?, operationId?` |
| `x complete-merged` | `operationId?` |
| `x abandon-dormant` | `apply?, limit?, operationId?` |
| `start --reopen` | `laneId?, target?, operationId?` |
| `status` | `laneId?, whoami?, kind?, operationId?, submissionId?, runId?, version?, summary?, reports?, cursor?, main?, files?` |
| `observe` | `kind?, operationId?, submissionId?, runId?, version?` |
| `metrics` | `from?, to?, limit?, cursor?, contextDays?, operationId?` |
| `capabilities` | `operationId?` |
| `x configure-check` | `name?, checkId?, command?, expected?, operationId?` |
| `x configure-runner` | `provider?, runsOn?, concurrencyBudget?, publicLogs?, submodules?, isolation?, machineId?, labels?, repository?, configuration?, expected?, mainAudit?, operationId?` |
| `check-settings` | `operationId?` |
| `policy` | `operationId?` |
| `approve-link` | `operationId?` |
| `request-approval` | `laneId?, reason?, withdraw?, operationId?` |
| `x set-policy` | `governanceVersion?, dryRun?, expectedPolicy?, preset?, acceptance?, checks?, integrationPreview?, ownerRootUpdates?, accessIdentities?, mainAudit?, autoSnapshot?, autoSnapshotIntervalMinutes?, checkLogs?, laneUpdates?, lifecycle?, notify?, githubMirror?, trust?, agentDefaults?, autoExchange?, operationId?` |
| `planning` | `planningItemId?, id?, itemId?, transfer?, search?, kind?, status?, initiativeId?, waitingOn?, type?, owner?, relation?, counts?, history?, limit?, cursor?, reconcile?, schedule?, operationId?` |
| `put-planning-item` | `expectedVersion?, kind?, title?, body?, status?, reason?, intentIds?, initiativeId?, planningItemId?, id?, itemId?, fields?, batch?, operationId?` |
| `comment-planning-item` | `itemId?, authorLabel?, text, replyTo?, decision?, planningItemId?, id?, operationId?` |
| `provenance` | `candidateId, file?, lines?, cursor?` |
| `records` | `collection, parentId?, status?, id?, version?, cursor?` |
| `log` | `runId, tail?, stream?, shard?, attempt?, laneId?` |
| `lanes` | `planningItemId?, id?, itemId?, intentId?, state?, cursor?, limit?, intents?, view?` |
| `diff` | `laneId?, paths?, byteBudget?, summary?, from?, cursor?` |
| `peers` | `laneId?, path?, detail?` |
| `queue` | `limit?, laneId?, submissionId?, beforeAttempt?, attemptId?, afterLaneId?, batchId?` |
| `landings` | `from?, to?, receiptId?, message?, submissionId?, limit?, kind?, cursor?` |
| `lane-history` | `laneId?` |
| `flow` | `{}` |
| `wait` | `runId?, operationIds?, cursor?, until?, timeoutSeconds?, peer?, approval?` |
| `show` | `laneId?, state?, candidateId?, expected?, channel?, at?, path, force?` |
| `board` | `id?, laneId?, all?` |
| `board --resolve` | `id, text?` |
| `ask` | `operationId?, to, text, choices, laneId?, planningItemId?, holdsWork?` |
| `hand-back` | `operationId?, to, laneId?, head, tried, left` |
| `history` | `action?, op?, commit?, path?, limit?, skip?, cursor?, start?, end?, bytes?, force?, laneId?` |
<!-- hosted-agent-contract:end -->
