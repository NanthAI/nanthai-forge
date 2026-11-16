---
name: "NanthAi Forge"
description: "Steady hands: a calm shift lead for people and coding agents changing one codebase. Edge-to-edge regions, a squared edge, one orange, six states, and a line that shows where every open Lane is."
colors:
  # Dark theme (default). Implementation: web/src/ds/tokens.css
  bg: "#0b0e13"
  surface: "#11151c"
  surface-2: "#161b24"
  surface-3: "#1c2230"
  hover: "#1a202b"
  line: "#222a36"
  line-strong: "#2e3746"
  key-edge: "#3a4558"
  rail-off: "#2a3240"
  text: "#e8ecf2"
  text-2: "#a3adbb"
  text-3: "#828d9d"
  brand: "#ff6b3d"
  brand-hover: "#ff865f"
  brand-edge: "#c2441c"
  on-brand: "#17100b"
  accent: "#ff936e"
  accent-bg: "#2b1d17"
  focus: "#ff936e"
  series: "#ff6b3d"
  act: "#ff6b3d"
  active: "#6aaeff"
  active-bg: "#14233a"
  waiting: "#f2b84b"
  waiting-bg: "#2c2312"
  stale: "#8a94a3"
  stale-bg: "#1a1f28"
  conflict: "#c79bff"
  conflict-bg: "#251a37"
  passed: "#5fd39a"
  passed-bg: "#12281e"
  failed: "#ff6f7a"
  failed-bg: "#311519"
  add-bg: "#0f2a1d"
  del-bg: "#2e1418"
  syn-kw: "#8fb4e8"
  syn-str: "#b9c98a"
  syn-fn: "#d6c08c"
  mark-warm: "#ffb347"
  mark-teal: "#23cbff"
  band: "#ff6b3d"
  on-band: "#17100b"
  on-band-2: "#4a2414"
  hatch: "#6f7a8a"
  # Light theme
  light-bg: "#f4f6f9"
  light-surface: "#ffffff"
  light-surface-2: "#f8f9fb"
  light-surface-3: "#eef1f5"
  light-hover: "#f1f4f8"
  light-line: "#e3e7ed"
  light-line-strong: "#cfd6df"
  light-key-edge: "#b9c2ce"
  light-rail-off: "#dde3ea"
  light-text: "#141a24"
  light-text-2: "#4f5b6b"
  light-text-3: "#606c7c"
  light-accent: "#b43a11"
  light-accent-bg: "#fff0e9"
  light-series: "#d4501c"
  light-act: "#d4501c"
  light-active: "#1a64c2"
  light-active-bg: "#e8f1fd"
  light-waiting: "#8a5800"
  light-waiting-bg: "#fff4dc"
  light-stale: "#5f6a7a"
  light-stale-bg: "#eef1f5"
  light-conflict: "#7a3fc4"
  light-conflict-bg: "#f3ecfd"
  light-passed: "#1e7a4c"
  light-passed-bg: "#e6f5ec"
  light-failed: "#c42b37"
  light-failed-bg: "#fdecee"
  light-hatch: "#7b8696"
typography:
  # One family, set by two tokens: --font-sans and --font-mono. Nothing else names a font.
  family-sans: "Atkinson Hyperlegible Next, system-ui, -apple-system, Segoe UI, sans-serif"
  family-mono: "Atkinson Hyperlegible Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
  micro: { fontSize: "11.5px", fontWeight: 500 }
  meta: { fontSize: "12.5px", fontWeight: 400, lineHeight: 1.45 }
  small: { fontSize: "13.5px", fontWeight: 400, lineHeight: 1.45 }
  body: { fontSize: "14px", fontWeight: 400, lineHeight: 1.45 }
  title: { fontSize: "14px", fontWeight: 700 }
  lead: { fontSize: "17px", fontWeight: 700, lineHeight: 1.3, letterSpacing: "-0.012em" }
  situation: { fontSize: "20px", fontWeight: 500, lineHeight: 1.3, letterSpacing: "-0.012em" }
  figure: { fontSize: "24px", fontWeight: 700, lineHeight: 1.15, letterSpacing: "-0.012em" }
  big: { fontSize: "clamp(21px, 2.2vw, 28px)", fontWeight: 700, lineHeight: 1.2 }
  mono: { fontSize: "0.93em", lineHeight: 1.65 }
  read: { fontSize: "16px", lineHeight: 1.6 }
  landing-body: { fontSize: "17px", lineHeight: 1.55 }
  landing-h3: { fontSize: "19px", fontWeight: 700 }
  landing-h2: { fontSize: "clamp(28px, 3.3vw, 48px)", fontWeight: 750, lineHeight: 1, letterSpacing: "-0.035em" }
  landing-statement: { fontSize: "clamp(30px, 4.6vw, 70px)", fontWeight: 750, lineHeight: 1, letterSpacing: "-0.035em" }
  landing-h1: { fontSize: "clamp(34px, 5.5vw, 82px)", fontWeight: 750, lineHeight: 1, letterSpacing: "-0.035em" }
rounded:
  none: "0"
  control: "3px"
  bar: "2px"
  landing-key: "8px"
spacing:
  s-0: "2px"
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "20px"
  s-6: "24px"
  s-8: "32px"
  s-12: "48px"
  s-16: "64px"
  s-24: "96px"
motion:
  ease-out: "cubic-bezier(.23, 1, .32, 1)"
  ease-in-out: "cubic-bezier(.77, 0, .175, 1)"
  press: "100ms"
  quick: "120ms"
  state: "200ms"
  colour: "240ms"
  pose: "320ms"
  ring: "500ms"
  travel: "600ms"
  stagger: "40ms"
  stagger-cap: "240ms"
  beat: "2400ms"
  beats: 3
components:
  topbar: { backgroundColor: "{colors.surface}", height: "48px" }
  rail: { backgroundColor: "{colors.surface}", width: "196px", widthCollapsed: "56px" }
  region: { backgroundColor: "{colors.surface}", rounded: "{rounded.none}" }
  region-header: { height: "40px", padding: "0 16px 0 6px" }
  row: { height: "40px", heightDense: "34px", heightLane: "54px", padding: "7px 16px" }
  button: { backgroundColor: "{colors.surface-2}", textColor: "{colors.text}", rounded: "{rounded.control}", height: "30px", padding: "0 11px" }
  button-primary: { backgroundColor: "{colors.brand}", textColor: "{colors.on-brand}" }
  button-recommended: { borderColor: "{colors.text-2}" }
  button-touch: { height: "40px" }
  input: { backgroundColor: "{colors.bg}", rounded: "{rounded.control}", height: "34px" }
  avatar: { rounded: "{rounded.control}", size: "20px" }
  count: { backgroundColor: "{colors.surface-3}", textColor: "{colors.text-2}", rounded: "{rounded.control}", height: "18px" }
  count-hot: { backgroundColor: "{colors.brand}", textColor: "{colors.on-brand}" }
  lane-mark: { size: "8px", sizeInYard: "16px" }
  kind-mark: { size: "16px" }
  act-edge: { width: "3px", backgroundColor: "{colors.act}" }
---

# Design System: NanthAi Forge

This document is the design authority: the look, the tokens and the rules for choosing each pattern. Product principles live in [PRODUCT.md](PRODUCT.md).

## Using the system

The implementation lives in `web/src/ds/`. `tokens.css` is the one token source for the public page and the app; `base.css` and the component sheets build on it; screens import components from `web/src/ds` and never copy CSS or write a literal colour, font, radius, duration or curve.

Everything is scoped to the `data-ds` attribute. The public page sets it on `<html>`. An app screen built on the system renders inside an element that has it (the shell frame sets it once). Screens not yet rebuilt keep the older styles (`web/src/legacy.css`, `web/src/ui/tokens.css` and the screen sheets) until their route is rebuilt; nothing new is added to those.

Interactive components (menus, dialogs and sheets, the palette, reorderable lists, moving a region) are built on React Aria Components behind the system's own components. Screens never import the library ([decisions](docs/decisions.md#2026-11-16-rules-for-the-phase-7-shared-base)).

- `parts.tsx`: keys, regions with folds that remember, bands, rows, chips, the phone tabs, tables, the Markdown and diff containers and the standing line. They need no library and draw at first paint.
- `interactive.tsx`: Menu, Sheet, Palette, ReorderList and Dock. Each draws its resting shape at first paint, then swaps in the behaviour layer (`behaviour/`, the only folder that imports the library) on the first press or focus, or after one idle fetch, with focus kept on the same control.
- The build fails if anything outside `behaviour/` imports the library, if a second behaviour, drag or motion library appears, or if the layer reaches the first-paint chunks or outgrows its budget (`scripts/ds-build-guard.mjs`). The layer keeps only its English messages.
- `figures.css`: yardsticks, the overlap ruler, charts, the access table and presence, money and figures, devices and holders, and the yard. These are class patterns without a component; a screen sets each figure's inputs (`--v`, `--a`, `--b`, `--h`, `--used`, `--full`, `--at` and the like) inline as numbers.
- `web/ds.html` is the reference surface, on the dev server only: one screen built from the parts, in both themes. `tests/ds-reference.test.mjs` checks it in Chromium: the reorder model and the dock by keyboard and by the handle's menu (the drop line, the screen and the announcement agree), a press made before the layer arrives, axe, and no sideways scroll at 1440 and 390 px in both themes.

## Overview

**Personality: steady hands.** Forge is the calm shift lead who says who is on, what is moving and what is yours to decide, then gets out of the way. Delight comes from how little a person has to do.

**Three ideas make the look.**

1. **Regions, not boxes.** A page is a set of regions that run edge to edge and meet at a one-pixel seam. Nothing is boxed; nothing sits in a container inside a container.
2. **The squared edge.** Controls have one 3 px corner. Regions, rows, menus, sheets and toasts have none. There are no pills.
3. **The yardstick.** A ruled line with stops or ticks and a mark on it. It shows where every open Lane is (the line in the top bar), where one Lane is (its five stops), which lines two Lanes share (the overlap view) and how much of a limit is used.

**Mode by surface.** The app is for finishing a task: scanning, consistency and one clear next action outrank expression. The public page is for deciding to try it and may be bold. Docs are for understanding. CLI output gives the state in one line each.

**Frames.** The **project frame**: the top bar (the mark, the project, the line, Needs you), the rail with six places (Needs me, Lanes, Plan, Code, Stats, Settings), then a page head whose sentence states the answer, then regions. The **account frame** is for what belongs to an owner and not one project (projects, billing, people and teams, sign-in and devices, your data): the same top bar with the owner where the project is and no line, and a rail of the account's places. The **bare frame** has no rail and no line; it is used only before a first project exists. Pages a signed-out person can reach (sign-in, a terminal's code, an invitation, one decision) are one column between two rules under a plain bar.

## Colors

### Surfaces and text
`--bg` the page behind regions and quiet regions · `--surface` regions, top bar, rail · `--surface-2` controls at rest, menus, command output · `--surface-3` the current nav item, counts, a pressed segment · `--line` the seam · `--line-strong` control edges · `--key-edge` the lower edge of a key · `--rail-off` the unreached part of a yardstick · `--text`, `--text-2`, `--text-3` three levels of ink. Depth is a surface step and a seam; `--shadow` exists only on things that float.

### Brand
- **`--brand`** is the F mark, the one primary action in a view, the Needs-you count, the edge of the current nav item, the drop line while moving a region or a row, and Forge's own measured series in a chart.
- **`--accent`** is orange that reads as text: links, Undo, the focus ring. `--accent-bg` is the selected row.
- `--mark-warm` and `--mark-teal` exist only inside the F mark.

Orange is never a state, a warning or a success; a second button in the same view; a recommended answer; or body text in the light theme (use `--accent`).

### State: six colours, each with a shape and a word

| Token | Means | Glyph beside the word | Mark on a line or track |
|---|---|---|---|
| `--active` | working: editing, saving, checking | filled dot | dot |
| `--waiting` | waiting its turn, or waiting for a person | clock | dot in the queue; ring when a person is needed |
| `--conflict` | two Lanes change the same lines | two overlapped squares | diamond; a dotted tie under a Lane that overlaps another |
| `--failed` | a check failed, a landing was refused | cross | square |
| `--passed` | check passed, landed | tick | the main tick |
| `--stale` | not seen, set aside, superseded | dash | lowered, then gone |

Each has a `-bg` tint, used in exactly two places: a notice bar across the page, and the one likely cause among several. A row is never tinted to say its state.

**Fixed words** (`stateWords` in `web/src/ds/marks.tsx`): Working, Saving, Checking, Waiting its turn, Needs you, Handoff, Conflict, Check failed, Landed, Set aside, Not seen. Items: Proposed (dotted ring) and Planned (ring) in the quiet colour; In progress shows its Lane's state; Done; Abandoned. Money: Paid (tick); Not paid, Card declined (cross); Refunded, Extra block, View only (dash); Limit near, Landings wait, Confirming, Card expires (clock). Secrets: To rotate (clock), No value (cross). Not run, Stopped, Signed out, Sign-in expired, No Lane (dash). Refused (clock while the session can still act, cross in its own terminal). Resume, Takeover and Handoff as reasons are words in ink, never coloured.

### Attention
- **`--act`** is the edge of the first stop and nothing else: the brand orange in the dark theme, `#d4501c` in the light (the brand orange is under 3:1 on white).
- **Weight inks** reuse the three ink levels by job: act and watch titles in `--text`, reference titles in `--text-2` with `--text-3` under them, on `--bg` (`--ref-surface`).
- **Kind inks** (`--k-lane`, `--k-item`, `--k-check`, `--k-session`, `--k-person`) are ink, not hues: a new hue would sit too close to a state hue to be told apart. A person's square is `--k-person` with initials in `--on-person`.

### Contrast
Text is at least 4.5:1 on every surface step and on a selected row, in both themes; a filled shape that carries meaning is at least 3:1; seams and unreached track are decoration and exempt. `tests/design-tokens.test.mjs` checks every pair from the token file.

### Named rules
- **The One Orange Rule.** One primary action per view. The recommended answer is the outlined key, never orange.
- **The Mark Quarantine.** The mark's warm and teal never leave the mark.
- **State stays out of charts.** A series is brand orange (Forge, measured), hatched grey (an estimate) or ink. The one exception is a failure inside a run strip or a row of shards.
- **No glow, no gradient, no blur** in the app.

## Typography

**Atkinson Hyperlegible Next with Atkinson Hyperlegible Mono**, self-hosted, set by `--font-sans` and `--font-mono` and nothing else.

| Token | Size | Use |
|---|---|---|
| `--t-micro` | 11.5 px | the floor: phone tab labels, axis ticks, key caps, the proposed mark |
| `--t-meta` | 12.5 px | meta lines, hints, state words, table heads |
| `--t-small` | 13.5 px | secondary text, menus, key and value lists |
| `--t-body` | 14 px | rows, controls, running text |
| `--t-title` | 14 px, 700 | a region's title |
| `--t-lead` | 17 px, 700 | a decision's title, an empty state's title |
| `--t-sit` | 20 px, 500 (18 on a phone) | the page sentence; the answer inside it is 700 in full ink |
| `--t-figure` | 24 px, 700 | a number that is the answer |
| `--t-big` | 21 to 28 px, 700 | one decision shown alone |

The app scale is fixed in pixels. The public page and docs scale is fluid: docs body 16 px at 1.6; landing body 17 px; h3 19 px; h2 28 to 48 px; statement 30 to 70 px; h1 34 to 82 px; display weight 750 at −0.035em, line height 1.

- **Weights:** 400 text, 500 the page sentence, 600 labels and row titles, 700 titles, 750 landing display only. Emphasis is weight, never italics or colour.
- **The Floor.** Nothing below 11.5 px.
- **Numbers:** tabular wherever a number can change or be compared; counts, times and line numbers in the mono at 0.93em; formatted for the person's locale.
- **Measure:** page sentence 74 characters, prose in a decision 72, docs 68, landing lede 58, a note 46. Rows and tables use the full width; running text never does.
- **Tracking:** −0.012em on the page sentence, decision titles and figures; −0.035em on landing display; 0 elsewhere. Never tracked capitals; labels are sentence case.
- **The Wrap Rule.** Titles wrap to two lines and are never cut mid-word. Handles cut with an ellipsis and keep the full handle in the label. Paths cut at the start so the file name stays. An answer on a key wraps inside the key. Numbers, times and amounts are never cut.

## Layout

- **Space** is a 4 px step: 2, 4, 8, 12, 16, 20, 24, 32, 48; 64 and 96 on the public page only. The gutter inside every region is 16 px; the page head's is 20 px (16 on a phone).
- **Shell:** top bar 48 px, rail 196 px (56 px as icons), region header 40 px, phone tab bar 58 px. Fixed chrome stays under 100 px of height before content. One scroll area per region.
- **Density:** a row is 40 px; 34 px dense when a list shows more than about 20 rows; 54 px for a Lane with two lines. Controls are 30 px (26 small, 44 large), inputs 34 px.
- **Window breakpoints:** at 1240 px the rail shrinks to icons. At 860 px the page is one column, the rail becomes four bottom tabs and More, and the line moves to its own row under the top bar.
- **Region breakpoints** (container queries, because regions can be moved): 900 px a yard stacks each label over its track; 700 px a Lane row stacks; 560 px a matrix stacks; 520 px the overlap ruler stacks; 420 px.
- **Phone:** every control is at least 40 px tall; inputs are 16 px type; key caps are hidden and nothing depends on them; the tab bar pads for the safe area; the page never scrolls sideways (wide content scrolls inside its own region); what needs a person comes first.
- **Public page:** full-width sections, content capped at 1280 px, gutters 16 to 48 px, one claim and one proof per section; checked at 1440, 1024, 768, 390 and 320 px.
- Space is reserved for anything that loads late; nothing arriving pushes content down.

## Elevation & Depth

Flat: four surface steps and one-pixel seams. A shadow only on a menu, a sheet, a toast, and a region or row while it is dragged.

## Shapes

3 px on every control (buttons, key caps, inputs, switches, avatars, counts, tick boxes, the focus ring); 0 on regions, rows, menus, sheets, toasts and notices; 2 px on the top corners of a vertical bar; 8 px on the public page's key and nowhere else. A key has a 2 px lower edge and moves down 1 px when pressed. Avatars are squares with initials: a person filled, an agent outlined. A Lane's mark is 8 px on the line and 16 px in the yard.

## Motion

**In the app, something moves only because a state changed, and it moves once.** The public page may loop, because there the motion is the explanation.

**One exception:** the edge of the first stop beats, opacity only, three times over 2,400 ms each (`--beats`, `--d-beat`) when a thing starts to wait on the reader, when the page is shown and when the reader comes back to the tab (`useFirstStop`). Then it holds. It never loops, runs no timer and causes no request; with reduced motion it does not beat.

| Token | Time | Use |
|---|---|---|
| `--d-press` | 100 ms | a key going down |
| `--d-quick` | 120 ms | hover colour, a disclosure turning |
| `--d-state` | 200 ms | a switch, a toast, a mark appearing |
| `--d-colour` | 240 ms | a state colour changing |
| `--d-pose` | 320 ms | a shape changing in place |
| `--d-ring` | 500 ms | main ringing once on a landing |
| `--d-travel` | 600 ms | a Lane's mark gliding to its next stop; a moved region settling |
| `--stagger` | 40 ms, capped at 240 ms | marks changing in the same update |

- **Curves:** `--ease-out` for everything in the app; `--ease-in-out` for public-page scenes only. No bounce, no overshoot, no shake.
- **Never in the app:** entrances, staggered lists, counting numbers, skeleton shimmer past 600 ms, or any animation on a key press that repeats all day.
- **Only transforms and opacity** are animated, as CSS transitions; no script per frame and no motion library. No request is caused by motion.
- **Interruptible:** anything that gets a new target while moving turns toward it from where it is.
- **Reduced motion:** every change is instant; shape and word still carry the state (`base.css` removes every transition and animation under `[data-ds]`). On the public page the hero shows one still and charts are drawn complete.
- **Hidden tab:** nothing is drawn. On return there is one catch-up to the current state.
- **Calming down:** the mark in the app halves its rate after 60 s without input and holds its still after 5 minutes.
- **Public page:** the hero never stops while visible (after 60 s without input it may draw at half rate; it stops off screen, in a hidden tab or under reduced motion); charts draw once as they come into view; one frame loop at 30 frames a second, loaded after first paint, no server calls.

## Brand mark states

The F mark is alive. It is the only animated brand element, it is built from the letter's own pieces, and it never carries a message on its own: every state is also shown by a status pill, glyph and word beside it. Source of truth: `web/src/shell/mark.css` and `web/src/shell/brand.tsx` (64 geometry) plus the 16 px cut.

### The pieces
- **Stem** is main (ink, `currentColor`), split below the lower arm.
- **Arms** are landed Lanes (`--brand`), each an inner part and an outer chamfered tip.
- **Crossings** (warm `#ffb347` above, teal `#23cbff` below) are where Lanes joined main. Colour enters the F here.
- **Sparks** are the only extra element: at idle, and one thrown by every landing.
- Nothing else, ever: no bars, dots, gauges, faces, rings or seams. When a state needs a signal, a piece of the F becomes it.

### The tide rule
1. Rest colours are fixed: ink stem, orange arms, warm and teal crossings. Every state begins and ends there.
2. A status colour enters the F at a crossing and flows outward piece by piece, 80 to 120 ms per piece. It never appears on a piece it did not flow to.
3. While in motion, a status colour may take any piece, including the stem, up to the whole F (landing, the streak, the re-forge).
4. A still (reduced motion, or the end pose of a one-shot) holds status colour on at most the crossing plus the one arm that changed. The stem is never a solid status colour in a still. Failed holds red on the lower crossing only; the arm stays orange because the work is intact. Landed's still is the whole approved F with the crossing and lower arm green, so the only state whose shape equals idle is the one that means "back to normal".
5. Orange never means a status, and no status colour is decoration: a colour change always comes with a shape change on the same piece, so a colour-blind user reads every state from the shape and the glyph beside it.
6. Status colours keep their meaning: blue working or checking, amber overlap or waiting, green landed, red failed, grey rolled back.

### The strike (house motion)
Every one-shot has three beats; every loop is the first beat stretched. **Anticipation** (120 ms): the piece pulls away from where it is going. **Impact** (100 ms): it slams home, the crossing flashes, the stem rings (scaleX 1.14, 500 ms), status colour enters at the crossing. **Settle** (400 to 600 ms): strong ease-out `cubic-bezier(.23,1,.32,1)`, no bounce; colour floods outward, holds, later drains. When a landing does not take, impact is replaced by contact: the join goes red, no flash, no ring.

### States: pose and meaning
| State | Pose | Means |
|---|---|---|
| idle | the approved F; one spark runs along the top arm into the stem every 8 s | nothing is moving; main is steady |
| working | the lower tip reaches (scaleX 1 → 1.25); a blue tide runs tip → inner → crossing → back, 2.4 s | one agent is editing in a Lane |
| working, many | both arms reach out of phase (2.4 s and 3.1 s); the stem takes a faint blue where the tides meet | several agents are editing |
| checks | the lower tip detaches and goes round the inner arm, blue, 2.4 s | checks are running |
| overlap | the arms close until they touch and become one flag; amber breathes through it | two Lanes touch the same files |
| waiting | the top tip lifts off (−6 px, −8°) and hovers, amber tip and crossing | a Lane is waiting for you |
| queued | the lower arm waits short (scaleX .55) and inches forward every 2.4 s; its tip a step apart | a Lane is waiting for its turn to land |
| landing | the strike: pull back 6 px, slam into the stem, flash, ring; green floods inner, tip, stem, top crossing, top arm (400 → 900 ms) | a Lane is landing on main |
| landed | the whole F holds green 600 ms, drains to rest leaving the crossing and lower arm green; at 1.3 s one spark leaves the crossing and runs down main | it landed; main moved |
| failed | "didn't take": pull back, contact (the lower crossing goes red in 80 ms, no flash, no ring), the arm and its crossing are pushed back out 16 px and rest in line, whole and orange | the landing did not take; the work is whole |
| rolled back | "set aside": the arm and its crossing leave main as one piece (16 px), then are lowered 18 px to the foot; the crossing grey | a landing was taken out of main on purpose; the work is kept |
| paused | the whole F lies on its side (−90°); crossings at 60 %; nothing moves | the project is paused |

Loops: idle, working, checks, overlap, waiting, queued (slowest 8 s, fastest 2.4 s). One-shots that hold: landing, landed, failed, rolled back. No motion: paused. Transitions between poses: 320 ms on transform, 240 ms on colour, from wherever each piece is; a one-shot may be interrupted at any time.

### Motion rules
- Tilt is allowed only for paused (the lie-down) and the raised waiting tip (−8°). No other state rotates the letter; nothing ever forms a cross, an X or a circle-with-cross.
- No bounce, no overshoot, no shake, no pop, no glow. Settles are strong ease-outs to 100 %.
- Calming down: after 60 s in a looping state every period doubles (the `--calm` multiplier); after 5 min the still pose holds and the glyph beside the mark carries the state alone. A state change resets the clock.
- Paused when the tab is hidden and when the mark is off screen. No JavaScript per frame; the state is a `data-state` attribute.
- Reduced motion: every state is its end pose, still, and every change is instant. The base rule of each state is its still; animation only adds movement. Every still differs from idle in shape, not only colour (landed excepted, by rule 4). A user may opt in to full motion over the OS setting (`.mk-motion-full` on the root); the product never opts in for them.

### Delight (plays once per event, never loops, never always-on)
| Moment | Threshold | What happens |
|---|---|---|
| first landing | once per project | the F assembles: arms fly in 180 ms apart, crossings colour on contact, the stem flashes once |
| every landing | each | the strike throws one spark down main |
| second idle spark | 10 landings | idle shows two sparks, never in step |
| third idle spark | 100 landings | three sparks |
| streak | 5 clean landings in a row | one green wave runs through all six pieces and leaves (1.3 s) |
| many | 3 or more Lanes land in one batch | both arms strike 90 ms apart; one swell; green floods the whole F |
| the re-forge | the 1,000th landing | every piece flies apart, turns, comes home; stem flash; one green wave (2.9 s) |

Counters are per project and local to the browser. No server call, nothing stored about people.

### Favicon and app icon
The favicon is the still 16 px cut and never follows state (a state-driven favicon is a notification by another name). The 16 px cut is a separate pixel-aligned drawing: stem 3 px, arms 3 px, crossings 3 × 3, the spark 1 px; in the app (top bar, loaders) every 16 px move is a whole-pixel step with stepped timing. The 32 px cut is the 64 geometry scaled. App and touch icons use the 64 geometry at rest.

### Terminal (nforge)
On a TTY, nforge shows one frame per Lane row, cycled at 550 ms while the state is live; one-shots run their frames once and hold the still. Frames are plain Unicode box drawing and block elements; the glyph and word always follow the frame; colour is ANSI where supported. Logs, JSON and piped output get the ASCII still form.

| State | Frames | Still | Log |
|---|---|---|---|
| idle | ┣━━ · ┣━━ · ┣━· · ┣·━ · ┣━━ | ┣━━ | `\|--` |
| working | ┣━━ · ┣━━━ · ┣━━━━ · ┣━━━ | ┣━━━ | `\|-->` |
| working, many | ┣━━ ┣━━━ · ┣━━━ ┣━━ · ┣━━━━ ┣━ | ┣━━ +2 | `\|--> x3` |
| checks | ┣━╸ · ┣━╹ · ┣╹━ · ┣╻━ · ┣━╻ | ┣━╹ | `\|..` |
| overlap | ┣━━ · ┣═━ · ┣══ · ┣▀▀ | ┣══ | `\|==` |
| waiting | ┣━▀ · ┣━▔ · ┣━▀ · ┣━━ | ┣━▀ | `\| --` |
| queued | ┣━ ╸ · ┣━╸ · ┣━ ╸ | ┣━ ╸ | `\|-- ..` |
| landing | ┣━━ · ┣ ━━ · ┣ · ┃ · ┣━━ ✓ | ┣━▸ | `\|>` |
| landed | ┣━━ ✓ · ┢━━ ✓ · ┣━━ ✓ | ┣━━ ✓ | `\|-- ok` |
| failed | ┣━━ · ┣ ━━ · ┣━━ · ┣  ━━ · ┣  ━━ ✕ | ┣  ━━ ✕ | `\|-x` |
| rolled back | ┣━━ ✓ · ┣ ━━ · ┣  ━━ · ┃  ▁▁ ↺ | ┃  ▁▁ ↺ | `\|<-` |
| paused | ┣━━ · ━┻━ | ━┻━ | `:--` |

Delight prints once, never on a loop (first landing, streak, many, 1,000th).

### Cost budget
Client-side only: one inline SVG and one CSS file, no per-frame script, no timers while idle, 0 extra requests, 0 server calls at idle and at every state change (state comes from counts the top bar already has). Shipped CSS ≤ 24 KB uncompressed (≤ 6 KB gzipped), each SVG ≤ 1 KB. The CLI ticker runs only on a TTY and only while a state is live.

Reference page (every state at 512, 64, 32 and 16 px, the stills, CLI frames and motion spec): `design/hearth/index.html`, with `mark.svg` and `mark-16.svg` beside it.

## Components

Each is a component or class in `web/src/ds/`; the class names below are what the system's own components render.

- **Page head** (`.head`): a short crumb, then the sentence that is the answer. Filters and the agent's command sit to the right.
- **Region** (`.region`, `.ph`, `.pf`): a header with the handle (six dots), title, count and one faint hint that says how the list is ordered; a footer is one quiet line that points somewhere.
- **Band** (`.band`): a small bold label with its count that groups rows inside one region. It sits on space, with no line above it.
- **Row** (`.row`, `.th`): a grid line with a seam under it; `.sel` is the selected row; `.dense` is 34 px.
- **Keys** (`.btn`): `.primary`, `.rec` (recommended answer), plain, `.ghost` (the way out), `.danger` (red words, never first, never the default), `.sm`, `.lg`, `.wrap`. `kbd` shows the key that does the same.
- **Choices:** segmented choice (`.seg`), switch (`.sw`), input (`.inp`), tick box (`.ck`), a choice of one written out (`.row.choice`).
- **State** (`State`, `.st[data-st]`): glyph and word in the state colour, no background. **Kind mark** (`KindMark`, `.km[data-k]`).
- **Who** (`Who`, `Avatar`): square initials and a handle in mono; a team (`.av.tm`), a device (`.av.si`, dashed) and nobody (`.av.none`).
- **Count** (`Count`; hot only for Needs you above zero), **Proposed** (`.prop`), **Sample data** (`.sample`).
- **Command chip** (`.cli`) and its output (`.cli-out`); the command block (`.cmd`), a check's output (`pre.out`), the transcript (`.term`, docs only).
- **Decision** (`.dec`): what holds it, how long, where on the five stops; a title that asks the question; the reason; two or three written-out answers, the recommended one first; one way out.
- **Notice** (`.notice[data-st]`): one bar across the page that stays until it is true no longer.
- **Menu, toast, sheet:** the only floating things. A sheet sits on a scrim, centred on a desktop and at the bottom edge on a phone, with a scrolling body and a foot.
- **Frames:** project, account, bare, and the public bar and column.
- **Between sibling pages:** the section strip (`.strip`) and a place's own column (`.pnav`).
- **A long list:** the toolbar with find, filter chips, the bulk bar, the pager.
- **Changes and history:** a setting's before and after, a step with who did it, a timeline row, loading rows, quick reasons.
- **Access and presence:** the access table (teams, then people with their devices folded inside), a session row, a device and its sign-in line, who holds a Lane and each change of holder.
- **Items:** the roll-up, the next label, the drop line for a row, two versions of prose.
- **Reviewing:** a changed file with its reason line, a note on a line, whose line it is, two sides, the suspects of a failed check, the checked list, where a fact came from.
- **Money and figures:** the table (stacked on a phone), a statement, a row of figures, a facts line, the recommended row's label.
- **Yardsticks:** the line, five stops, the five-notch miniature, the amount stick, a Lane's track, a version notch, shards, the overlap ruler, the pool, the range stick, a limit across bars, the two ends, who waits on whom, the yard.
- **Charts:** vertical bars, a split bar, a run strip, a legend.
- **Code and diff** (`.code`), and the Markdown container for prose.
- **Attention:** a weight (`data-weight`), the first stop, a folded region or group, a one-line decision, where the project stands (`.pstate`).

## Decision rules

Each rule ends in "use this, not that".

### Regions, not boxes
1. **Rule, space, band or nothing?** Different regions get a seam. Rows in one list get a seam each. Groups inside one list get a band. Parts of one thought get space only. A thing and its own label get nothing. *Use* one surface with a band per group and a seam per row. *Not* a rounded card with cards inside it.
2. **A tint is a message.** A region is `--surface`; a region that is only context is `--bg`; the selected row is `--accent-bg`. *Use* shape and word for a row's state. *Not* a tinted row.
3. **Dock or fixed frame?** If the regions answer separate questions, the page is a dock (a full-width row, a left column, a right column) and its regions can be moved. If one region drives another, the page is a fixed frame. Docks: Needs me, Lanes, Stats. Fixed: a Lane, a check, Code, Plan, Settings, sign-in. A new page with three or more independent regions is a dock by default.
4. **Moving a region or a row.** One model everywhere: drag the handle (an orange line shows where it lands; Escape cancels); or focus the handle and press Enter to pick it up, arrow keys to choose the place (Tab carries a region to the other column or the full-width row), Enter to drop and Escape to cancel; or press the handle's menu (move to top, up, down, bottom; for a region also to the other column or full width), which is the direct way and the way on a phone. The arrangement is saved per person and per page. **Reset layout** is in every region's menu, in the toast after each move beside Undo, and as a quiet button in the page head while the layout differs from the default.

### Lists, tables, trees and boards
5. **Which one?** In this order. **A list** when each thing has one name and a little context and a person acts on one at a time (the default). **A table** when people compare the same fields across things, or the cells are controls. **A tree** only when things really contain each other and the path matters; one tree per page. **A board** only when the columns are a fixed sequence every thing passes through and moving between them is the main act. *Use* a board as lists side by side: columns meet at seams, things are rows. *Not* floating cards in boxed columns.
6. **A table, drawn.** The first column is the name and the only link. Numbers are right-aligned and tabular. One header row that sticks; at most seven columns. One action shows per row; the rest are in a menu. Selecting rows reveals the bulk actions with the count; "select all" beyond what is shown is an explicit second step. Sort and filters live in the address. On a phone a table becomes stacked rows.
7. **A long list.** Past about 20 rows a list gets a toolbar: find on the left, one chip per filter (a set filter is solid and removable; an offered one is dashed and says "any"), the count on the right, all of it in the address. The page sentence carries the totals. Ticking rows swaps in the bulk bar on the selected tint, inside the frame; "tick all that match" is a second step; one confirmation covers a batch and names the total loss. Pages where people return to a row or act on many get a pager; live presence and feeds get "show more". *Use* "37 of 400 people" beside two chips. *Not* endless scroll, a floating bulk bar, or filters behind an unmarked icon.
8. **Between sibling pages.** The six places: the rail. The sections of one place: the strip. Saved views and groups of one place that are also drop targets: the place's own column, one per page, a picker on a phone. Things that contain each other: a tree. Views of the same rows: the segmented choice. *Not* tabs inside a region, or a second rail.
9. **One thing, one place.** A thing is shown in full in one region; elsewhere it is a line that points there. *Use* "2 waiting for your decision, in Needs you". *Not* the same decision drawn twice.

### Charts and yardsticks
10. **Number, yardstick or chart?** One value: the number with its unit and what it is compared to. A position or an amount against a limit: a yardstick. Two to about thirty values of one kind: vertical bars, value on top, zero at the bottom, one scale. Parts of one total: one split bar. Many passes of one thing: a run strip, failures taller. Where two things touch: the overlap view. *Use* "286 of 300" over an amount stick. *Not* a pie, a gauge, a dual axis, a rounded progress bar, bars on their side, or a line through fewer than about twenty points.
11. **Which yardstick for an amount.** One value against a limit, in a row or the rail: the amount stick. The month against the plan, once per page at full width, with named stops and the estimate hatched: the pool. Used, expected (lower bound hatched, upper bound dashed) and a limit on one line: the range stick. A limit across vertical bars: one dashed line, named in the legend. How far apart two copies are: the two ends. Who waits on whom: a line with two ends. Progress of a set of things: the roll-up, one tick per thing, never a percentage.
12. **Colour in a chart.** Forge's measured figure is the series colour. An estimate is hatched grey; its upper bound is a dashed outline. Everything else is ink, the current one in full ink. Every chart prints its values, has a legend when there are two series, and offers the same figures as a table.
13. **A timeline** is a list, newest first, clock time first in mono, with a notch across it for a version or a day. A drawn horizontal timeline is used only for the five stops of one Lane.

### Status and state
14. **Shape, word and colour together.** *Use* a glyph and a word in the state colour. *Not* a coloured dot alone, or a tinted pill.
15. **Held work says where and why:** what holds it, for how long, and where on the five stops, in one line. An unknown fact is written **not reported**, never guessed and never blank.
16. **Asked ahead is listed, not counted.** A request an agent makes before it is stuck sits in its own band under what holds work, says "holds nothing yet", and has a plain count. The Needs-you number counts only what holds work; a request joins it the moment it does.

### Actions
17. **Which button?** Primary: at most one in a view, and only when the view exists to do that one thing. Recommended answer: the outlined key, first. Plain keys for other answers. Ghost for the way out. Destructive: red words on a plain key, never first, never the default. *Use* "Retry shard 5", "Abandon the landing", "Later". *Not* "Confirm", "Continue", "Cancel".
18. **Undo first, confirm rarely.** If it can be undone, do it at once and offer Undo in a toast for 10 seconds. If it can be recovered later, send it somewhere it can come back from and say where. Only if it truly cannot be undone, ask first, naming the thing and what is lost, with the safe answer as the default; for a whole project the person types its name. Archive and delete are different words and different controls. A bulk that cannot be undone shows the whole list, lets the person keep any out and has them type the count. *Use* "Closed 12 Items. Undo". *Not* "Are you sure?"
19. **Closing with something open is one press.** Quick reasons as small keys ("Not needed", "Done elsewhere", "Out of scope"); one press closes with that reason and Undo. Moving the open part to a follow-up is offered beside them and never required.
20. **Which control for a choice.** Done or read: a tick. On or off, applied at once: a switch. One of a few short words: the segmented choice. One of a few answers that are sentences or carry a consequence: rows with the squared choice mark, the chosen row on the selected tint, its consequence under it. *Not* a round radio, or a select hiding three sentences.
21. **Keys.** Every answer in a decision has a letter shown on its key. Number keys go to the six places. One key opens go-to-or-run (the palette; Enter on an empty search runs nothing); one lists every key. Arrow keys move through rows and move a focused region or row. A key press never animates.
22. **Give this to your agent.** On a page, the dashed chip in the page head holds the command that gives an agent what the page shows; pressing it opens the output in place. For a task, one button, "Give this to your agent", copies a short prompt; its label reads "Copied" for two seconds, and the full text is one disclosure away. Said once per screen. Wording not in the docs carries the proposed mark.

### Empty, loading, error, offline, worst case
23. **Which empty?** Never had any: say what will appear and give the one action that makes the first. Had some, none now: one quiet line. Filtered to none: name the filter and offer to clear it. Could not load: say so, keep what was last shown, offer Retry. *Use* "Nothing needs you." *Not* an icon in a square above a heading above a paragraph.
24. **Loading.** The shell and page head draw at once. Under 100 ms show nothing. After about 300 ms, still grey bars at the height of the rows to come, six at most. A refresh keeps the old rows on screen. A button that started something says so in its own label.
25. **Errors.** Say what happened in the product's words, why if known, what to do, and that the work is safe when it is. One field: under the field. Blocks the task: a notice bar that stays. Passing and harmless: a toast. Nothing can draw: a full page that keeps the shell. *Not* "Something went wrong."
26. **Offline** is one amber notice, said once. What is on screen stays; changes wait on the device; coming back says how many were sent.
27. **Worst-case data is a required drawing:** a 60-character handle and a one-letter one; a title in another script, one right to left, one of a single character; an emoji-first handle; a queue of 1,284; 50 open Lanes; a file of 12,840 lines and of one; a count of exactly 1 and exactly 0; a missing optional field; for anything that lists people, 400 people in 25 teams with 1,200 devices; for anything that lists devices, a 40-character name, no name, a one-character code and a right-to-left name. Initials are taken by grapheme. A count says "1 Lane".

### Words
28. **The voice.** Plain, short, present tense: fact, consequence, next step, with names and numbers. Forge's own terms: Lane, save, check, land, main, Item, Initiative, hand to, set aside, needs you, seen. Never: merge request, pipeline, job, bot, assistant, AI, sync, successfully, seamlessly, powerful. No exclamation marks, no emoji. Relative time, exact time on hover; "seen 40 s ago", never "online". *Use* "2 Lanes need you." *Not* "Welcome back! You have pending items to review."
29. **No standing explainers.** A line stays on screen only if it changes the decision in front of the person now. Explanation goes to a hover or an (i), to the first run, or to the docs.
30. **Honesty marks.** *Sample data* on every invented figure in a mock. *Proposed* on any command or reply not in the docs. *Not reported* for a fact Forge was not told. *At least* and *up to* for an estimate, lower bound first. Beside any figure Forge did not measure itself, where it came from is a word: *reported by your CI*, *reported by the agent*, *declared, not verified*, *run by Forge*; never a colour. A reason that orders a list is a fact with a number or a name, never "high risk".
31. **Which mono block.** The page's own command and its reply: the dashed chip and its output. A check's output, as it came: the output block. A command or prompt a person copies: the command block. Several turns of a conversation: the transcript, in docs and covers only.
32. **Identities are public handles only:** `@handle` for a person, `person/agent` for an agent. Never a real name, an email or a machine name. A device has a name and a code: the name is given once by its person, shown only to that person, quoted, and grants nothing; the code comes from the device's key and is what everyone else sees.

### People and agents
33. **How each is shown.** A person is a filled square and `@handle`. An agent is an outlined square and `person/agent`, because an agent acts for a person and never has more access than they do. The agent's app is plain text after the handle, only when the agent reported it. An agent's words are quoted exactly, behind a thin rule. *Not* a robot icon, a sparkle, or an "AI" tag.
34. **The same action for both.** Anything a person can do on a screen has a command an agent can run, and the reverse. What only a person can do is shown to that person as soon as an agent is heading there, with the one press that unblocks it. An agent's question with fixed answers is a decision; free conversation stays in the agent's own app.
35. **Access belongs to people, teams and devices, never to a session.** The access table lists teams first (people inherit, and an inherited answer names its team), then people, with each person's devices folded inside them. A device can only narrow what its person may do; landing without a check is never offered to it. There is no list of agents in Settings.
36. **A device and its sign-in are two things.** A device is a stable record (its key, the code from that key, the name its person gave it, its settings); its approval ends only when it is removed. A sign-in is the 30-day credential on it, renewed while in use. *Use* one row per device with the sign-in as a line under it. *Not* a row per sign-in, or "expires in 3 days" as a warning on a device in use. Ending it has three strengths, each confirmation naming how many sessions stop: stop one session; sign a device out (it comes back with one press); remove a device (approved and named as new).
37. **A session is live presence.** One thread in an agent app is one session, named from the app's own thread id. Sessions appear where the work is (Lanes, the top-bar line, activity), grouped by person, device and app; one with nothing for 30 minutes folds into activity. Stopping one is a live action on its row and can be undone.
38. **Work identity is the Lane, and it never changes hands silently.** One session holds a Lane at a time, shown in one line: session, app, device, since when. Every change of holder (Resume, Takeover, Handoff) is a row in the Lane's history with who, from whom and why. A refusal always says that nothing was saved and where the changes are.
39. **At the scale of hundreds.** The page sentence carries the totals. Teams come first; people are found by search and filters; lists are paged; devices stay folded; a batch has one confirmation.

### Attention: what needs the reader first
40. **Three weights.** Everything on a screen is one of three, and says so with `data-weight`.

| Weight | Use when | Title | State | Links | Surface | Motion |
|---|---|---|---|---|---|---|
| **Act now** (`act`) | it holds work until this reader answers | full ink, 700 | glyph and word in colour; a Lane's whole track | accent | region, with the act edge | the first stop beats 3 times |
| **Watch** (`watch`) | it is open and moving, or planned, and needs no answer | full ink, 500 | glyph and word in colour; on a track only the mark | ink, ruled under | region | none |
| **Reference** (`ref`) | it has happened, is settled, or is only a proposal | second ink, 400 | glyph in colour, word in ink | ink, ruled under | page | none |

Pointed at or focused, a reference row returns to full ink and its state word to colour. *Use* weight to say whose move it is. *Not* weight to say what matters to the product, and never a weight inside another weight.

41. **One first stop per screen.** What waits on the reader comes first in the reading order (top of the left column, first on a phone) and is the only thing with the act edge, one rule from the band's label to its last row. Its count is the orange count, the same number as Needs you in the top bar. Nothing waiting: no edge anywhere, and the page sentence says so. *Use* one edge for the whole group. *Not* an edge per region, a tinted block, a second orange thing beside it, or an edge on something the reader cannot act on.
42. **One mark per kind.** Lane: a dot at the end of a rule. Item: a ring. Check: three shards. Session: a hollow square. Person: a solid square. A row about one of them starts with its mark; a region that lists one kind carries the mark once before its title. Marks are ink; colour stays with state. A thing that is none of the five has no mark. *Not* a hue per kind, a tag, or a mark as the only way to tell.
43. **The fold.** A deep section may be one line: title, count, one sentence that is its answer, the turn mark. It opens in place and stays as the person left it, per person and per page. A new account lands with deep sections folded; the first stop is never folded and nothing that waits on the reader is ever inside a fold. A request asked ahead is one line that opens in place to the whole decision. An empty section's line says so. *Use* "While you were away · 14 landed, main did not break". *Not* a tour, a coach mark, a "show more" that leaves the page, a summary that repeats the title, or a line that explains what the section is for.
44. **Where the project stands.** Needs me, Lanes, Plan and the public project page carry one line under the page sentence (the standing line): a roll-up with one tick per Item and three figures, Done, In progress, Left, each with its state glyph, one more fact and a link to where that work lives. In the app the figures are Items, with landings and Lanes as the one more fact; on the public page they are landings this week, open Lanes and open Items. No percentage. It is watch weight and reads second. *Use* it once per page, in the same place. *Not* a dashboard row of cards, or a different summary on each screen.
45. **Order follows weight.** Inside a region: act, then watch, then reference. A list a person ordered by hand keeps its order; rows carry their weight in place. The page sentence is the answer and at most one more clause.
46. **Detail is never removed to calm a page.** It is given a lower weight or folded, and stays one press away, in place.

### App, public page, docs, CLI
47. **What carries over everywhere:** the palette and the six states with their shapes and words; the family; the squared edge; seams, not boxes; the five stops; the voice; handles only.

| | App | Public page | Docs | CLI output |
|---|---|---|---|---|
| Type | fixed app scale | fluid scale, display at 750 | 16 px at 1.6, 68 characters | the terminal's mono |
| Orange | one action, the count, the mark | a material: the key, bars, one full-width statement | links only, in the accent | none |
| Layout | regions and seams, the rail | full-width sections, one claim and one proof each | a left tree, one column | one line per Lane: frame, glyph, name, fact, next step |
| Motion | state changes only | the hero loop while visible; charts that draw once | none | one frame per row while live, on a terminal only |
| Does not carry over | display type, loops, the orange band, the 8 px key | the rail, dense rows, key caps, movable regions | docks, state tints | colour as the only signal |

48. **Text never sits on a moving or drawn background.** A background scene lives in its own window; headlines, buttons and links sit on a plain surface. A section's colour ends at the section's edge.

## The live line

Five stops across the top bar (Editing, Saved, In queue, Checking, main) and one mark per open Lane. When a Lane changes, its mark moves; all of the motion is the browser gliding between two states it was given. Nothing ticks, polls or redraws in between.

| Event | What the mark does | Time |
|---|---|---|
| A Lane opens | appears at the end of Editing, from 60% size and clear to full | 200 ms |
| Moves to the next stop | glides to the end of the next stop; the marks behind close the gap in the same move | 600 ms |
| Is held for a person | stays in place; the dot opens into an amber ring; held marks step to the front of their stop | 320 ms shape, 240 ms colour |
| Overlaps another Lane | both gain the dotted tie; one that cannot go on becomes a diamond | 240 ms, then 320 ms |
| A check fails | pushes 5 px toward main and comes back, then rests as a red square | 520 ms, once |
| Lands | turns green and travels into the main tick; halfway, the count steps by one and the tick rings once | 600 ms, ring 500 ms |
| Is set aside | turns grey, is lowered 7 px and fades; main does not ring | 320 ms |
| Several at once | each starts 40 ms after the one before, the last no later than 240 ms; three or more landing together arrive 90 ms apart and main rings once | under 900 ms |

**When a stop fills up:** as many whole 8 px marks as fit, held ones first, then oldest; beyond that a count, held Lanes as whole marks and the rest as 3 px tally ticks; above the feed's cap, counts only with held Lanes still listed. Held Lanes are never folded into a count, and room for the count is always kept. Under 860 px the line is its own row below the top bar.

**Data and cost:** per open Lane only an opaque id, the stop, the hold, whether it overlaps and the time of the last change; per project, landings today and the Lanes that left since the last version. One small bounded record per project, rewritten only when a Lane changes and sent once per rewrite; nothing on a timer. Elapsed times are worked out in the browser when someone points at a stop. A hidden tab keeps only the newest version and draws nothing; on return there is one catch-up and nothing is replayed. Each stop is a link to Lanes filtered to that stop; marks are hidden from screen readers and Needs you is the announcement.

## Do's and Don'ts

### Do
- Lead every page with the sentence that is the answer.
- Give every screen one first stop, and say where the project stands in the same line everywhere.
- Fold what is deep to one line with its answer; open it in place.
- Put what needs a person first, on every width.
- Give every action a button, a key and a command.
- Pair every automatic action with Undo.
- Draw the empty, loading, failed and offline states of every region, and the worst case.
- Pluralise ("1 Lane", "2 saves") and format numbers for the person's locale.

### Don't
- Put a container inside a container, or round a region's corners.
- Use a pill, a gradient, a glow, a blur or a shadow on anything that does not float.
- Use orange for a state, or a state colour for decoration or a chart series.
- Show a state by colour alone.
- Leave an explainer on screen that does not change the decision at hand.
- Show a real name, an email or a machine name.
- Animate an entrance, a list, a number, or anything that did not change state.
- Put the accent or motion on anything that does not wait on the reader.
- Give a kind of thing its own hue, or hide what waits on the reader inside a fold.
- Write a colour, font, radius, duration or curve that is not a token.
