# Phase 7 plan

Phase 7 rebuilds the public website and the signed-in app in the approved redesign and delivers the Phase 7 product Items that the redesign needs. [Phase 8](roadmap.md#phase-8-public-beta-planned) follows: the production move, payments, pricing and publishing. Nothing in this phase is published, deployed to production or shown to outside users without the owner.

Forge planning is the source of truth: Initiative `28591eeb-b74b-413a-ac41-1fef018b3dc1`, its build-index comment `3ee28029` and the owner decisions of 2026-11-16 (comment `e0404ba0`). Each Item carries its own Done-when lines, Scale line and dependencies; this page gives the order. Ids below are the first eight characters of the Item id.

## Guardrails for every stage

Every brief carries these lines, a Scale line ([brief template](agents/brief-template.md)) and the ladder rung that judges it.

| Guardrail | Bar | Judged by |
| --- | --- | --- |
| No regression in the savings against Git | Time to main, check minutes and check-to-commit gap stay inside the [speed budgets](agents/speed-budgets.md); the incident replays stay green | [Regression ladder](agents/regression-ladder.md) rungs 1–3 on every landing; rung 4 at the close |
| CLI and MCP stay at least as light as today | Cold start, agent-command CPU before the first network call, installed bytes and calls per command do not rise; lighter is welcome | The weight guard built by `92dbde9d` (until it lands: `perf-harness --cli-cold-start` and the current budgets) |
| Idle costs nothing | Zero Convex calls and zero DB I/O for an open idle tab, a hidden tab and an idle project; no polling | `check-idle-queries`, landing tests, and a live five-minute capture at each stage close |
| Serving cost per landing does not get worse | The Phase 6 reference, $1.682603 per 1,000 landings on Professional ([cost to serve](operations/cost-to-serve.md#p6-final-cost-baseline)); any unavoidable rise goes to the owner with its $/1,000 before landing | `tests/landing-cost-guard.test.mjs` (fails a rise over 15%) and the close capture |
| Web weight | Eager JavaScript inside the web budget in `src/speed-budgets.json`; first paint budgets for the rebuilt screens are set by stage B from measurement | `perf-harness --bundle`, `perf-harness --live` |

Builders start, finish and fix their own Lanes, run targeted tests only and leave full verification to the landing check ([builder rules](agents/briefings.md#building-forge)). Decisions and findings go to the Items and to repo docs.

Lead-approved scheduler safety delta (`1122c9c9`): solo reads 492 → 494; six-landing synthetic mean read bytes 715683.5 → 716591.5 (+908 B/landing), modeled +$0.0001816 per 1,000 at $0.20/decimal GB, with calls and writes unchanged; the read-byte ledger rises exactly 713500 → 714408 and the solo read guard 492 → 494 to preserve pending-only cancellation of the completion alarm and guard. This is a synthetic marginal model, not a new billed Phase 6 baseline.

The same scheduler safety adjustment adds exactly 15 status probes in each arm of the three-Lane disjoint early-resolution fixture (2968 → 2983 reads), preserving its zero extra calls/reads/writes comparison, and one pending-task probe at the main-audit cadence threshold (3 → 4 maximum landing reads); their guards record those exact increments, with writes and idle calls unchanged.

## Stage A: spikes and guards (in parallel)

All of stage A starts at once. Nothing in it waits for another stage A Item, except that screen-facing results feed the stage B go decision.

| Item | Outcome | Gate it feeds |
| --- | --- | --- |
| `348436e5` Exact framework spike | Build the hardest real screen (Lanes with the live top-bar line) against dev; measure first paint, bytes, idle calls, agent edit loop and accessibility; written go/no-go | Framework for stage B. Fallback: today's React stack with the headless layer from `f97fb89d` |
| `f97fb89d` Headless behaviour layer | Compare the candidates on one menu or dialog and one reorderable list; record the choice in [decisions](decisions.md) | Needed only on the React path; decided with `348436e5` |
| `de67c77d` Sign-in move | The two-day Convex Auth spike with every gate case in the Item (GitHub id and email, passkeys including real phones, CLI token issuer, idle, revocation, id mapping, native note); pass leads to the move, fail keeps the current provider | Sign-in routing in the shell `84125787`; device and session screens in stage C |
| `92dbde9d` CLI/MCP weight guard | Recorded baseline and a build-failing guard for startup, installed bytes and calls per command; a web import into CLI code fails | Every later brief |
| `45f49fb7` Regression ladder | Rung 2 (path-triggered dry micro-bench) built with its approved budget; the guard above linked to the ladder | Gates `bd0f850e` and `e7e35328`; covers per-change speed and cost so the close bench only confirms |
| `1df5e506` Public page, with `bf822f06` and `00c3f715` | The approved Threads public page in plain HTML and canvas with zero Convex calls; the hero loops while visible and pauses when hidden; real link destinations | Does not wait for the framework verdict. Its page-scoped tokens move into the shared system in `6ebb58ab` |
| `19b3718c` Security review | Read-only review of final Phase 6 main on Mythos 5.2; sanitized Issues for findings | Any critical or high finding is fixed or scheduled before stage C security-sensitive screens |
| Idle recheck (`53945141`, `b149b16b`) | A quiet five-minute live capture after the Phase 6 journal drain; zero executions, or the cause is attributed and fixed | Idle guardrail baseline for the phase |

**Stage A exit:** a recorded framework verdict, a headless choice if the React path is taken, the sign-in spike verdict, the weight guard and rung 2 on main, and the idle baseline.

## Stage B: shared base

Stage B builds once what every screen uses. It starts when the framework verdict is recorded; the design-system tokens and contracts can begin during stage A. The verdict is recorded: React 19 with React Aria Components, and stage B builds to the [shared-base rules](decisions.md#2026-11-16-rules-for-the-phase-7-shared-base).

| Item | Outcome | Depends on |
| --- | --- | --- |
| `6ebb58ab` Design system in the web app (with `f86cfa49` as the rule authority in [DESIGN.md](../DESIGN.md)) | Tokens, components, patterns and explicit pattern-choice rules from the approved system; the only path by which the private design set enters the repository | `348436e5`, `f97fb89d` |
| `84125787` App shell | Project, account, bare and public frames; six places; navigation, deep links, phone tabs and rearrangeable regions | `6ebb58ab`, `de67c77d` |
| `18af654d` Live top-bar Lane line | One bounded event-driven projection; a stage change shows within about 1 s; zero calls and DB I/O while idle; hidden tabs catch up once | `6ebb58ab`, shell |
| `641d887b`, `593b1ef2` Mark and icons | The mark follows existing state through the shell; static icons from the locked mark | shell |
| `8947a779` Discovery design | Fable designs the explore page, public project page, profiles, the star and the sign-in prompts for clone, fork and star, in the approved system | `6ebb58ab` |
| `2ec78c62` Protected-path warning at save | The first save that touches a protected path says the landing will need its configured approval, before a check is spent; the list-consolidation questions stay open | none |

The shell Lane owns the routing and security-header changes the new screens need, so stage C screens do not each touch protected configuration.

**Attention hierarchy and calmer first landing (owner, 2026-11-16).** The design system adds, without changing the look or removing detail:

1. One first stop per screen: whatever waits on the reader gets the strongest treatment; everything else steps down.
2. Three visual weights in the tokens: act now, watch and reference. Only act now gets the accent and motion; reference detail stays quieter until hovered or opened.
3. One consistent mark and colour for each kind of object (Lane, Item, check, session, person).
4. New accounts land with deep sections folded to one-line summaries that open in place and remember their state; no tours or permanent explainers.

**Stage B exit (checked before stage C starts):** the five-second test passes on Lanes, Needs me and Backlog. Fresh reviewers with no context see each screen at its busiest and at a new account's first landing, and answers two questions: what needs them, and what is done, in progress and left. Every reviewer must name the act-now items correctly and give the three figures. The test ran first on the attention-pass design (16 of 16 readers passed, 2026-11-16; results on `6ebb58ab`) and runs again on the built screens. A screenshot review against the approved design confirms that the look and the detail are unchanged. The shell, line and mark meet their live latency and idle-zero lines.

## Stage C: fan-out

Screens and paths are built at once as independent Lanes, in runs of about 12 to 15 builders. Public discovery follows the owner decisions of 2026-11-16 on `8947a779`: anyone can browse; clone, fork and star need sign-in; one star per person and never by an agent; GitHub star counts are not used; open Lane titles show to visitors only when the project opts in. Each Lane owns one screen or path and the Items that serve it; shared data contracts have one owner (planning `d3357f40`, access `df06081d` and `b987e608`, billing stubs `d4d410e6`, failure causes `2c420916`, Stats estimates `a61d3c91`). A screen whose contract owner has not landed builds against that owner's recorded interface, not a copy.

### Run C1

| Lane | Items | Depends on |
| --- | --- | --- |
| Lanes overview and To read | `e317b6ea`, `9e748e41` (To read), `eb0bbb94` | stage B |
| Lane review: files and line origin | `52235fbf`, `a1e3d771`, `22fa2a33`, `4bc460aa`, `577927f1` | stage B |
| Failed-check recovery | `2c420916` (causes), `b030c3c5`, `42b8bf0e`, `9e7a17df` | stage B |
| Code and history | `90e5bc9c`, `3968a655` | stage B |
| Needs me | `9e748e41` (Needs me), `12fde646`, `e88f503d`, `b54a14c0`, `2a5fa2e5` | stage B |
| Plan: model, list, Item and capture | `d3357f40`, `b7a0dff1` | stage B |
| Discussions | `9a3d6f5f` | stage B, `d3357f40` interface |
| People, access and teams | `b987e608`, `1e474c35`, `517523cf`, `c6629fda` (invitation email) | stage B |
| Public discovery | `8947a779`, `6a60e89a` (public reads, dev only), `76be0714` (public plan visibility: public by default, members-only setting, hide an Item or an Initiative), `d1303286` (fork), `875a4b60` (share cards and sitemap), `0650b8cb` (agent lookup) | stage B, `de67c77d` |
| Sign-in, devices and sessions | `df06081d`, `76e3ae31`, `a9f4654f` (terms and consent line) | stage B, `de67c77d` |
| Secrets | `41a0df87`, `f3663cbb` | stage B, its own security gates |
| Billing home and contract | `d4d410e6`, `93907d28` | stage B |
| Getting started | `6beca32b`, `c3e4a838`, `0c9207b8`, `871e9b73` | stage B |
| Run evidence and proof | `7967cf94`, `44bb6597`, `51d06df9`, `fae80649`, `7b31cc9c` | stage B |
| Docs destination | `b0cf7c38`, `b5bcbb61` | stage B |

### Run C2

| Lane | Items | Depends on |
| --- | --- | --- |
| Backlog bulk, versions and saved views | `65b0e706`, `4c9e961e`, `e0a23825` | `d3357f40` |
| Backlog import and export | `58478c0b`, `9b601e3b`, `bd24f0a6` | `d3357f40` |
| Repository import and mirror | `a488af2a`, `2abda01f`, `c63c2171` | stage B |
| Billing screens on stubs | `1fbf61b9`, `989c5695`, `7f9a23e8`, `176db9fb` | `d4d410e6` |
| Stats | `a61d3c91`, `2cf30e0a`, `80540753` | stage B |
| Loose ends and bulk requests | `fc1831eb`, `7456856f`, `16093ed1` | stage B |
| CLI reply lines | `235878aa`, `f15f1f1e` | `92dbde9d` |
| Public code and history | `4c164732` (signed-out read-only browsing on public projects, reusing the C1 Code and history screens) | C1 Code, history and public reads |
| Journeys and agent scorecard | `a0cf8c22`, `581bd373` | C1 screens it walks |

Each screen is reviewed against the approved design from real signed-in screenshots before acceptance. Old screens and styles are removed as their routes are covered; the growth guard records what each Lane removes.

## Stage D: close

| Item | Outcome |
| --- | --- |
| `0a9df3cd` Close bench | Fix the o08 harness void, then one N=10 series and the overlap N=8 cell for both arms on the Phase 7 release; no regression beyond one-rep variance against the Phase 6 published numbers; conflict-notice timing and delivery cost recorded |
| `7d0ccd72` Recovery turns | Recorded with the bench, without tuning to one task |
| `686ecdde` Billed cost | Billed dollars per landing against the Phase 6 reference |
| Security review | A Mythos 5.2 read-only review of the rebuilt website and app before the phase closes |
| Close document | Exit evidence per Initiative line, growth counts (`node scripts/check-growth.mjs --print --machines`) and an idle capture |

## Engineering carried from Phase 6

These run alongside the stages on spare builders and do not block the redesign. Two of them wait for the ladder.

| Item | Note |
| --- | --- |
| `bd0f850e` automatic CI landing settings, `e7e35328` single verified manifest | After rung 2 of `45f49fb7` is on main |
| `4a83a41f` flakes, `ad80e037` workflow papercuts, `537e73d9` preflight, `e3082c24` slow source action, `d824900c` metrics context, `b149b16b` live rechecks | Any stage |

The other open Phase 7 Items are older backlog moved in during the re-bucket. They are not scheduled by this plan; the lead takes quick wins and large uplifts as they fit and reviews the rest at the close. Dropping any of them is an owner decision.

## Staffing

UI and web builders are Claude (Opus and Sonnet). Fable gives design direction (the stage B attention hierarchy, screen review against the design) and helps when a builder is stuck. Mythos 5.2 runs the security reviews. GPT builds non-UI engineering slices and reviews every few landings; it gives no architecture verdicts. See the [lead playbook](agents/lead.md#current-forge-project-builder-profile).

## Security reviews

Read-only Mythos 5.2 reviews of our own code and dev deployment, at these points; findings become sanitized Items and details stay out of the public repository:

- Stage A: `19b3718c`, the Phase 6 changes.
- Before the sign-in move removes the current provider: sessions, the CLI token issuer, device keys and revocation.
- Stage B close: shell routing, the security headers and content policy of the new pages.
- During stage C, before each lands: Secrets, access and invitations, and the Markdown, image and attachment paths of discussions.
- Stage D: the whole rebuilt website and app.
