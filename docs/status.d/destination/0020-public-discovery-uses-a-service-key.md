Public discovery uses a service-key backend boundary and a per-IP/domain site function budget. JSON query strings
and non-canonical public paths redirect before reads; explicit empty-query targets prevent Netlify query-copy loops.
HTML, JSON and sitemap variants share their canonical cache identity. The native limiter counts redirects, but
enforcement is asynchronous (about ten seconds in dev), and native 429s lack a configurable `Retry-After`.
The bounded sustained-traffic probe covers canonical and redirecting paths. Raw dot segments can receive an
empty platform 404 before any function operation; application-controlled missing paths have a nonempty response.
Populated public-project share metadata remains open in follow-up Issue 43d2f68d until a public project exists on dev. Public-read failures
serve the bundled plain app shell, and function security headers are enforced directly. Share addresses use configured origins and cached visibility changes expire after 30
seconds without stale serving. Role-less signed-in readers follow the public plan and Lane-title rule at query
registration. Public weekly counts read seven compact day totals instead of full landing receipts; initial
coverage is labelled “recorded this week”. See [security](../../security.md) and
[development configuration](../../development.md#public-discovery-configuration).
