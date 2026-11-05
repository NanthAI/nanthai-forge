# Landing study: tentative mockup, critique and verdict

Status: **tentative design input from a trial run on 2026-10-27.** Nothing here is approved or shipped, and this extract adds no rule, price, limit or user step. The roadmap keeps the decision open: before the public beta, assess critically whether this direction beats the current page, and make the page striking rather than merely complete ([roadmap](../../roadmap.md), "Landing page redesign (tentative)"). [DESIGN.md](../../../DESIGN.md) remains the visual authority.

## What the trial was

A third-party landing-page skill ("Part A": intake questions, page structure, proof beside claims, objections as a section, specific copy, final call to action, SEO and meta; "Part B": a strict visual house style) was applied to Forge's public landing page. It produced three written documents and one mockup:

| File | What |
|---|---|
| [intake.md](intake.md) | The skill's intake answered from Forge's own docs. Anything not stated in a source is marked **(guess)**: conversion definition, objection ranking, traffic source, what visitors already know. |
| [critique.md](critique.md) | The 2026-10-27 landing page against the skill, ranked, plus a 19-row conflict table (skill rule, Forge rule, what the mockup follows, which is better and why). |
| [verdict.md](verdict.md) | Keep Part A, fence Part B, narrow the skill's trigger. |
| [`design/landing-study/landing-mockup.html`](../../../design/landing-study/landing-mockup.html) | The tentative mockup (hero with dated proof line, Now facsimile, what changes from GitHub, benefits, how it works, a measured table with the loss shown, works/partial/planned, FAQ, repeated call to action). |

## Evidence labels

- **Measured**: numbers quoted with their date and caveat (for example the 2026-10-20 burst timings and the 2026-10-24 failing-change loss, which must be shown next to the win). Current figures live in [why-forge](../../why-forge.md) and [b15d-report](../../research/b15d-report.md); this study predates the final B1.5d result and must not be used as a source for it.
- **(guess)**: reasoning the sources do not state. Keep it marked.
- **Not available, never to be invented**: customers, logos, testimonials, pricing, benchmarks beyond the measured ones. The mockup's Now panel is a typed facsimile labelled as an example; names and times in it are synthetic.

## Recommendation (a proposal, not a rule)

The verdict recommends: apply Part A to the public landing and docs site; treat Part B as superseded by DESIGN.md; forbid its instruction to invent brand names and testimonials; and narrow the skill's trigger from "any web UI" to "public landing and marketing pages only", so cockpit work (Now, Work, Lane, Settings) is never touched by its visual rules. The skill-trigger change is **not** an approved project rule; it needs a decision before anyone writes the override.

## Font

The mockup uses the exact Manrope file already in the repository, `web/src/assets/fonts/Manrope-latin.woff2` (byte-identical to the trial's copy). No second copy was added.

## Scrub

Removed from the original: internal Lane and case identifiers, the operator's name (now a synthetic person), a hosting cost range that was an unpublished estimate, and references to retired runner and compute backends in the FAQ. Phase wording in the mockup was neutralised ("a public beta is planned"). The mockup's remaining claims reflect 2026-10-27 and must be re-checked against [status](../../status.md) before reuse.
