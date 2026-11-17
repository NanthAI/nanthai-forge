# Account billing

Forge does not charge a payment method yet. The account billing flow runs on stubs.

The **Account → Billing** destination (`/-/account/billing`) is being rebuilt with the account contract. Treat planned prices, plan changes, receipts and payment controls as proposed or stub behavior until the screen and [current status](../status.md) say otherwise. Charging, payment-provider setup, package publication and a production service are not available yet.

A landing is a change accepted onto main. Saves, checks, seats and open tabs are different units. CI runs in the configured provider account. Read [cost to serve](../operations/cost-to-serve.md) for measured service costs, their dates and their gaps; those measurements are not a customer price.

For current project usage, use the [metrics command](../reference/cli.md). It reports retained evidence; missing billed usage stays unknown. No billing action is required to read these docs, build the CLI from source or inspect the current development flow.
