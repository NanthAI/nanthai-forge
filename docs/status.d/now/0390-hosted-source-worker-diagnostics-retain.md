Hosted source-worker diagnostics retain typed dependency/runtime failures, the
failing source step and call, and digest/size context when known. The landing
check verifies that deployed function dependencies resolve from isolated bundles;
source import reconciliation includes its parser in the bundle.
