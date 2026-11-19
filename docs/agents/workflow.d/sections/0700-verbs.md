## Verbs

Agents use three verbs: `start`, `save` and `land`. Reads keep their names (`status`, `tests`, `diff`, `wait`, …). Operator and repair actions run as `nforge x ROOT ACTION` with the same JSON and authority. Every mode lowers to the existing action before its request identity is computed, so receipts, replays and wire names are unchanged.

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
| `cancel`, `revert`, `abandon`, `complete`, `complete-merged`, `abandon-dormant`, `pin`, `install-hooks`, `uninstall-hooks`, `friction-triage`, `set-policy`, `configure-check`, `configure-runner`, `prioritize`, `source-pack` | `nforge x ROOT ACTION` |

Old names keep working for at least one released version and print their new form once on stderr; stdout, JSON and replay identity do not change. Later sections still name the underlying actions (for example `finish`, `checkpoint`) where they describe receipts and wire fields; those are the actions the verbs above run. MCP tools keep their current names and arguments in this release.
