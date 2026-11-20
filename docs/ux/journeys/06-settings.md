# Journey 6: settings

Who decides (autonomy), how a landing is checked (landing mode, admission check, early resolve, gate), the coming Automatic and Manual CI settings (Issue 871e9b73), and the nudges when a project is not on recommended settings.

Walked: `policy`, `check-settings`, `capabilities`, `nforge settings`, the Settings sources (`HostedSettings`, `Autonomy`, `LandingMode`, `HostedChecks`, `GithubStatus`), the landing-mode source and the governance, pre-queue-checks, workflows and parallel-work-defaults docs. **Not walked:** a settings write and its approval page.

## Where settings live today

| Place | What it holds | How it is changed |
| --- | --- | --- |
| Web → Settings | Left nav. Project: General, How agents work, Autonomy, Contributions (when present), Checks, GitHub. Admin: Access, Transfer & backups. You: Profile, Signed-in devices. | Forms; owners only for project pages. Readers see values with "Only owners can change this". |
| Web → Settings → Autonomy | A "You decide ↔ Agents decide" scale; presets Supervised ("Agents propose. You accept."), Trusted ("Agents accept on a passing check."), Autonomous ("Accept, complete and clean up."), Custom. Then "What agents may do on their own": Accept on a passing check (Never or Allowed agents), Allowed agents (actor IDs), "Protected paths — always a person", "Reuse checks after disjoint main changes", "Complete Intents when all their Lanes are accepted", "Clean up regenerable local copies", "While you were away summary". **Save autonomy** and Discard. | Explicit save. |
| Same page → Landing mode panel | A label ("Fast landing", "Strict landing" or "Fast landing paused"), "Policy: fast · Effective: fast", a reason when paused, and a button **Switch to strict landing** only while Forge advises it. | The button applies at once. |
| Web → Settings → Landing and checks → How a landing is checked | One folded line per setting: landing mode (with the reason while fast is paused), check before the queue and changes checked together (only while landings land on a passing check), groups checked at once (only when set), resolve a conflict early, revert a change that breaks main. Each shows the value in effect and where it comes from: set by the owner, default, or Automatic (today only the size of a group checked together, picked from the last 20 shared checks). Opening a line says what the setting does, what it costs and the command that changes it. | Read only on the web: the line shows the owner's `set-policy` command and how the change applies. Sent from a CLI or agent sign-in after the project's first landing, it waits for the owner's approval, except early resolve (never held) and a switch back to strict. Landing mode and early resolve leave queued landings in place; the others restart them. |
| CLI, project policy | `acceptance.mode` (review or auto-on-pass), `gate` (full or contract), `landingMode` (strict or fast), `admissionCheck` (absent or false, true, or "full"), `earlyResolve` (automatic, on or off), `protectedPaths`, `ownerApprovalPaths`, `autoActors`; `agentDefaults` (preflight, preflightMaxMinutes, urgentRoles, checkpointNudgeMinutes, stallAlerts, autoClaim, dormantAfterDays, stacking); `autoSnapshot`; `githubMirror`; `lifecycle`; `trust`. | `nforge x ROOT set-policy 'JSON'`. Read with `policy` or `check-settings`. |
| CLI, checks and runner | Check definitions, runner provider, `runsOn`, `concurrencyBudget`, `publicLogs`, the main audit. | `x configure-check`, `x configure-runner`. |
| CLI, this machine | `autoPruneHours`, `activeLanePruneHours`, `idleLaneHours`, `localHeavySlots`, `shareDependencies`, `installScripts`, `clientCacheMaxGB`, `clientCacheMaxAgeHours`, `firstWriteHooks`, `landWait`. | `nforge settings KEY VALUE` or `--reset`. The read shows each value and whether it is the default. (ran) |
| Repository file | `forge.json`: preflight tests, static checks, guards, install scripts. | A landing. |

## Steps today: an owner changes how landings are checked

1. The owner looks in Settings → Autonomy. Landing mode is shown; admission check, early resolve and gate are not. (source)
2. The owner finds the command in the docs: `nforge x ROOT set-policy '{"acceptance":{"landingMode":"fast"}}'`.
3. The CLI sign-in counts as an agent. A change that alters what a landing may accept is not written. The reply is `rule:"held"` with a link `/approve?project=…&lane=setting:policy`. (docs)
4. The owner opens the link, signed in on the web: "Apply this policy change? Requested by HANDLE, signed in as an agent. Policy changes decide what every landing must pass, so they need you." The change is shown as the JSON that was sent (open Issue 16093ed1). (source)
5. The owner approves it. The original command, replayed, returns the applied receipt; `wait '{"approval":"…"}'` returns on the decision.

Changes toward more oversight (back to strict, alerts back on) and most `agentDefaults` apply at once. A project with no landing yet applies everything directly (`rule:"bootstrap"`).

## Nudges today

- **Landing mode:** when fast is paused by its circuit breaker (3 real red audits or 3 unclear audits in the last 50), `check-settings`, the web panel and the next landing receipt carry the reason and one next step, and the web offers **Switch to strict landing**. Forge never changes the policy itself. (docs, source)
- **Check scope:** `check-settings` returns `proposals`, for example: "This command runs in full on every check. Declare selection:{scope:"changed-paths"} …". (ran)
- **Early resolve:** every exact-conflict reply states the choice, the reason and the two measured figures. (source)
- **Stalls:** alerts after 15 and 30 minutes by the configured channel. (ran)

There is no nudge for the admission check or the gate, and no single statement of what "recommended" is.

## Findings

| Id | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| J6-1 | S1 | **A person cannot change how landings are checked in one place.** The web has no control for landing mode (unless Forge is advising a switch), admission check, early resolve, gate, `agentDefaults`, snapshots or the mirror. The CLI has every control, but the owner's own CLI is treated as an agent, so the change is held for the same person to grant on the web. Settings pattern: a setting is found, changed and confirmed in one place. | source, docs |
| J6-2 | S2 | **A switch with no effect is on screen.** "Reuse checks after disjoint main changes" edits `acceptance.disjointFastPath`. The docs say this setting "went with the local landing driver … stored values stay readable and have no effect". "Clean up regenerable local copies" also belongs to local copies. | source, docs |
| J6-3 | S2 | **The policy read mixes live and dead settings.** It returns `disjointFastPath`, `overlapGate:"off"` (retired, sent for old CLIs), `ownerRootUpdates`, `laneUpdates:"ask"`, `autoExchange` and `integrationPreview` beside live ones, with nothing to tell them apart. | ran, docs |
| J6-4 | S2 | **The same words mean different things in neighbouring settings.** "Automatic" is a value of early resolve, the coming CI settings mode, the `auto` tag and auto-on-pass. "full" is a gate and an admission check. "fast" is a landing mode and `disjointFastPath`. "Trusted" is an autonomy preset; `trust` is per-path enforcement. "Check" is the landing check, the admission (pre-queue) check, the second check, the main audit and preflight. | ran, docs |
| J6-5 | S2 | **`admissionCheck` has three values of two types.** Absent or `false` (check in the queue), `true` (an older scoped form) and `"full"` (the pre-queue Lane check). | docs |
| J6-6 | S2 | **One read, four spellings.** `nforge policy ROOT`, `nforge agent ROOT policy`, `nforge hosted-work DEPLOYMENT PROJECT '{"action":"policy"}'` and the MCP tool. Writes: `nforge set-policy ROOT`, `nforge x ROOT set-policy`, `nforge hosted-work … set-policy`. The docs use all of them. | ran, docs |
| J6-7 | S2 | **Two axes on one page with one name.** "Autonomy" holds who decides (presets, protected paths) and how a change is checked (landing mode). The coming Automatic and Manual CI settings are a third thing: who picks the checking settings. A page titled Autonomy with a scale "You decide ↔ Agents decide" and a mode switch "Automatic / Manual" would have two scales that sound alike. | source |
| J6-8 | S2 | **Two ways of saving on one page.** Autonomy uses **Save autonomy**; the landing-mode button applies at once. Settings pattern: one persistence model per section. | source |
| J6-9 | S2 | **`check-settings` reports a blocker that contradicts the policy** (see [journey 2](02-first-task.md), J2-1). It is the read an owner or agent uses to understand the settings. | ran |
| J6-10 | S2 | **No definition of "recommended settings".** Docs give strict as the default landing mode and the queue check as the default admission; the Forge project runs fast with full admission and the contract gate. A nudge needs a stated baseline or a measured one. Issue 871e9b73 chooses measured ("what Automatic would pick and the measured reason"); nothing shows it yet. | ran, docs |
| J6-11 | S3 | **The settings change page shows raw JSON** (open Issue 16093ed1). | source |
| J6-12 | S3 | **The Checks page prints a removed command.** "Define a check locally: nforge agent /path/to/project define-check …". The CLI answers `define-check was removed with native mode. Use x configure-check defines a check.` (the sentence is also broken). | source, ran |
| J6-13 | S3 | **Allowed agents are entered as "Actor IDs, comma-separated"**, with a tip "Use the actor IDs recorded by Forge". Nothing on the page lists them. | source |

## Dead ends

- Looking for landing mode, admission check or early resolve on the web (J6-1).
- The removed `define-check` command on the Checks page (J6-12).

## Naming and tone

- Web: Autonomy, preset, "Accept on a passing check". CLI: policy, acceptance, mode. Docs: autonomy policy, acceptance gate, landing modes, pre-queue checks, admission. The owner's Issue: "CI settings".
- The web's preset lines ("Agents propose. You accept.") are the model for how every switch could read: who does what.

## What each persona needs

- **Agent, not person:** one read that says which settings shape its landing, with dead settings removed; when a setting differs from the recommendation, one line it can pass to the owner. Agents never change settings; a held write must say so and give the link (it does).
- **Person, not agent:** each switch explained by its consequence (minutes, waiting time, whether main can be red), the current value at rest, and the change made where it is read.

## Questions for the owner

1. Are there two settings areas (who decides, how landings are checked) or one? What are they called? "Autonomy" and "CI" are today's candidates.
2. With Automatic and Manual coming: is fast or strict landing one of the things Automatic picks, or does it stay the owner's choice above it?
3. Should the owner be able to change every project setting on the web, so the CLI path is only for agents asking?
4. Should settings with no effect be removed from the page and the reads now, ahead of the redesign?
5. Is "recommended" always what Automatic would pick from measurements, or is there also a fixed starting baseline for a new project with no history?
6. Which single word replaces the several meanings of "automatic"?
