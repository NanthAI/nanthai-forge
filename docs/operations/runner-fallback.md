# Runner fallback

The autonomy policy exposes `checks.runner` (`local`, `modal` or `github-actions`) and
`checks.fallback` (`manual` or `local`). Fallback defaults to `manual`, including
policies written before the fallback field existed. Policy and agent status
responses include the effective fallback when a runner is configured. Policies
without a configured runner keep their existing local finish flow; reading policy
or selecting an autonomy preset does not opt those projects into landing batches.

When Modal reports an auth or network error and confirms remote work has stopped,
manual fallback records `runner-unavailable`. Billing/budget errors record
`runner-budget-exhausted`. These are terminal infrastructure outcomes with no
exit code, not failed tests. Waiting finish calls return the outcome, a retryable
flag and recovery instructions. Retained logs, execution IDs and source pins
remain available. No command runs locally.

Retry using a new run or finish operation after restoring the runner. Replaying
the old operation returns its retained result. To switch the runner explicitly:

```sh
nforge agent OWNER set-policy '{"checks":{"runner":"local"}}'
```

To opt into automatic local fallback after confirmed remote termination:

```sh
nforge agent OWNER set-policy '{"checks":{"fallback":"local"}}'
```

Local fallback is available only for owner-originated Lanes. Imported native or
Git contributions, external PR work, and candidates containing them through Lane
parents or View dependencies cannot automatically fall back locally. Changing the
fallback setting does not change their provenance. Ambiguous remote outcomes
remain interrupted and require reconciliation of the retained execution IDs;
they never automatically repeat locally. Test failures remain failed tests and
do not trigger fallback.

Declared environment or credential inputs and Git-backed checks retain their
existing local routing behavior; these routes are selected before Modal runs.

[GitHub Actions and Blacksmith checks](github-actions-checks.md) use their configured runner labels and retained workflow dispatch identities; see that guide for setup and recovery.
