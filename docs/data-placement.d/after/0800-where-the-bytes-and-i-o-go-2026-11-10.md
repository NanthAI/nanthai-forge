## Where the bytes and I/O go (2026-11-10)

The owner's placement yardstick is that Convex serves three jobs: CI and landing
orchestration, the realtime agent message board, and the web app (with a future
iOS app). Immutable, content-addressed, large, or historical data read only on
demand belongs in R2 behind a pointer. This is the rule for future placement;
the candidates below remain review work, not approved migrations or deletions.
Convex queries/mutations cannot fetch R2 bodies themselves; moving a body must
preserve transactional readers or use an action without adding per-item calls.
