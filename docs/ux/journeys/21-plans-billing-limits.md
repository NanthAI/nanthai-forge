# Journey 21: plans, billing and limits

Open Billing from the account rail at `/account/billing`. It leads with the
calendar month's accepted landings against one owner pool, then project usage,
month history, the plan and statement. Every invented figure says **Sample data**.
[Billing](../../billing.md) is the pricing, counting, service-limit and stub-adapter
reference; [journey 9](09-cost-usage.md) covers the cost of a project's own work.

Phase 7 has no live charges, metering or plan holds. Its regression tests cover
shared prices, bounded pages, reconciled totals, member sample omissions, budget
wording, chart/table parity, navigation and empty/loading/error states. Rendered
checks use the real account frame with synthetic data; live usage is not reported.

## Decisions

- Public prices are **Hobby free, Pro $15, Team $49**, without a “planned” label. Prices may be revisited. Price copy (Item 7f207066) does not turn on charging; billing and accounting are separate (Item 5822dd13). Yearly billing is outside the first build.
- Usage is to warn at 80% and show how people can reclaim space by removing old Lanes, objects and trash (Item a39ede89). An absent usage figure is not zero. Showing a limit does not authorize automatic deletion or a new restriction.

Live CLI/MCP limiter metadata remains on Item 93907d28.
