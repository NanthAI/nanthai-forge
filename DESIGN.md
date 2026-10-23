---
name: "NanthAi Forge"
description: "Steady hands: a calm shift lead for people and coding agents changing one codebase. Who's working, what's changing, what needs you."
colors:
  # Dark theme (default). Implementation: web/src/style.css
  bg: "#0b0e13"
  surface: "#11151c"
  surface-2: "#161b24"
  surface-3: "#1c2230"
  hover: "#1a202b"
  line: "#222a36"
  line-strong: "#2e3746"
  text: "#e8ecf2"
  text-2: "#a3adbb"
  text-3: "#6f7a8a"
  brand: "#ff6b3d"
  brand-hover: "#ff865f"
  on-brand: "#17100b"
  accent: "#ff936e"
  accent-bg: "#2b1d17"
  focus: "#ff936e"
  active: "#6aaeff"
  active-bg: "#14233a"
  waiting: "#f2b84b"
  waiting-bg: "#2c2312"
  stale: "#7d8796"
  stale-bg: "#1a1f28"
  conflict: "#c79bff"
  conflict-bg: "#251a37"
  passed: "#5fd39a"
  passed-bg: "#12281e"
  failed: "#ff6f7a"
  failed-bg: "#311519"
  add-bg: "#0f2a1d"
  del-bg: "#2e1418"
  rail-off: "#2a3240"
  mark-warm: "#ffb347"
  mark-teal: "#23cbff"
  # Light theme
  light-bg: "#f4f6f9"
  light-surface: "#ffffff"
  light-surface-2: "#f8f9fb"
  light-surface-3: "#eef1f5"
  light-hover: "#f1f4f8"
  light-line: "#e3e7ed"
  light-line-strong: "#cfd6df"
  light-text: "#141a24"
  light-text-2: "#4f5b6b"
  light-text-3: "#606c7c"
  light-accent: "#b43a11"
  light-accent-bg: "#fff0e9"
  light-active: "#1f6fd1"
  light-active-bg: "#e8f1fd"
  light-waiting: "#9a6200"
  light-waiting-bg: "#fff4dc"
  light-stale: "#6c7686"
  light-conflict: "#7a3fc4"
  light-conflict-bg: "#f3ecfd"
  light-passed: "#1e7a4c"
  light-passed-bg: "#e6f5ec"
  light-failed: "#c42b37"
  light-failed-bg: "#fdecee"
  light-rail-off: "#dde3ea"
typography:
  display:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 730
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  h1:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  h2:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  situation:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  eyebrow:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI, Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.05em"
  mono:
    fontFamily: "SF Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  rail: "2px"
  tag: "3px"
  r-1: "4px"
  r-2: "6px"
  r-3: "8px"
  pill: "9px"
  r-4: "12px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "20px"
  s-6: "24px"
  s-8: "32px"
  s-12: "48px"
components:
  topbar:
    backgroundColor: "{colors.surface}"
    height: "48px"
  channel-strip:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text-2}"
    height: "32px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.r-3}"
  panel-header:
    padding: "10px 14px"
    height: "42px"
  button:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-2}"
    height: "30px"
    padding: "0 12px"
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.r-2}"
    height: "36px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
  button-rec:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.r-2}"
    height: "30px"
  button-ghost:
    textColor: "{colors.text-2}"
    rounded: "{rounded.r-2}"
    height: "30px"
  status-pill:
    rounded: "{rounded.r-1}"
    height: "20px"
    padding: "0 7px"
  count-pill:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "1px 6px"
  count-pill-hot:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.pill}"
  auto-tag:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.tag}"
  journey-rail:
    backgroundColor: "{colors.rail-off}"
    rounded: "{rounded.rail}"
    size: "73x4px"
---

# Design System: NanthAi Forge

This document records the design direction. The implemented tokens and shared components live in `web/src/style.css`; product principles live in `PRODUCT.md`. Review those source files when checking the rendered interface.

## Overview

**Personality: steady hands.** Forge is the calm shift lead who tells you who is on, what is moving and what is yours to decide, then gets out of the way. "Forge never surprises you, and it never loses anything." Delight comes from how little you have to do, not from how much the interface does.

Mode: **Operate** on every signed-in surface (scanability, consistency, one clear next action outrank expression); **Persuade** on the landing page only. Brand lives in precise details: the F mark, Manrope titles, the six-colour status language with glyphs, and the journey rail. These are Forge's and nobody else's.

Every page has the same skeleton: 48px top bar · 32px channel strip (`main · accepted 12 min ago by claude-3 · ✓ passing · ● Live`) · page head (crumb, h1 + status pill, one meta line, one `.situation` sentence, actions right) · content panels. Dense but calm: 13px body, 14px panel titles, generous 16px gutters, no decoration.

## Colors

### Primary
- **Brand orange** `--brand` `#ff6b3d` (both themes): the F mark, the single primary button per area (`.btn.primary`), the Needs-you count pill (`.count-pill.hot`), the active nav underline, "land." on the landing. Nothing else.
- **Accent** `--accent` (`#ff936e` dark / `#b43a11` light): text links, Undo, hover on situation links, focus ring, selected-row tint (`--accent-bg`).

### Status (the six-colour language)
| Token | Meaning | Glyph |
|---|---|---|
| `--active` blue | working, editing now | ● dot |
| `--waiting` amber | waiting for you, overlap, question | ◷ / ○ ring |
| `--passed` green | check passed, accepted | ✓ |
| `--failed` red | check failed | ✕ |
| `--conflict` violet | conflict, can't update from main | ⧉ |
| `--stale` grey | not seen, cancelled, superseded, done | — or ○ |

Each has a `-bg` tint for pills. Status is always colour + glyph + word. Syntax colours (`--syn-*`) are low-saturation and never reuse status meaning.

### Neutral
`--bg` page · `--surface` panels · `--surface-2` inset blocks/quotes/row groups · `--surface-3` tags, zero pills · `--line` borders · `--line-strong` emphasised borders, rails, map tracks · `--text` / `--text-2` / `--text-3` three ink levels.

### Named Rules
- **The One Orange Rule.** One orange (`--brand`) button per area. Recommended answers use `.btn.rec` (1px `--text-2` border, 600), never orange. Orange never signals status.
- **The Teal Quarantine.** `#23cbff` and `#ffb347` exist only inside the F mark.
- **No glow, no gradient in the app.** `--glow` only on the accepted toast and the newest Accepted-today row for 1.2 s. `--hero-a/b` gradient only on the landing hero.

## Typography

Manrope for h1/h2/h3 and the landing display; system UI for everything else; SF Mono stack for paths, code, commands. Tabular numerals (`.num`) for diffstats, ages, counts.

### Hierarchy
- **Display** 44px Manrope 730, −0.035em (landing only; 34px below 720px).
- **h1** 20px Manrope 700, −0.015em, one per page.
- **Situation** 15px/1.45 `--text-2`, leading clause `--text` 650; counts are links underlined in `--line-strong`, offset 3px.
- **h2** 14px Manrope 700 (panel titles, nowrap).
- **h3 / row title** 13px 650.
- **Body** 13px/1.45. **Meta** 12px `--text-2`. **Faint** 11–12px `--text-3`.
- **Eyebrow** 11px 600 caps +0.05em `--text-3` (or the status colour in decision items).
- **Mono** 12px.

### Named Rules
- **The Size Floor Rule.** Nothing below 11px. Nothing above 20px inside the app (28px reserved).
- **The Wrap Rule.** Lane, Intent, project and issue titles wrap to 2 lines max (`-webkit-line-clamp:2; overflow-wrap:anywhere`). Never ellipsise a title mid-word. Ellipsis only for paths in narrow chips, and then at the start of the path so the filename stays visible.

## Layout

- Full-width app pages with 16px side gutters (12px ≤720px). Settings and Home centre a 1160–1370px column (Settings: 220px nav + 820px content). Do not centre-constrain some project pages and not others: Now, Work, Intent, View, Lane and Code all use the same full-width frame.
- Now: three columns `Needs you 380 · What's changing 1fr · Who's working 300`, Needs-you first in reading order (left on desktop, top on mobile). Intent: work map full width, then `Lanes + What and why 1fr · Views + pointers 1fr`. View: composition strip full width, then `Changed files 1fr · Record 340`. Lane: decision banner (only when there is a decision) full width, then `Check + Changes 1fr · Timeline + Conversation 340`.
- Spacing scale `--s-1..12` (4/8/12/16/20/24/32/48). Panels separated by 16px; panel header padding 10px 14px; row padding 10px 14px.
- Panels size to content. No min-heights that leave empty boxes; empty panels collapse to one line.
- Breakpoints: 1060px (column headers and collapse controls hide), 720px (single column, bottom tab bar, brand text hidden). At 390px there is no horizontal page overflow ever; wide content (work map, diff) scrolls inside its own panel.
- Reserve space for late-loading panels (skeleton at final height, ≤600ms shimmer) so nothing pushes content.

## Elevation & Depth

Flat. Depth comes from surface steps (`--bg` → `--surface` → `--surface-2`) and 1px lines. `--shadow` (`0 12px 40px #0008` / `#1a22302a`) only on overlays: delegate sheet, popovers, peek card, toast. No shadows on panels, no inner glows.

## Shapes

Radii: 2px rail segments · 3px `auto` tags · 4px status pills, focus ring · 6px buttons, inputs · 8px panels, sheets, popovers · 9px count pills · 12px landing paste box only. Avatars: humans round; agents rounded-square (6px at 24px, 8px at 32px) with an `agent` tag. Left status rails on rows are 3px and carry status colour; they are a Forge signature, not decoration.

## Components

### Buttons
`.btn` 30px, 12.5px 550, `--surface-2`, 1px `--line-strong`, radius 6. `.btn.lg` 36px is the one primary per area (`--brand`, `--on-brand`). `.btn.rec` recommended answer. `.btn.ghost` text-only `--text-2`. Header action groups: at most two outline buttons + one ghost "More"; the primary, if any, is rightmost.

### Status pill (`.st`)
20px tall, 11.5px 600, radius 4, padding 0 7px, glyph + word, colour + `-bg` tint. Words: Working · Waiting · Ready · Check failed · Conflict · Accepted · Superseded · Cancelled · Done · Stale. One vocabulary across Now, Work, Intent, View, Lane. In lists the pill sits in a fixed-width column so titles align.

### Count pill (`.count-pill`)
11px 600, radius 9. `.hot` (orange) only for Needs-you > 0. Zero Needs-you renders `.needs.zero` (`--surface-3`, `--text-2`), never hidden.

### Journey rail (`.rail`)
Four 16×4 segments, gap 3, radius 2 (`.rail.lg` 48×6). Stops edited · saved · checked · accepted; fill follows the recorded edited, saved, checked and accepted states. Always has a `title`. Never a percentage.

### Panels (`.panel`, `.panel-h`, `.panel-f`)
Header 42px: h2 + count pill + right-aligned `.act` (link, (i), or collapse chevron). Footer 12px `--text-2` pointer lines ("2 waiting for your decision · in Needs you").

### Decision item (`.decision`)
Eyebrow in kind colour + age · title 13/650 · reason 12.5 `--text-2` (or `.gates` for ready-to-accept, `.quote` for questions) · 2–3 answers, first `.rec`, last `.ghost`, optional `.hint`.

### Lane row
Grid `minmax(0,1fr) 150px 73px 56px 44px`, gap 14, 3px left rail, min-height 62. Line 1: status pill + Lane name (wraps, never truncates). Line 2: Intent (only when it differs from context) + last fact. WHO: avatar + name, wraps; agent tag inline on one line.

### Work map (`.wm`) and composition strip
SVG tracks per Lane (2px), saves 10px hollow circles (filled when in a View, `--passed` when accepted), Views 22px rotated squares on a row above main, main 3px `--text-2`. Dense data must cluster (see QA rules); panel height fits the tracks.

### Channel strip, `auto` tag + Undo, away strip, toast, delegate sheet, (i), command chip, preset card, collapsible rails, diff modes, peek card
Use the shared implementations and tokens in `web/src/style.css`.

### Navigation
Top bar: F mark lockup · project switcher · Now · Work · Code · Settings (14px, orange 2px underline on active) · search · Needs-you pill · avatar. Work sub-nav: 28px segmented `.seg` Intents · Lanes · Views · Planning. Settings: left nav groups Project / Admin / You. Mobile: bottom tab bar Now · Work · Code · Settings.

## Do's and Don'ts

### Do:
- **Do** lead every page with h1 + one `.situation` sentence that says what matters.
- **Do** put Needs you first in reading order.
- **Do** show each item in full in exactly one place; elsewhere a pointer with a count.
- **Do** quote agents in their own words; show "seen 40 s", never "online".
- **Do** pair every automatic action with `auto` + Undo.
- **Do** use relative time ("12 min ago") with absolute time in the `title`.
- **Do** pluralise correctly ("1 Lane", "2 saves").
- **Do** collapse empty panels to a single quiet line ("Nothing needs you.", "No one yet.").

### Don't:
- **Don't** leave explainer or reassurance text on screen permanently (definitions of View/Lane, "advisory", "nothing is lost", "managed by the owner"). Use (i), "Why", docs, first run.
- **Don't** use orange for status, success, warnings or any count but Needs you.
- **Don't** show hashes, View ids, ISO timestamps or receipts outside "Exact record".
- **Don't** repeat the same text (title = Lane name = "What and why" = View "Why"); when a field equals its parent, hide it.
- **Don't** use icon-in-a-square + heading + paragraph empty states or feature grids in the app.
- **Don't** use emoji, exclamation marks, "AI", "successfully", "seamlessly", sparkles (except the away-strip icon), robot icons, gradient text, glows, skeleton shimmer > 600ms, bounces, count-ups.
- **Don't** truncate titles mid-word or let content overflow the 390px viewport.
- **Don't** invent visual styles that are not in `web/src/style.css`.
