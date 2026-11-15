# Journey 30: honest status during a provider outage

Something outside the project is down or slow: the CI provider, GitHub (the mirror, imports, sign-in through GitHub), or Forge's own service. What a person and an agent see, what keeps working and where the truth is published. Issue a0cf8c22 lists "honest status during a provider outage" under team and trust.

Walked: `help github`, `help retry`, `help storage`, `help system`, `help wait`, `check-settings` (the main audit and landing mode), `status` (mirror state), the pre-queue checks doc (provider outage recovery), the runner fallback doc, the parallel-work defaults and the open Issues 2c11ea35, adff6f58, a7de3a93, 660abe45 and 8c53a7f5. **Not walked:** an outage. Every statement here is from help text, docs and source.

## Steps today

| # | What is down | What Forge does | What the agent sees | What the person sees |
| --- | --- | --- | --- | --- |
| 1 | The CI provider never starts a run | One lookup at +5 minutes; then `runner-unavailable` "with a provider-outage reason" and a retry (three checks in total). | After the retries, `CHECK_NOT_PASSED` (infrastructure), distinct from `CHECK_FAILED`. | The Lane's check as not run: "Not run · runner never started". |
| 2 | The CI provider ran the jobs but its status lags | Fixed reads up to +4 hours; a complete job list passes at +30 minutes, recorded as `provider-delayed`. | `provider-delayed` "with the time since the last shard and next fixed read". | Not established which words the web shows. |
| 3 | Nothing moves at all | A stall alert after 15 minutes "naming the step and the missing owner"; after 60 minutes with nothing left to drive it, `LANDING_STALLED`; a 12-hour watchdog behind that. | `LANDING_STALLED: no progress for 15 minutes and nothing left to drive it. Read queue '{}', then land --save again from the same Lane.` | The alert, where one is configured ([journey 17](17-staying-informed.md), J17-2). |
| 4 | GitHub refuses or delays a mirror push | "A mirror push did not finish; Forge main is unaffected and the next landing or nforge github-sync retries it." `GITHUB_RATE_LIMIT`: "the mirror retries by itself after the named time." | Landing still succeeds. `status` carries `githubMirror.status`. | Now: **Resume mirror** after a failed push. An open Issue records a short GitHub error that "stops the whole mirror until a manual resume" (adff6f58). |
| 5 | GitHub is unreachable for an import or a connection | `GITHUB_SETUP_REQUIRED / GITHUB_UNAVAILABLE / GITHUB_CONNECTION_FAILED: … landing on Forge keeps working.` | The code and that sentence. | Import: **Resume import**. |
| 6 | The project uses its own CI file | The check waits for the mirror publication of its base; "a terminal mirror failure settles the check visibly". A GitHub outage therefore stops landings on such a project. | `runner-unavailable`. | |
| 7 | Forge's own service is unreachable | Lanes "keep working offline and land once back online". | `WORK_BUSY, *_UNAVAILABLE, HOSTED_REQUEST_FAILED: transient; retry the same command once, then record friction with the code if it repeats." `AUTH_NETWORK / AUTH_UNAVAILABLE: transient; wait the interval named, then retry.` | The web app's behaviour when the backend is down was not established. |
| 8 | Storage errors | "A read, upload or verify step failed … Nothing was claimed as done; retry the same command, which resumes by its operationId." | `SOURCE_*`, `R2_*`. An open Issue records transient read errors turned into a permanent failure (eb0491bb). | |
| 9 | Is main healthy? | `check-settings` → `mainAudit`: `result:"passed"`, `redMinutes:0`, `landing:{"label":"Fast landing","nextStep":"Nothing to do.","window":{"audits":50,"red":0}}`. | That read. | Not shown as a status line on Now, as far as the source read found. |
| 10 | A public status page | Not built. Open Issue 2c11ea35: "a status page draft that reads from Forge's own self-metrics … each number shows its measurement window and method link", with incident notes. | | |

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J30-1 | S1 | **During an outage nobody is told "it is not you".** Each failing command returns its own code. No reply, banner or page says "GitHub Actions is not starting runs since 14:05; your landings are waiting; nothing is lost". Ten agents each discover the outage separately, retry, and may each change their code to fix a failure that is not theirs. Forge has the facts: several `runner-unavailable` results in a row across Lanes. | ran: help, docs |
| J30-2 | S1 | **There is no status page.** A person who suspects an outage has nowhere to look, in the product or outside it. The promise in the journeys Issue is "honest status"; today the honest status is in an operator's alert channel. | docs |
| J30-3 | S2 | **Infrastructure failure and code failure share most of the path.** `CHECK_NOT_PASSED` against `CHECK_FAILED` is the only difference an agent sees, one word apart. `runner-unavailable` covers five causes (journey 13, J13-10). The instruction after a stall is disputed (journey 4, J4-1). | ran: help, docs |
| J30-4 | S2 | **The best claim is true and unstated: landings keep going when GitHub is down.** The help says "Forge main is unaffected" in the mirror topic. It is true of the mirror. A project whose checks run on GitHub Actions cannot land without GitHub; a project with a self-hosted runner can. No surface tells an owner which of the two they have. | ran: help, docs |
| J30-5 | S2 | **A stalled mirror can need a person and say so only on Now.** **Resume mirror** appears after a failed push; the open incident shows a short provider error stopping the mirror until someone clicks. Deploys that hang off the mirror stop with it ([journey 19](19-releases.md), J19-2). | docs, source |
| J30-6 | S2 | **Main's health is measured and hidden.** `mainAudit` knows whether main is red, for how long, and why landing is in fast or strict mode. It is inside a settings read (journey 4, J4-3). The one sentence an owner wants in an incident, "main is green as of 10 minutes ago", is not on Now. | ran |
| J30-7 | S2 | **Waiting has no ceiling an agent can plan around.** 5 minutes, 15 minutes, 30 minutes, 60 minutes, 4 hours and 12 hours all appear as thresholds. An agent in a turn that costs money has no single line "expect an answer by HH:MM; stop waiting and report". | docs |
| J30-8 | S3 | **"Record friction with the code if it repeats"** asks each agent to file a report during an outage, which multiplies the noise at the moment it is least useful. | ran: help |
| J30-9 | S3 | **After the outage nothing says "back".** Held landings resume by themselves or need a new `land`; nothing tells waiting agents or the owner that normal service returned. | docs |

## Dead ends

- "Is it down or is it me?"
- A project on its own CI file while GitHub is down: it cannot land and has no fallback.
- Learning afterwards what an outage cost (landings delayed, minutes wasted).

## Naming and tone

- The help topics are the best prose on this subject: "Forge main is unaffected", "Nothing was claimed as done", "landing on Forge keeps working". They are written per error code, so a reader needs to have hit the error to see them.
- `runner-unavailable`, `provider-delayed`, `LANDING_STALLED`, `CHECK_NOT_PASSED`, `LANDING_DRIVER_EXHAUSTED` are five outcomes for "wait or try later".

## What each persona needs

- **Agent, not person:** one field on every reply during an incident: what is degraded, since when, whether to wait or stop, and that its code is not the cause.
- **Person, not agent:** a line on Now and a public page with the same facts; a ping when their landings are affected; afterwards, what was delayed and that nothing was lost.

## Questions for the owner

1. Should Forge detect an incident itself (several infrastructure failures across Lanes in a short window) and say so on every reply and on Now?
2. Is the public status page (2c11ea35) part of the beta, and does it show Forge's own bad days from the first day?
3. Which numbers are public: uptime, time to main, failed-landing rate?
4. What is the promise when GitHub is down: "landing continues" only for projects whose checks do not run on GitHub? Should setup say which kind a project is?
5. During an incident, should agents stop filing friction and stop retrying, on Forge's instruction?
6. Is one waiting ceiling stated to agents ("give up and report after N minutes")?
