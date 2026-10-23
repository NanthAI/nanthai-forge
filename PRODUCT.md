# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
Practitioner developers who run several coding agents (Claude Code, Codex CLI, others) and a few people against one codebase at the same time, including Forge developing Forge. They open Forge between other work to answer three questions: who is working, what is changing, and what needs me. They are experts in their code and their tools; they do not need Forge explained to them twice.

## Product Purpose
NanthAi Forge is the workspace where people and coding agents change the same source safely in parallel. Each person or agent works in an isolated Lane; saves are combined into exact Views; a check runs on exactly that code; accepted work lands on `main`. Success: the owner delegates more to agents because the work feels in good hands, and comes back to Forge because it tells them, in seconds, the one or two things that need them.

Owner goal: "a useful/usable website with a nice design, without clutter and AI-isms. Something people are drawn back to."

## Positioning
Forge never surprises you and never loses anything. It is a calm shift lead, not a dashboard: it states who is on, what is moving and what is yours to decide, then gets out of the way. Trust comes from behaviour (the journey rail that never lies, Undo next to every automatic action, agents quoted in their own words), not from reassurance copy.

## Operating Context
- Execution stays on the user's machines (`nforge host .`; local `nforge serve` only carries Git and Work transport); hosted projects store source and Work. No managed runtime or agent-efficiency gain is claimed.
- Coding agents receive briefings/prompts copied from Forge ("Hand to an agent") and report back through presence and saves.
- GitHub import and publication are compatibility boundaries, not the core.
- Surfaces (signed in): Home (projects across the account), then per project Now (with Now › Activity), Work (Intents · Lanes · Views · Planning), Code (files, graph secondary), Settings (left nav: Project / Admin / You). Public: landing with a dry-run preview of a public repo.

## Capabilities and Constraints
- Vocabulary is fixed and must be used verbatim: **Intent** (an outcome), **Lane** (an isolated line of work by one person or agent), **save**, **View** (an exact combination of Lane saves), **Check**, **main**, **accept**, **hand to**, **stopped**, **needs you**, **seen**. Owner decision: keep "Intent" and "View".
- Banned words in product UI: approve, merge request, pipeline, job, bot, assistant, AI (say "agent" and name it), sync (say "update from main"), successfully, seamlessly, effortlessly, powerful. Hash, receipt, operation and View ids appear only inside "Exact record".
- Journey rail has four fixed stops: edited · saved · checked · accepted. It is a position, never a percentage.
- Autonomy presets on a "You decide ↔ Agents decide" scale; every automatic action is shown with an `auto` tag and Undo.
- Lane/Intent loading must avoid layout shift with reserved space.

## Brand Commitments
- Parent brand NanthAi: keep the NanthAi monogram as the company mark; inside the product the Forge F mark is used (stem = main, two arms = landed Lanes, crossings warm `#ffb347` and teal `#23cbff`). Top-left lockup "NANTHAI / Forge".
- Orange `#ff6b3d` means brand and the single primary action. It never means status, success, warning or a count other than Needs you.
- Manrope for titles; system UI font for everything else. Dark-first, light and system themes.
- Voice: plain, present tense, specific, numbers always, people and agents named. Fact, consequence, next step. No exclamation marks, no emoji.
- Taglines: "Hand it off. Watch it land." (landing headline, "land." in orange); owner's "Many agents. One codebase. Nothing lost."
- Design direction: `DESIGN.md` records the personality, tokens and component rules; `web/src/style.css` contains the shared implementation.

## Evidence on Hand
- Real dogfooding data: the NanthAi Forge hosted project (Forge building itself), with real Lanes, Views, checks and agent presence.
- No customers, testimonials, benchmarks or pricing exist. Do not fabricate them. A public benchmark arm is planned and must be published honestly when it exists.

## Product Principles
1. **Three questions, same place.** Who's working · What's changing · What needs me. Every signed-in screen is a view of these; nothing is more than one click from Now.
2. **One item, one place.** A thing appears in full in exactly one panel; everywhere else it is a pointer with a count. Nothing is read twice.
3. **Decisions arrive as questions with answers.** Needs-you items end in two or three buttons, recommended answer first (never orange), not a link.
4. **No standing reassurance or explainers.** The app never explains itself to people who already know it. Explanations live behind (i), a "Why" link, docs or first run. A permanent line must change the decision in front of the user right now.
5. **Status is colour + glyph + word**, always together, and only in the six status colours. Every element must earn its place; if in doubt, cut it.

## Accessibility & Inclusion
WCAG AA contrast in both themes; status never by colour alone; visible focus ring (`--focus`); `prefers-reduced-motion` makes all motion instant and pulses static; touch targets ≥ 32px on mobile (390px reference width) with no horizontal page overflow.
