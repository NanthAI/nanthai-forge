## Account limits and suspension

Every channel that can carry a message checks one suspend switch and one shared
per-account daily limiter (`convex/accountLimits.ts`). The check runs inside the
write's own mutation, after its operation-id replay check, so a replay is free.
Server-scheduled jobs (speed-budget Issues, a member start's Issue move, purges)
and the child writes a parent close or its Undo derives are not charged.

Limits per UTC day, New / Established. New means an account under 7 days old
with no linked GitHub login; Established means 7 days or older, or a linked
GitHub login without a conflict mark.

| Channel | New | Established |
| --- | --- | --- |
| Planning comments, puts and Work notes on own projects | 60 | 5,000 |
| Work notes on other projects (counted apart) | 60 | 500 |
| Friction records and triage; a contributor's imported records | 30 | 500 |
| Lane starts and new Intents (any route) | 60 | 750 |
| Saves | 300 | 3,000 |
| New projects | 3 a day, 10 active | 50 a day, 100 active |
| Board notes and coordination messages and handoffs, combined | 100 notes, 24 KB | 1,000 notes, 240 KB |
| Abuse reports | 10 | 30 |

Coordination status, acks, claims and releases, and an owner importing its own
friction history (a migration can be thousands of records), only meet the
suspend switch. Invitations keep their own approved budgets (20 an hour and 100 a day per
inviter, 3 a day per recipient, 500 a day per deployment). Proposals, invitations
and every channel above refuse a suspended account. The Established values are
at least three times the measured peak day of the account that runs all Forge
development agents (owner-approved 2026-11-22).

A refusal is `RATE_LIMITED` with `retryAt` and names the limit and when it
resets, for example: "This account reached its daily limit of 3,000 saves. It
resets at 00:00 UTC (…), in 4 h 10 min." The active-project limit is
`QUOTA_EXCEEDED`. A suspended account gets `ACCOUNT_SUSPENDED`.

Cost per charged write: one point read of the switch, one point read and one
write of a small counter row in the existing attempt-counter table. Saves and
own-project planning writes spread over 16 counter rows per account (other
counters 1 to 4),
so ten agents on one account rarely touch the same row, and a clash retries
inside Convex with no extra call. A full row hands over to the next and the
rows' shares add up to the limit, so the limit is the day's total. The account
tier is read only once a counter row reaches its New share, then kept on the
row for the day. New projects add one bounded read of at most 100 active
projects. Nothing runs while idle and no rows accumulate: each account has at
most 41 counter rows, reused daily.

Operators suspend or restore an account with the board switch, which writes an
audit row:

```sh
npx convex run projectBoardOperator:setSwitch '{"scope":"account","handle":"HANDLE","off":true,"reason":"..."}'
```

Suspending signs out the account's CLI devices and browser sessions, unlists
its public projects from explore and the sitemap, and hides its public profile.
Lifting the switch relists the projects that are still public; devices and
browsers sign in again. Read-only import grants are not ended; they expire on
their own and carry no messages.
