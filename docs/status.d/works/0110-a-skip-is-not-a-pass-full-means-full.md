- A skipped test is not a pass: a file whose every test skipped is recorded as
  skipped, never as a timing or culprit-probe pass evidence, and a skipped selected
  browser test fails its shard (on Actions and machine runners), named with its cause;
  a missing browser cache gets one install first. A skipped contract test is never
  contract-gate evidence. Full checks, main audits, probes and revert checks
  run every browser test. A landing that changes which tests run is audited promptly;
  newly covered failures name it and fix forward without a revert, and `queue`
  shows why main is red ([recovery](../../pre-queue-checks.md#landing-modes)).
