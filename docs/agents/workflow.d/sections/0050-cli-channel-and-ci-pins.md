## CLI channel and CI pins

Forge builders use the main channel. New managed installations default to
stable, which checks for signed releases in the background after commands.
`nforge --version` and `nforge auth status` show the channel, exact build State
and pin. Include the build State from `--version` or the `cliCommit` from an
agent `--detail` receipt when reporting a failure.

For reproducible CI, record a full signed Forge State and install it using
`nforge update FORGE_CHECKOUT --directory CLI_DIR --bin CLI_BIN --pin FULL_FORGE_STATE_HASH`.
The same installation keeps that pin as releases move. A stable build below the
cached CLI or protocol floor returns `CLI_UPGRADE_REQUIRED` and an update
command. Use a newer pin to retain reproducibility.
See [CLI updates](../../../operations/cli-update.md#stable-releases-and-ci-pins).
