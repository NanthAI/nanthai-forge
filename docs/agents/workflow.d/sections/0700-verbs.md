## Verbs

Core verbs are `start`, `save`, `land`, `abandon`, `revert` and `cancel`. Reads keep their names (`status`, `tests`, `diff`, `wait`, …). Operator and repair actions run as `nforge x ROOT ACTION` with the same JSON and authority. Every mode lowers to the existing action before its request identity is computed, so receipts, replays and wire names are unchanged.

| Old name | Use now |
| --- | --- |
| `checkpoint` | `save` |
| `sync` | `save --sync` |
| `compose` | `save --candidate` |
| `run`, `check` | `save --check` |
| `confirm-tests` | `save --contract` |
| `friction`, `decide` | `save --friction`, `save --decision` |
| `open`, `reopen` | `start --open`, `start --reopen` |
| `finish` | `land --save` |
| `finish` with `accept:false` | `land --save --check-only` |
| `withdraw` | `land --withdraw` |
| `landing` | `observe` |
| `whoami` | `status {"whoami":true}` |
| `board-resolve` | `board --resolve` |
| `nforge x ROOT abandon\|revert\|cancel` | `nforge agent ROOT abandon\|revert\|cancel` |
| `undo`, `complete`, `complete-merged`, `abandon-dormant`, `pin`, `install-hooks`, `uninstall-hooks`, `friction-triage`, `set-policy`, `configure-check`, `configure-runner`, `prioritize`, `source-pack`, `snapshots` | `nforge x ROOT ACTION` |

Old CLI names keep working for at least one released version. Successful calls print one hint on stderr and preserve stdout and replay identity. Later sections use underlying names such as `finish` and `checkpoint` for receipts and wire fields. Bare `land` is `land --save` (CLI and MCP); `land --help` prints its help. To continue an existing landing, replay its original request or run the receipt's wait command.
