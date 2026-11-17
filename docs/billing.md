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
