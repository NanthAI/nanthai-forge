# Journey 21: plans, billing and limits

Open Billing from the account rail at `/-/account/billing`. It leads with the
calendar month's accepted landings against one owner pool, then project usage,
month history, the plan and statement. Every invented figure says **Sample data**.
[Billing](../../billing.md) is the pricing, counting, service-limit and stub-adapter
reference; [journey 9](09-cost-usage.md) covers the cost of a project's own work.

Phase 7 has no live charges, metering or plan holds. Its regression tests cover
shared prices, bounded pages, reconciled totals, member sample omissions, budget
wording, chart/table parity, navigation and empty/loading/error states. Rendered
checks use the real account frame with synthetic data; live usage is not reported.

Open lines remain on `93907d28` (live CLI/MCP limiter metadata), `5822dd13` (Phase 8
payments and accounting), and `581bd373` (owner decisions about warnings and
storage-removal controls). An absent usage figure is not zero. Showing existing
service bounds does not authorise deletion, extra steps or a new restriction.
