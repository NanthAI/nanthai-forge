# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Practitioner developers who run several coding agents and a few people against one codebase at the same time, including Forge developing Forge. They open Forge between other work to answer three questions: who is working, what is changing, and what needs me. They are experts in their code and their tools; they do not need Forge explained to them twice.

## Product Purpose
NanthAI Forge is source control built for many AI agents working at once. The short name is **Forge**. The product goal is for agents to land in parallel without breaking `main`, with less time and CI cost than doing the same work on the comparison host. Public comparisons must be backed by measurements ([discovery spec](docs/ux/journeys/24-llm-discovery.md)).

Forge is the workspace where people and coding agents change the same source safely in parallel. Each person or agent works in an isolated Lane; saves are combined into exact Candidates; a check runs on exactly that code; checked work lands on `main`. Success: the owner delegates more to agents because the work feels in good hands, and comes back to Forge because it tells them, in seconds, the one or two things that need them.

Owner goal: "a useful/usable website with a nice design, without clutter and AI-isms. Something people are drawn back to."

## Positioning
Forge never surprises you and never loses anything. It is a calm shift lead, not a dashboard: it states who is on, what is moving and what is yours to decide, then gets out of the way. Trust comes from behaviour (the journey rail that never lies, Undo next to every automatic action, agents quoted in their own words), not from reassurance copy.

## Operating Context
- Execution stays on the user's machines (`nforge host .`); hosted projects store source and Work. No managed runtime or agent-efficiency gain is claimed.
- Coding agents receive briefings/prompts copied from Forge ("Hand to an agent") and report back through presence and saves.
- Git import and mirroring are compatibility boundaries, not the core. Connect a project's existing CI; Forge does not own its runners ([CI spec](docs/ux/journeys/13-connecting-ci.md)).
- Surfaces (signed in): Home (projects across the account), then per project Now (with Now › Activity), Work (Items · Lanes · Candidates · Planning), Code (files, graph secondary), Settings (left nav: Project / Admin / You). Public: beta discovery includes Explore, public profiles and account-backed, counted stars. A public project leads with its README and recent landings, with its code map one click away ([discovery spec](docs/ux/journeys/31-discover-and-star.md)).

## Capabilities and Constraints
- Vocabulary is fixed: **Item** is planned work everywhere people look. **Intent** is internal only. **Issue** survives only as a search alias in help, not as a product name. Other terms: **Lane** (one person's or agent's isolated line of work), **save**, **Candidate** (an exact combination of Lane saves), **Check**, **main**, **hand to**, **stopped**, **needs you**, **seen**. Use Candidate, not View.
- **Approve** is a person's decision on something held. **Accept** is the system's result when a change passes. Retire "grant" and "apply" as names for the owner's yes. **Land** is the event people see in the CLI, web and tagline; **Accepted** appears only as a state inside a receipt.
- Item statuses are **Proposed, Planned, In progress, Done, Abandoned**. Abandoned carries a reason: **won't do**, **duplicate** or **superseded**. Each Initiative shows its status and “x of y Items done”. There is no “stuck” status or automatic move out of In progress for inactivity. An explicit action or the work roll-up rules change status; an agent asks before moving someone else's work out of In progress. An Initiative has one shared Item order, no extra priority field; writer and agent reordering is recorded and undoable ([planning spec](docs/ux/journeys/08-planning.md)).
- Settings has two areas: **People & access** (who decides) and **Landing & checks** (how landings are checked). **Automatic** has one meaning: Forge picks from the project's own data.
- Roles are **owner / write / read**. Do not add Maintainer. Invited people are **members**; a **contributor** is an outsider. The link to the external Git host is the **mirror**.
- Agents do the source work by design; people who edit source use their own editors. The browser does not edit source or resolve conflicts; it gives a prompt to ask an agent. The CLI is agent-first, not agent-only: a read can lead with a human line, but JSON is the contract. Plain `land` saves first.
- Activation means signing up and creating, importing or cloning a project, including another person's public project. A landing is not required. The empty-page agent prompt is the walkthrough: no sample project or gamified checklist.
- The web calls a source snapshot a **version**; the CLI keeps **State**. Hide **Channel** while there is only one. Approvals are made in the browser at beta; approving a Candidate with no check run asks once for confirmation ([review spec](docs/ux/journeys/15-reviewing-agent-work.md)).
- Banned words in product UI: merge request, pipeline, job, bot, assistant, AI (say "agent" and name it), sync (say "update from main"), successfully, seamlessly, effortlessly, powerful. Hash, receipt, operation and Candidate ids appear only inside "Exact record".
- Journey rail has four fixed stops: edited · saved · checked · landed. It is a position, never a percentage.
- Autonomy presets on a "You decide ↔ Agents decide" scale; actions Forge takes are shown with an `auto` tag and Undo.
- Lane/Item loading must avoid layout shift with reserved space.

## Brand Commitments
- Parent brand NanthAI: keep the NanthAI monogram as the company mark; inside the product the Forge F mark is used (stem = main, two arms = landed Lanes, crossings warm `#ffb347` and teal `#23cbff`). Top-left lockup "NANTHAI / Forge".
- Orange `#ff6b3d` means brand and the single primary action. It never means status, success, warning or a count other than Needs you.
- Manrope for titles; system UI font for everything else. Dark-first, light and system themes.
- Voice: plain, present tense, specific, numbers always, people and agents named. Fact, consequence, next step. No exclamation marks, no emoji.
- Taglines: "Hand it off. Watch it land." (landing headline, "land." in orange); owner's "Many agents. One codebase. Nothing lost."
- Design direction: `DESIGN.md` records the personality, tokens, components and the rules for choosing each pattern; `web/src/ds/` contains the shared implementation.

## Evidence on Hand
- Real dogfooding data: the NanthAI Forge hosted project (Forge building itself), with real Lanes, Candidates, checks and agent presence.
- Do not invent customers, testimonials or benchmark results. Project Stats leads with estimated dollars saved against the same work on the comparison host at its published per-minute CI rate, including avoided runs without counting them twice. Then show time to main, first-try rate and CI minutes per landing ([Stats spec](docs/ux/journeys/23-stats-and-savings.md)). This is not a ledger of Forge's operating costs.
- Public price copy lists **Hobby free, Pro $15, Team $49**, without a “planned” label. The prices may be revisited. Showing them does not authorize charging ([billing spec](docs/ux/journeys/21-plans-billing-limits.md)).

## Product Principles
1. **Three questions, same place.** Who's working · What's changing · What needs me. Every signed-in screen is a view of these; nothing is more than one click from Now.
2. **One item, one place.** A thing appears in full in exactly one panel; everywhere else it is a pointer with a count. Nothing is read twice.
3. **Decisions arrive as questions with answers.** Needs-you items end in two or three buttons, recommended answer first (never orange), not a link.
4. **No standing reassurance or explainers.** The app never explains itself to people who already know it. Explanations live behind (i), a "Why" link, docs or first run. A permanent line must change the decision in front of the user right now.
5. **Status is colour + glyph + word**, always together, and only in the six status colours. Every element must earn its place; if in doubt, cut it.
6. **Forge adapts to each project.** Settings are Automatic by default: Forge picks them from the project's own records and changes them as the way its people and agents work changes. Every setting serves one goal, flow (work that lands and stays landed), and is judged on it, never on its own number; CI minutes, time and cost are means. A manual override is always there, and manual mode shows what Automatic would pick and why.

## Accessibility & Inclusion
WCAG AA contrast in both themes; status never by colour alone; visible focus ring (`--focus`); `prefers-reduced-motion` makes all motion instant and pulses static; touch targets ≥ 32px on mobile (390px reference width) with no horizontal page overflow.
