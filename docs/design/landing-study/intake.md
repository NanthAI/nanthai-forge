# Intake: landing-page-design skill applied to Forge

> Status: tentative design input from a 2026-10-27 trial; nothing here is approved or shipped. See the [study README](README.md).

Answers come from PRODUCT.md, DESIGN.md, README.md, docs/why-forge.md, docs/status.md, docs/roadmap.md and the current `web/src/landing/` code (2026-10-27). Items marked **(guess)** are not stated in any source.

## Purpose

- **One primary action.** Paste a public GitHub repository URL and press "Preview with Forge". This is the only action the current page has and it is the right one: it needs no account, costs the visitor nothing and shows the product on their own code.
- **The offer.** A dry run of Forge on a repository you already know: its import graph, an example Now screen built from its real files, and the exact briefing an agent would receive. Underneath that, the real offer is Forge itself: an open source source host and workspace where people and coding agents change one codebase at once, each in a Lane, with the exact composed result checked before it lands on main.
- **What counts as a conversion.** **(guess)** A completed dry run (import finished, tour shown). Secondary: a sign in, a GitHub visit, an agent or LLM that records what Forge is. No conversion definition exists in the sources; Forge is in private alpha and has no signup funnel to measure.

## Audience and context

- **ICP.** Practitioner developers who already run several coding agents (Claude Code, Codex CLI, others) and a few people against one codebase, including Forge developing Forge (PRODUCT.md). They are expert in their code and tools and do not need Forge explained twice.
- **Problem they are solving.** Parallel agents stepping on each other, waiting on CI and a merge queue, rebasing, lost or dropped landings, and no single screen that says who is working, what is changing and what needs a decision.
- **Top objections (why they do not convert today).** None are recorded; these are derived from status.md and why-forge.md. **(guess, ranked)**
  1. "Is it actually faster?" Single agent trials used 14% more input and 7% more time than plain Git; burst landing is 2.2–3.2× faster than GitHub's merge queue but 5.2× slower when one change in the burst fails.
  2. "It is not released." No public npm release, private alpha, no pricing or quotas, hosting is the owner's own deployment.
  3. "Do I have to leave GitHub?" Git repositories work, accepted source exports to GitHub, GitHub sync exists as an MVP.
  4. "Is running checks on my code safe?" Clean environments are not OS isolation; no hostile code confinement is claimed.
  5. "What does hosting cost?" Only internal estimates exist; none are published and no pricing exists.
- **Traffic source.** **(guess)** The GitHub README, developer social and forum links, search, and agents or LLM crawlers reading `/llms.txt` and the landing HTML. No ads, no email list.
- **What visitors already know.** **(guess)** GitHub, pull requests, merge queues, at least one coding agent. They do not know the words Intent, Lane, View, Check.

## Proof and assets

- **Numbers that exist and may be shown (with dates and caveats).**
  - 2026-10-20: a burst of four finished changes landed in a median 296.9 s on Forge versus 701.6 s through GitHub's merge queue (2.36×, 3/3 valid runs, same runners). Eight agents: 372.9 s versus 1,192.9 s (3.20×, early sample, 2/3 runs).
  - 2026-10-20 (P2): a single docs change 57 s versus 172 s (3.0×); a four change burst 310 s versus 678 s (2.2×). Forge ran 4 checks per burst, the merge queue 12.
  - 2026-10-24 (E3): with one failing change in a burst of four, a tuned GitHub merge queue was faster: 189 s versus 989 s. Must be shown next to the win.
  - 2026-10-24/25 (E1): 0 of 40 finishes dropped under overlap; 90 of 90 overlapping pairs alerted at save time; 84 of 90 reached both transcripts.
  - Forge builds itself: about 2,200 tests in 315 files; the hosted dogfooding project held 11,186 objects and 478 Views at last live push; recovery drill restored in 9 s on 2026-10-24.
- **Not available, must not be invented.** Customers, logos, testimonials, pricing, benchmarks beyond the above.
- **Screenshots or video.** None in the repository I can read; the hosted app renders them on demand. The mockup uses a typed HTML facsimile of a Now panel, labelled as an example, with Lane titles modelled on landings on Forge's own main.
- **Guarantees.** No commercial guarantee exists. Honest risk reversals that are true today: Apache-2.0 open source, no account for the preview, Git in and out so the repository stays portable, execution stays on your machines.

## Constraints

- **Brand voice.** Plain, present tense, specific, numbers always, people and agents named. No exclamation marks, emoji, "AI", "seamlessly", "powerful". Fixed vocabulary: Intent, Lane, save, View, Check, main, accept, hand to, needs you (PRODUCT.md).
- **Design direction.** "Steady hands": minimal editorial, dark first with light and system themes, Manrope titles, system UI body, flat surfaces, the F mark and six colour status language (DESIGN.md). The landing is the one surface in Persuade mode.
- **Mobile.** Yes: 390 px reference width, no horizontal overflow, touch targets at least 32 px (PRODUCT.md accessibility).
- **Extra constraint from the owner.** No permanent reassurance or explainer text; claims must match docs/status.md; anything planned is labelled planned; plain semantic HTML with a one sentence definition for LLM readers.

## Layout choice (skill A3)

**A, classic hero plus sections**, with the FAQ pulled up to directly after the measured numbers (the skill's own advice for high friction offers). Not B: long form story would mean explainer prose, which the owner has ruled out of UI. Not C: traffic is cold, not a known list. Not D: a "Forge vs GitHub" comparison page is a good later SEO page but would promise more than status.md supports today.
