Signed-out visitors browse a public project's files, folders and landing history read only from "Browse the code" on
its page, through the same public cache (no Convex connection, no write control, no Lane or Item links); clone and
fork still need sign-in. A private or missing project gives the same not-found answer. See
[security](../../security.d/sections/0800-downloads-and-public-viewing.md). Idle costs nothing; 1,000 uncached Files views cost
at most about $1.08 at list rates with cold starts, about $0.10 billed ([cost to serve](../../operations/cost-to-serve.md#public-code-views)).

The dev site can route anonymous rendered files through a Cloudflare Worker with a private R2 replica.
Fresh Worker cache hits call neither Convex nor the original source store. The approved dev setup and
the shared 30-second expiry are documented in the [R8 storage plan](../../r2-storage-plan.md#r8-public-code-delivery).
