Accepted-main events retire still-running landing checks on shared Candidate
paths or global-risk changes, using the existing CI cancellation adapter and a
replacement wake in the same transaction. Clean replacements check immediately;
conflicts reach the existing wait/status recovery. Unrelated and already-covered
predicted checks retain their run. The pass reads metadata for at most eight
checking entries, with zero extra DB bytes when none are running, and does not
change acceptance proofs ([pre-queue checks](../../pre-queue-checks.md#decision)).
