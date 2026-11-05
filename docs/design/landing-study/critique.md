# Critique: the current Forge landing against `landing-page-design`

> Status: tentative design input from a 2026-10-27 trial; nothing here is approved or shipped. See the [study README](README.md).

Scope: `web/src/landing/Landing.tsx`, `PublicFrame.tsx`, `AliveHero.tsx`, `DryRun.tsx`, `landing.css`, `web/src/ui/tokens.css`, `web/index.html` as of 2026-10-27. Read only; nothing was run.

## What already works

- **One offer, one action.** A single primary CTA ("Preview with Forge") above the fold, no competing buttons, a clear "no account needed" line. This is the hardest part of the skill and the page already has it (A2, A4).
- **Approved typeface, sensible weights.** Manrope is on the skill's allow list; display weight 730 is below the 900 it bans; no italics anywhere (B1).
- **Hero copy width.** `h1` capped at 680 px, lead at 600 px, with a meaningful line break after "Hand it off." (B5).
- **Hero visual that is the product.** The river of work canvas is Forge's own metaphor, pauses offscreen and under reduced motion, and runs at a capped frame rate (A2 item 5, B7).
- **Ship hygiene mostly present.** Skip link, `<header>`, `<nav>`, `<main>`, `<footer>`, `<section aria-labelledby>`, visible focus ring, favicons, manifest, `prefers-reduced-motion` (B10).
- **Real copy, sentence case, no banned filler.** No "supercharge", no Lorem, no exclamation marks (B8).
- **Nested radius already correct.** The paste box is 12 px with 6 px padding; the button inside is 6–8 px, which is what the skill's formula gives (B3).

## Top issues, ranked by impact

### 1. No proof anywhere on the page
Rule: A2 item 4 (one proof signal above the fold), A4 "put proof beside the claim", A8 "proof buried at the bottom".
Forge has dated, honest measurements (2.36× and 3.20× burst landing versus GitHub's merge queue on the same runners; 0/40 dropped finishes under overlap; about 2,200 tests; Forge builds itself) and none of them appear. The only "proof" is a footer whisper, "Open development · Forge builds itself".
Fix: one proof line directly under the CTA, dated, with the caveat link: "Measured 2026-10-20 on the same runners: four finished changes landed in 297 s on Forge, 702 s through GitHub's merge queue. All measurements, including where GitHub is faster →". A short "Measured" section mid page carries the full table, the E3 loss included.

### 2. The page stops after the argument has barely started
Rule: A2 items 6–12 (problem to solution, how it works, objections as a section, risk reversal, final CTA), A4 "treat objections as a section, not a footnote".
After the hero there are three cards and one sentence about autonomy, then the footer. There is no "what changes from GitHub", no three step how it works, no FAQ, no final CTA. A visitor who scrolls past the paste box has nowhere to go but away. The objections in status.md (single agent is slower, private alpha, Git interop, check isolation, cost) are exactly the FAQ the skill asks for, and answering them honestly is on brand.
Fix: add How it works (start a Lane → edit with your own tools → finish; Forge composes, checks the exact result and lands), a 7 question FAQ written from status.md, a Works today / Planned block, and the same paste box repeated at the bottom.

### 3. The headline tells nobody what Forge is
Rule: A2 item 1 (headline = outcome plus audience), A5 subheadline "clarify what it is and who it is for"; owner's LLM discoverability requirement.
"Hand it off. Watch it land." is a mandated brand tagline (PRODUCT.md) and should stay, but the lead that follows describes a mechanism ("each in its own Lane, with every change checked") without ever naming the category or the audience. An LLM reading the HTML learns no noun for Forge. It also says "AI coding agents", and "AI" is on PRODUCT.md's banned list.
Fix: keep the h1, make the lead a definitional sentence: "Forge is an open source source host for people and coding agents changing one codebase at once. Each works in its own Lane; a landing queue checks the exact composed result before it reaches main." Category, audience, mechanism, in that order.

### 4. Vague or unspecific lines where numbers exist
Rule: A4 "be specific", A8 "vague value prop".
"Delegate as much as you like." · "Autonomy is a per-project dial, from Supervised to Autonomous." · "Everything else is a click deeper." These are the page's softest lines and they sit where the second argument should be. Status.md has the specifics: nine briefing situations, protected paths, exact View checks, auto tag plus Undo on every automatic action.
Fix: replace the guard section with a benefits list where each bold benefit is followed by the fact that proves it (A5 bullet format).

### 5. Broken, stale or missing ship items
Rule: B9 "no dead links, current page indicated", B10 `<title>`, meta description, og tags.
`<title>` is "NanthAi:Forge · Source explorer", there is no meta description and no `og:` tags, so link previews and search snippets describe nothing. Every link points at `github.com/nanthai/forge`, while the public repository is `NanthAI/nanthai-forge`; the placeholder in the paste box repeats the wrong path. No nav item is marked current. The footer has no privacy or terms link (B10); do not add dead ones, but note it before public beta.
Fix: title "NanthAi Forge: source host for people and coding agents changing one codebase at once", a 150 character description, `og:title`/`og:description`, correct repository paths, `aria-current="page"` on the brand link.

### 6. Three feature cards in the generic icon, heading, paragraph pattern
Rule: A4 "write benefit first", A8 "feature list with no outcomes"; DESIGN.md's own "don't use icon in a square + heading + paragraph … feature grids".
The three `.fx-step` cards are the most template like element on the page and the one DESIGN.md explicitly warns against inside the app. Two of the three are genuinely benefit written ("the Lane comes back to you with the failing test, not a red wall" is excellent); the format undersells them.
Fix: a numbered How it works for the mechanism, a plain definition list for benefits, no icon squares.

### 7. Off scale sizes and in between spacing (by the skill's tables)
Rule: B1 type scale, B2 spacing table.
Sizes: 15 px step titles, 13 px body, 12.5 px buttons, 13.5 px `.fx-btn-lg`, 14 px CTA. Spacing: 26 px hero gap, 10 px card gap, 20 px card padding, 28 px section padding, 6 px paste box padding. Most of these are deliberate DESIGN.md values (13 px body, 20 px gutters), so for the app they are correct and the skill is wrong. For the landing specifically, 13 px body and 15 px section titles are small for marketing prose read at arm's length; 16 px body and 20–24 px section titles are on both scales.
Fix: landing only, lift body to 16 px and section headings to 20–24 px using existing `--fx-t-16`, `--fx-t-20`, and add 64 and 96 px section rhythm tokens for the landing. Leave the app untouched.

### 8. Motion and chrome rules the skill would impose and Forge should decline
Rule: B5 gradient heading text, B7 500 ms base curve and minimum 200 ms hover, floating translucent blurred nav, scroll reveals, B11 word by word tagline reveal.
These are the skill's strongest "house style" opinions and they are mostly the 2024 SaaS template look DESIGN.md exists to avoid. The current page's flat 56 px bar, 150–240 ms easing and absence of scroll choreography are better for a "steady hands" brand. The one idea worth taking is B11's *content*: a large type statement of the core promise ("Many agents. One codebase. Nothing lost.") as its own moment mid page, static.

## Skill versus DESIGN.md: conflict list

| # | Skill says | DESIGN.md / PRODUCT.md says | Mockup follows | Better, and why |
|---|---|---|---|---|
| 1 | Hero heading text gradient (#fff→#9b9b9b) | No gradient text; the only orange is "land." | DESIGN | DESIGN. Gradient text is the most recognisable template tell; the single orange word is a brand asset. |
| 2 | Never a gradient background | `--hero-a/b` gradient allowed on the landing hero only | DESIGN, but the gradient is near invisible (#0b0e13→#161418) | Skill, marginally: flat costs nothing and loses nothing. Moot in practice. |
| 3 | Dark backgrounds only from #000/#181818/#1f1f1f/#272727/#313131/#131209 | Blue black #0b0e13 → #11151c → #161b24 → #1c2230 | DESIGN | DESIGN. Neutral greys are the skill's brand, not Forge's. |
| 4 | Font sizes only on Tailwind steps (12/14/16/18/20/24/30/36/48/60/72) | 11/12/13/14/20/28/44 in the app, 60 px display on the landing | DESIGN, landing body lifted to 16 | DESIGN for the app (dense operate UI needs 13). Skill's steps are fine for landing prose; both scales share 12/14/16/20. |
| 5 | Spacing only 0/2/4/8/12/16/24/32/40/48/64/80/96 | 4/8/12/16/20/24/32/48 | DESIGN plus 64/96 for landing sections | Mostly compatible. DESIGN lacks large section rhythm; add two landing only tokens. Skill lacks 20, which DESIGN uses for card padding. |
| 6 | Radii only Tailwind values; nested = outer − gap | 2/3/4/6/8/9/12 | DESIGN | DESIGN for the values (3 px tags and 9 px count pills are Forge signatures). Keep the skill's nested formula; it already agrees with the paste box. |
| 7 | One typeface per site; Geist Mono only for code | Manrope titles, system UI body, SF Mono code | DESIGN | DESIGN. The pairing is deliberate; Manrope for 13 px dense body would hurt readability. The skill's ban on Inter is moot (it is a system stack fallback). |
| 8 | Base curve cubic-bezier(.22,1,.36,1), 500 ms layout, hover ≥ 200 ms | `--fx-ease` (.2,.7,.2,1), 150/240/420 ms | DESIGN | DESIGN. 500 ms layout changes in an operate tool feel slow; 150 ms hover is normal for dense UI. |
| 9 | Floating, centred, translucent blurred nav bar | Flat 48/56 px top bar, lockup left | DESIGN | DESIGN. Backdrop blur is a paint cost on every scroll frame and is the single most generic landing trope. |
| 10 | Scroll reveals (rise 32 px, 600–800 ms) on every section | No bounces, no count ups; motion pauses offscreen; idle costs nothing | DESIGN (none) | DESIGN. Content that is already on the page should not hide and re-enter. |
| 11 | Mandatory tagline reveal with per word opacity animation | No count ups, no sparkle; reassurance belongs in docs | Static large type statement, no animation | DESIGN. Keep the section (it is where "Many agents. One codebase. Nothing lost." belongs), drop the word by word choreography. |
| 12 | Icons from Phosphor, Solar or Iconamoon | Forge `Glyph` set, status glyph language ● ◷ ✓ ✕ ⧉ | DESIGN | DESIGN. The six status glyphs carry meaning; a third party set would break them. |
| 13 | Main button 16 px semibold, 8 × 12 px padding | `.fx-btn-xl` 44 px, 14 px, 0 × 20 px | DESIGN height and padding, 16 px label | Mixed. 44 px height is a better touch target than the skill's 8 px padding yields; 16 px label is more legible on a hero. |
| 14 | Content realism: invent believable brand names, testimonials with full names, non round numbers | No customers, testimonials or benchmarks exist; do not fabricate | Owner | Owner, absolutely. For Forge this skill rule is a liability: it instructs the builder to fabricate. It should be struck for this project. |
| 15 | Risk reversal: free trial, cancel anytime, money back | No pricing, no trial, private alpha | Honest equivalents: open source, no account, Git in and out | Owner. The true risk reversals are better than borrowed SaaS ones. |
| 16 | No hyphens in copy | Vocabulary includes "Needs-you", "three-way merge", "open-source" in places | Avoided where natural; kept "Apache-2.0" and "three-way" | DESIGN / plain English. Compound modifiers need hyphens; the skill's rule reads as a typographic preference and should not override grammar. |
| 17 | Headline formulas ("The {category} for {audience}") | Tagline fixed: "Hand it off. Watch it land." | h1 tagline, definitional lead | Both: tagline as h1, the skill's formula as the first sentence under it. This also serves LLM readers. |
| 18 | Loading states as skeletons, never spinners | Skeleton at final height, ≤ 600 ms shimmer | Agree | Agree. The Importing view's progress bar already fits both. |
| 19 | FAQ with schema, meta title and description, og tags | Not specified | Skill | Skill. These are missing today and cost nothing. |
