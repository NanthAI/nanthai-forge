Hosted source-worker diagnostics retain typed dependency/runtime failures, the
failing source step and call, and digest/size context when known. Source results
and failure records include per-phase times and actual R2 request attempts.
Slow failures name the longest phase from the same measurements. The landing
check verifies that deployed function dependencies resolve from isolated bundles;
source import reconciliation includes its parser in the bundle.
Compose logs record why the job ran and whether it used the small V8 worker
or the full Node worker, so the spend ledger can attribute calls, compute and egress.
