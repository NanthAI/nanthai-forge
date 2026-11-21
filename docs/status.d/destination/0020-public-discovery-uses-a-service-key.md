Public discovery uses a service-key backend boundary and a per-IP/domain site function budget. Non-canonical
public paths and requests with the reserved cache selector redirect before reads. Ordinary JSON and sitemap
queries return the same data on cache hits and misses. HTML, JSON and sitemap variants share their canonical
cache identity. The native limiter counts redirects, but
enforcement is asynchronous (about ten seconds in dev), and native 429s lack a configurable `Retry-After`.
The bounded sustained-traffic probe covers canonical and redirecting paths. Raw dot segments can receive an
empty platform 404 before any function operation; application-controlled missing paths have a nonempty response.
Populated public-project share metadata remains open in follow-up Issue 43d2f68d until a public project exists on dev. Public-read failures
serve the bundled plain app shell, and function security headers are enforced directly. Share addresses use configured origins and cached visibility changes expire after 30
seconds without stale serving. Role-less signed-in readers follow the public plan and Lane-title rule at query
registration, including an Item's work list; the members-only plan is an owner-only server setting with no web control yet. Public weekly counts read seven compact day totals instead of full landing receipts; initial
coverage is labelled “recorded this week”. See [security](../../security.md) and
[development configuration](../../development.md#public-discovery-configuration).

A public project with a stored fork pointer links to its upstream while the upstream is public. If the upstream
is private, removed or missing, the page reports it as unavailable without naming it. The link follows the
same 30-second cache period as the rest of the page.

Explore and profile links keep the public project page available after sign-in. A person can star or
unstar there, and the owner can open a paged list of who starred. Public browser-only stars from the
legacy Projects list do not carry over. Public projects use account stars and private projects keep
their browser bookmarks. The signed-in Clone sheet and the CLI/MCP lookup use the same
deployment-pinned command format.
