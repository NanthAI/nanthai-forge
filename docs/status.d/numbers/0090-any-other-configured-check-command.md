Any other configured check command receives the same runner-pinned changed-paths file
(`FORGE_CHECK_CHANGES`, also on hosted Actions). A check that declares `selection.scope`
may scope itself under a reduced-evidence gate and counts as scoped evidence, never full;
one that declares `selection.shards` runs as that many hosted Actions test jobs plus a
static job ([check command scope](../../workflows.md#check-command-scope)). Undeclared commands
run in full in one job. On GitHub Actions a check may declare `actionsToolchains` (Go, Python,
Java, .NET, Rust; a version or a version file) and `actionsCache` (dependency presets keyed on
lockfile hashes, saved only by main) as pinned workflow steps, and configured commands keep the
runner's toolchain-location variables ([toolchains](../../operations/github-actions-checks.md#toolchains-and-dependency-cache)).
App/OIDC runner repositories need the reinstalled `forge-check.yml` before a declared check plans.
Hosted check jobs log their fixed-cost phases (`plan: phases`, `run: phases`); a workflow may opt in to a
token-free planning step that also runs a single static check, and to a small control runtime cache
([fixed cost per check job](../../operations/github-actions-checks.md#fixed-cost-per-check-job)). Forge's own
`forge-check.yml` does not use them yet.
