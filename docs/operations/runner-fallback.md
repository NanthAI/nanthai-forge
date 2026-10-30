# Runner fallback

`checks.runner` selects `local` or `github-actions`. An absent runner keeps the
local finish flow. Git-backed checks and checks with declared environment or
credential inputs retain their existing local routing behavior.

Actions uses its configured repository and runner label. Unknown remote outcomes
retain the original dispatch and execution identities for reconciliation; commands
do not automatically repeat locally. See [GitHub Actions and Blacksmith checks](github-actions-checks.md).

To switch the runner for a new check:

```sh
nforge agent OWNER set-policy '{"checks":{"runner":"local"}}'
```

Modal is retired. Historical `modal` policies and receipts, including
`checks.fallback` and `credentialsRef`, remain readable. Credential references
are never resolved or forwarded to a controller. Selecting Modal for a new policy
write is refused with a supported-runner message. A retained Modal run that is
explicitly resumed records `runner-unavailable`; it does not execute locally
or call a deleted provider. Existing execution evidence remains retained.
