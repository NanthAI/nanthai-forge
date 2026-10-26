# Modal check spike

Exact native State: `293956f23ba8c17f114eecd5711dfa383aca84eeb50ef33ed3716a4b10a15416`. Same cached image, Node 24.19.0, Git 2.47.3, GNU time, Modal SDK 1.6.2. Each shard: 2 CPU/4 GiB, two test workers and two fixture check slots; one extra static container.

All three full checks passed: **1,575 passed, 0 failed, 5 skipped**, covering all 239 files; static checks passed.

Seconds; warm caches; one sample per shard count. Phase groups include SDK/image overhead. Execution includes startup and result collection; pure upload, installation CPU and provider queue time were not isolated.

| Shards | Deps/image | Source/image | Build/image | Tests | Static | Total | Gross USD |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4 | 1.6 | 8.1 | 18.1 | 381.8 | 33.8 | 410.1 | $0.120 |
| 8 | 1.6 | 8.2 | 18.5 | 194.1 | 51.9 | 222.9 | $0.133 |
| 16 | 1.6 | 9.8 | 18.9 | 119.8 | 34.5 | 150.7 | $0.126 |

Exact scoped parity: 121 files, **858 passed, 0 failed, 4 skipped**; Modal 147.6s versus retained local verify 704.1s. Local build and 30 targeted tests passed. Full local suite was not run, per brief.

Observed gross spike usage: **$0.971**, including failed attempts and diagnostics; billing may lag. The owner-set $30 monthly cap could not be independently confirmed through available read-only CLI/API calls.

Resolved blockers: old Git rejected `--no-lazy-fetch`; GNU time was missing; `agent-clean` deadlocked with one check slot; exec-status polling suffered connection/service errors. Existing two-slot configuration and sandbox main-command completion worked. Two Chromium and three legacy compatibility fixtures require external inputs and skip. Live Convex was not verified.

Design: owner-only backend pins Candidate digest, definition, selection and runtime; verifies source hashes; streams numbered progress/logs; reconciles original execution IDs; binds outcomes to the exact digest. Preserve scoped selection and use local execution for secrets or known infrastructure failure. Balance whole files by recorded durations. Sixteen shards was fastest observed.

Spike only: no landing, deployment or push. Integration remains proposed.
