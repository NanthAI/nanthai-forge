`nforge metrics ROOT --failures` counts later landing attempts and accepted checks that reused an existing run. It reports how many receipts supplied the evidence and whether each bounded sample covered the window. The facts ride on the existing acceptance and failure writes, with no extra reads during landing. See [the health report](../../operations.md#project-health-report).

Agent capabilities report the live queue switches. A check summary reports the latest main-move sweep verdict with its keep or cancel reason and mover receipt. See [keep the run](../../pre-queue-checks.md).

A deferred resubmission that binds an exact retained pass can land from that verdict through the ordinary queue.
`nforge metrics` reports the mean and p90 builder-side measurement hold beside hosted finish-to-main.
`landings` reports measured order-wait seconds for recorded waits, including waits under a minute.

The strict first-check reader accepts v3 package-placement pins with standalone evidence for nested packages. Actions runners can write v3 evidence for certified JavaScript folders with the default-off `acceptance.standaloneNestedPackages` setting. See [package placement](../../pre-queue-checks.md#decision).

