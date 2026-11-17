# Product analytics decision (PostHog)

Status: **proposed, waiting for the owner's approval. Nothing is integrated.** Item
2c420916. [Decisions](../decisions.md) constraint 12 keeps PostHog deferred until the
owner approves this page; until then the failure log
([operations](../operations.md), `nforge metrics ROOT --failures`) is the only failure
signal, and it costs nothing while idle.

## What it would add

The failure log answers "what failed in this project, and how often". It can't say
how people and agents move through Forge across projects: where a first landing stalls,
which screens are opened, how many runs end at a dead end. Product analytics would answer
that with a small set of events from clients.

## Rules if approved

- **Clients send, Convex never does.** The CLI and the web app send events straight to
  the vendor, in batches. No Convex action, mutation or scheduled function per event, so
  analytics adds no Convex calls, DB I/O or egress (cost reference: $1.682603 per 1,000
  landings stays unchanged).
- **Failure and milestone events only.** No page views, clicks or session replay.
- **No personal data or project content.** No names, emails, handles, project or file
  names, paths, messages, source or URLs with queries. Each install or browser gets a random
  id; the project id is hashed with a per-deployment salt. Error codes and screen names
  are the only text.
- **Off by default for self-hosted deployments**; one setting turns it off for the hosted
  service, and `DO_NOT_TRACK=1` is honoured by the CLI.
- **Idle sends nothing.** Batches flush on a milestone or when the process exits, never on a
  timer.

## Event list

| Event | Sent by | When | Sampling | Fields |
| --- | --- | --- | --- | --- |
| `landing_failed` | CLI | a land or wait reply ends with an error code | 100% | code, failure cause (`src/check-failure-cause.ts`), retry count |
| `operation_failed` | CLI | a command ends with an error code | 100% | command, code |
| `dead_end` | CLI | a reply carries neither success nor a next step (the dead-end guard's case) | 100% | command, code |
| `first_landing` | CLI | a project's first accepted landing from this install | 100% | minutes since `start` |
| `landing_accepted` | CLI | an accepted landing | 10% | minutes from submit to main, checks reused (yes/no) |
| `screen_error` | web | the app's error boundary catches a render error | 100% | screen name, code |
| `screen_opened` | web | first open of a screen per browser session | 10% | screen name |

## Volume and cost (estimate)

Assumptions: the Item's scale note (fewer than 100 failures a day while dogfooding),
failures at about 10% of landings beyond that, the 10% sample of accepted landings and
about 1,000 sampled screen opens a month per active project.

| Scale | Landings/day | Events/month (estimate) |
| --- | --- | --- |
| Dogfood | 300 | 3,000 failures + 900 accepted + 1,000 screens = about 5,000 |
| Busy project | 3,000 | 9,000 failures + 9,000 accepted + 5,000 screens = about 23,000 |
| 100 busy projects | 300,000 | about 2.3 million |

PostHog's published pricing at the time of writing includes 1 million product-analytics
events a month for free, so dogfood and early beta stay at **$0/month**. At about 2.3 million
events a month the bill would be the paid per-event tier's charge for the 1.3 million above
the free allowance. Check the vendor's pricing page and set a billing limit before
approving. A self-hosted copy is possible but costs a server, so it is not
proposed.

## Owner decisions needed

1. Approve or reject client-side analytics with the rules above.
2. Approve the event list and sampling (or name changes).
3. Approve a spend limit on the vendor account before any key exists.

After approval, the build is one Lane: a batched client sender behind a setting, with a
weight guard showing no CLI start-up cost and no extra Convex calls.
