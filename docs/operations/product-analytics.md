# Product analytics decision (PostHog)

Status: **approved for development only.** Item 2c420916 records the owner decision.
Capture is off until the owner configures a dev project token. The failure log
([`nforge metrics ROOT --failures`](../operations.md)) works independently.

## What it would add

The failure log answers "what failed in this project, and how often". It can't say
how people and agents move through Forge across projects: where a first landing stalls,
which screens are opened, how many runs end at a dead end. Product analytics would answer
that with a small set of events from clients.

## Capture rules

- **Clients send, Convex never does.** The CLI and the web app send events straight to
  the vendor, in batches. No Convex action, mutation or scheduled function per event, so
  analytics adds no Convex calls, DB I/O or egress (cost reference: $1.682603 per 1,000
  landings stays unchanged).
- **Failure and milestone events only.** The screen event is sampled once per screen per
  browser session. The client sends no automatic page views, clicks or session replay.
- **No personal data or project content.** No names, emails, handles, project or file
  names, paths, messages, source or URLs with queries. Each install or browser gets a random
  id. A configured token salts the project hash. Event properties use fixed event, command,
  screen and cause labels, known error codes and numeric or boolean evidence.
- **Off by default.** The CLI requires an exact configured development deployment and honors
  `DO_NOT_TRACK=1`. The browser requires the dev site and honors the browser's Do Not Track setting.
- **Idle sends nothing.** The CLI sends batches of up to 20 events when the command returns.
  The browser batches events queued in the same turn and uses a keepalive request. Neither client
  schedules a periodic flush or retries delivery. The CLI shares a 300 ms network budget across
  its batches.

CLI and hosted MCP replies add a top-level `deadEnd` diagnostic when a failure or pending
outcome carries no continuation. The error code is `null` when the reply did not report one.
The diagnostic preserves the original outcome, error, and exit status. It works with capture off.

## Event list

| Event | Sent by | When | Sampling | Fields |
| --- | --- | --- | --- | --- |
| `landing_failed` | CLI | a land or wait reply ends with an error code | 100% | code, failure cause (`src/check-failure-cause.ts`), retry count |
| `operation_failed` | CLI | a command ends with an error code | 100% | command, code |
| `dead_end` | CLI | a failure or pending reply carries no next step | 100% | command, code |
| `first_landing` | CLI | a project's first accepted landing from this install | 100% | minutes since `start` |
| `landing_accepted` | CLI | an accepted landing | 10% | minutes from submit to main, checks reused (yes/no) |
| `screen_error` | web | the app's top-level error boundary catches a render error | 100% | screen name, code |
| `screen_opened` | web | first open of a rebuilt app screen or the legacy shell per browser session | 10% | screen name |

First landing is the first accepted landing the configured CLI install observes for a project.
A landing accepted sample requires a recorded commit time and uses a stable event UUID and
timestamp on replay. The current landing reply supplies enough evidence for a zero retry
count when the first attempt failed. It does not supply a count for later attempts or
whether a check was reused, so those properties are omitted.

## Volume and cost (estimate)

The estimate uses 30 days, 100 failed landings a day as the dogfood upper estimate,
a 10% failure rate for busy projects, and the 10% sample of accepted landings.
A failed landing emits both a landing failure and an operation failure. First landings,
dead ends, and failures outside landing add to these estimates.

| Scale | Landings/day | Events/month (estimate) |
| --- | --- | --- |
| Dogfood | 300 | 6,000 failure events + 600 accepted + 1,000 screens = about 7,600 |
| Busy project | 3,000 | 18,000 failure events + 8,100 accepted + 5,000 screens = about 31,100 |
| 100 busy projects | 300,000 | about 3.11 million |

PostHog's published pricing at the time of writing includes 1 million product-analytics
events a month for free, so dogfood stays at **$0/month**. At 3.11 million events per
month the [published rates](https://posthog.com/product-analytics/pricing) would put
uncapped capture at about **$88.07/month** (one million at $0.0000500 and 1.11 million
at $0.0000343). The dev allowance is the free tier.

## Enable development capture

The owner confirms the PostHog project's free allowance or billing limit, enables
[discarding client IP data](https://posthog.com/docs/privacy/data-storage), and supplies
the dev project ingestion token privately. Use a project token, never a personal API key.

- CLI configuration uses `FORGE_POSTHOG_PROJECT_TOKEN`, `FORGE_POSTHOG_DEV_DEPLOYMENT`
  (the exact development Convex origin), and optionally `FORGE_POSTHOG_REGION` (`us` by
  default or `eu`). Remove the token or set `DO_NOT_TRACK=1` to turn capture off.
- The Deploy dev web workflow passes the GitHub repository secret `VITE_FORGE_POSTHOG_PROJECT_TOKEN`
  and repository variable `VITE_FORGE_POSTHOG_REGION` to its build step. Set the region to `eu`
  for the EU development project. Supply the same variables when building the dev site manually
  with `npm run build:web`. The production web build leaves capture off.
- After a dev deploy, the owner verifies ingestion while signed in on the dev site. To turn
  dev web capture off, remove the token from the build configuration and redeploy the dev site.

Forge uses PostHog's [batch capture endpoint](https://posthog.com/tutorials/api-capture-events).
The project token is public ingestion configuration when bundled into the dev browser app.
