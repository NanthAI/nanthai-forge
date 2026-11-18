## Passkey request budgets

Passkey challenge starts have a deployment-wide allowance of 120 per fixed
60-second window and 6 per exact handle. Passkey sign-up finish attempts have
an allowance of 20 per window and 3 per handle. Autofill has no handle yet and
shares the global start allowance. Convex supplies no client address, so the
global budgets are shared across visitors. These are interim defaults; the
phase 8 sign-up admission policy remains an owner decision.

The server charges in the ceremony's mutation and returns the existing
`RATE_LIMITED` error before any writes when an allowance is exhausted. Two
rows in the existing attempt-counter table reset on demand and contain at most
120 and 20 handle counters respectively. Neither rows nor per-handle entries
grow across windows; there is no polling, cleanup worker or idle work.
