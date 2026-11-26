# Billing in Phase 7

Account Billing shows sample data for the planned subscriptions. For errors and limits that apply to live projects, see [Limits, errors and costs](limits.md#recover-from-an-error).

Billing belongs to an owner, above projects. Each person or organisation has one
calendar-month pool shared by its projects, with unlimited people. Hobby is free
with 300 landings, Pro is $15 a month with 1,000, and Team is $49 a month with
5,000. Each extra block of 500 landings is $10. There is no yearly subscription.

The shared display contract is `web/src/billing/contract.ts`. Screens consume a
`BillingAdapter` returning `BillingState`: loading, ready, or error with the last
snapshot. Every snapshot declares `source: 'stub'`. Financial details are absent
from member snapshots. Project pages contain at most 50 rows, month history 12,
and invoice pages 24; continuation cursors belong to the adapter. These bounds
apply to display pages, not to the owner's projects or capabilities.

The counting rule is one accepted landing per Lane, including each Lane in a
grouped landing. Held, refused, failed and reverted work adds no usage. Phase 7
uses supplied counters: opening Billing never scans landing history or changes
usage. No payment provider, keys, charges, metering, plan holds or new defaults
are enabled. Phase 8 owns live counters, payments and enforcement. Extra-block
permissions in a snapshot are explicit sample state, never an applied policy.

`landingAllowance`, `remainingBudgetLine` and `planHeldLines` define the P7 stub
reply contract. The compact line appears strictly below 20% remaining and names
the owner's billing pool, the landing count and reset time. A held stub names its
original automatic continuation and queue position; it needs no repeated land.
A run allowance has its own discriminant and unit and is never the billing pool.
These functions take existing metadata and perform no accounting read. Live
landing responses do not yet carry plan metadata; that integration remains P8.

## Cost and scale

The adapter adds zero Convex calls, DB reads/writes, R2 operations or network
requests per view or landing, including 1,000 and 2,000 landings. Idle cost is
zero. The marginal serving-cost delta is $0 per 1,000 landings against the Phase
6 reference; no new billed-usage claim is made. A view works on at most 50
project, 12 month and 24 invoice rows rather than the number of landings. Memory
is O(one bounded page); formatting is O(page size), with no timers or polling.
No stored bytes or schema change. Live aggregate-counter design is P8 work.

## Current service limits

These existing service bounds are separate from the subscription samples. The
P7 adapter does not read storage or limiter counters: current usage against these
bounds is **not reported**. The service operator configures them; this page adds
no new limit, warning or enforcement.

| Resource | Existing service bound |
| --- | --- |
| Stored object | 100 MiB |
| Stored project | 50 GiB or 4,000,000 objects |
| Stored owner account | 100 GiB or 10,000,000 objects |
| Signed-out reads | 120 calls/minute shared per public project; signed-in calls are not counted |
| Fresh member work | 300 checks, 300 composes and 300 submissions per UTC day; owners are exempt |
| Save manifest | 122,400 files and 19,360,000 logical manifest bytes per State |
| Compose manifest | 68,800 files and 11,200,000 logical manifest bytes per State |
| Sync/resolution manifest | 56,800 files and 9,200,000 logical manifest bytes per State |

Storage and request bounds are defined in `convex/abuseLimits.ts`. The source
bounds and their operation-specific recovery are in [source exchange](operations/source-exchange.md#supported-repository-envelope).
CI minutes are paid by the account that owns the configured runner; operator
storage and backend costs are separate from the displayed subscription preview.
Warnings, removal controls and live usage remain open on the journey scorecard;
the billing preview does not authorise a change to them.

The home loads lazily with the Billing route. `sample=first|hobby|pro|team|quiet|over|late|worst`
and `view=owner|manager|member|loading|error` select explicit synthetic states. These switches never
change an account or start a payment flow.

## Billing screens

Each screen loads as its own chunk with its address, `screen=plan|invoices|payment|limit`, and
reads the same adapter. `step=` selects a sample moment on a screen. The pure previews live in
`web/src/billing/preview.ts` and take the pool's `asOf` instead of a clock.

- **Change plan** compares the three plans in one table with each plan's cost at the month's
  pace, and names a cheaper plan in either direction. A move up starts at once: it charges the
  new plan for the days left of the calendar month, credits the days already paid on the current
  plan, includes the new plan's full landings at once and drops extra blocks the new plan covers.
  A move down waits for the reset and charges nothing. Paying hands off to a hosted payment page;
  its outcomes (bank confirmation, declined, unknown, paid) are sample moments.
- **Invoices** lists 24 per page, newest first, with one statement for the selected invoice. On a
  phone the list or the invoice shows. It covers paid, unpaid, refunded, empty, loading and
  payment-provider-unavailable states, the download action and a short corrected-invoice request.
- **Payment and details** shows the card summary, the details printed on invoices, the limit on
  extra landings and who has billing. A new paid plan allows two extra blocks; the screen states
  where landings then wait and the most a month can cost. Card entry and replacement hand off to
  the hosted payment page: Forge renders no card fields and holds no card secret.
- **Landing limit** draws the plan-held moments (limit near, all used, as a writer, allowance
  back, first extra block, at the limit, payment failed) from one source, `heldStory`, so the
  rail foot, Lanes notice, held Lane, Needs-you row and decision and the agent's reply agree.

A billing manager sees invoices, the plan, the card and the limit, and gains no source, project
or people administration; the member view carries no financial data. Server-side access checks
for these roles arrive with the P8 integration.

### Rules the screens follow

| Rule | Source |
| --- | --- |
| Calendar months for everyone; a mid-month start pays the days left and gets its full landings at once | owner decision 4.4 |
| Moving up mid-month drops the extra blocks the new plan covers | 4.7 |
| A new paid plan allows two extra blocks (`defaultExtraBlocks`); the owner changes it | 4.2 |
| A limit approaching shows when the month's pace uses it before the reset, never at a fixed percentage | 176db9fb |
| At the limit, Lanes wait at In queue with their places kept; saves continue; no check runs, so no CI minutes are spent; Hobby has no grace landing | 4.6 |
| When allowance returns, waiting Lanes land in queue order on their original operations; nothing is resubmitted | 176db9fb |
| Taking a landing out of main never counts and never waits on the plan | `landingCountingRule` |
| A failed payment is tried on days 1, 4 and 8; landings continue 21 days, then the Hobby allowance applies with queued work kept; nothing is deleted (`paymentRecoveryRule`) | 4.8 |
| Another plan that would cost less at the account's pace is named, in both directions | 4.9 |
| No yearly billing in the first build | 4.10 |

### Action contract

`web/src/billing/actions.ts` defines the actions P8 connects: `checkout`, `reconcile`,
`replaceCard`, `schedulePlan`, `setLimit`, `saveDetails`, `requestCorrection` and `download`.
Each mutation carries an operation id. A repeated id returns the same attempt, and `reconcile`
reads that attempt without starting another, so an unknown payment result is never paid twice;
a new id is used only after a declined attempt. A failed edit returns a typed error, keeps what
was typed and is retried on the same id. The P7 stub keeps results in memory: it makes no network
call, sets no timer, stores nothing, charges nothing and sends no message. `handoffUrl` is null
until P8 supplies a hosted payment page.

### Billing email triggers

Forge has no push notifications. Billing sends an email only when money moved or is about to stop
work; each carries the amount, the date and one link. P7 sends none of them; P8 (5822dd13) sends
them.

| Email | When | To |
| --- | --- | --- |
| Invoice paid | On the 1st, and the day a plan starts; the PDF attached | owner and billing managers |
| Payment failed | Each declined try: what was tried, the next try, and the date landings would wait | owner and billing managers |
| Card expires before the next invoice | Once, 14 days ahead | owner and billing managers |
| Landings are waiting | Once, when the limit is reached; not at a percentage, not daily | owner and billing managers |
| Plan, card or limit changed | On each change, naming who changed it | owner |

A price change is announced in the plan-changed email at least 30 days before it applies, with
the plan, the current price, the new price and the date; nothing changes for the account before
that date.

### Screen cost

The screens add no Convex calls, DB reads or writes, R2 operations or network requests per view
or action, and nothing on an idle tab: the delta is $0 per 1,000 landings. A view works on one
bounded page (24 invoices, 50 projects, 12 months), so its memory and work stay the same at
double the account's history.
