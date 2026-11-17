# Billing in Phase 7

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

The home loads lazily with the Billing route. `sample=first|hobby|pro|team|over|late|worst`
and `view=owner|member|loading|error` select explicit synthetic states. `screen=plan|invoices|payment`
reserves the billing screen addresses and currently shows their read-only summary;
the independently built screens replace those summaries. These switches never
change an account or start a payment flow.
