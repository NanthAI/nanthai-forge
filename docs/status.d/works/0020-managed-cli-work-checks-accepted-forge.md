Managed CLI work checks accepted Forge main once per process. When main moved,
commands keep running on the working build while one detached updater stages,
builds under the machine's heavy-slot limit, canary-tests and atomically selects the new one; after a failed install, writes
install in the foreground or refuse with a typed recovery command. First-write hooks follow current and survive old-build pruning;
in-flight runtime leases protect lazy imports. Releases are signed (Ed25519, release-numbered)
by the owner or the automated `release-sign` GitHub job, and required: an unsigned main holds on
the current build until its signature appears. `nforge cli release-verify` re-checks stored
signatures.
See [CLI updates](../../operations/cli-update.md).

Under a CLI measurement hold, `land --save --no-wait` returns a local receipt and
wait command. Its detached submitter uses the recorded operation ID when released.
Live release adoption and billed-usage qualification remain unverified.
