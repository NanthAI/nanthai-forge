Checks secrets run on any CI with one machine key (Item 41a0df87, slice 5). The owner device creates the Checks set,
pointed to from Development, and `nforge secret machine add LABEL --set checks` prints `FORGE_SECRETS_KEY` once. On any
CI, `nforge run --set checks --only NAMES -- COMMAND` gives the command exactly the declared names, fails setup by name
before the command runs when one has no value, and always masks delivered values. A contract test runs the same check
with GitHub Actions and GitLab CI environments. Each run is one machine query (reader row first, then project row, set
row, history), no writes, nothing when idle; a caller without a valid token costs one small indexed read. A machine add
with an unknown outcome reconciles when repeated with its operation id. Not built yet: Forge-runner `credentials` from
Checks, per-check `allow` bindings, the public-log rule, CI-provider mask registration and key push, and machine
removal (next in this slice). See
[security](../../security.md#secrets-for-checks).
