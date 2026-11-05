# P6 planning: build spec (follow strictly)

Status: unshipped design input; see [README](README.md) for caveats and the synthetic-data note.

Mockups (in [`design/planning/`](../../../design/planning/), synthetic example data): `01-backlog.html` (default List), `02-item.html`, `03-board.html`, `04-initiative.html`, `05-history.html`, `06-settings.html`, `07-states.html` (every state). Open with `?theme=dark` or the toggle for dark. Shared CSS `p6.css`: the `.fx-*` block exists in `web/src/ui` already (reuse, do not copy); the `.pl-*` block is the only new CSS. Model and rules: `IA.md`. Verbs: `AGENT-SURFACE.md`. Slices: `BUILD-PLAN.md`.

Design law (from DESIGN.md): colour only for state; one orange button per area; no explainer text that stays on screen; relative times with absolute in `title`; titles wrap to two lines, never ellipsise; nothing under 11px; no emoji, no shimmer over 600 ms; no money anywhere.

## 1. Page skeleton
Top bar · channel strip · page head (crumbs, h1 + pill, meta line, situation sentence, actions right) · content. Planning is full width with 16px gutters like Now and Work.

Page head actions on Planning list/board: Work seg (Intents · Lanes · Planning), ghost "New Initiative", primary "New Item" (opens the existing inline editor with Title, Initiative, Type, Details). History: ghost "Export" only.

Situation sentence: `<b>N alive</b> in K Initiatives · <a>working</a> · <a>waiting on you</a> · dated · planned.` Links apply the matching filter. Zero buckets omitted; if N = 0: "Nothing alive. History has M closed items."

## 2. Toolbar `.pl-bar`
Left to right: View seg (List · Board · History), Filter seg (Alive N · Waiting on you N · Blocked N · Dated N; counts from the status aggregate, hot count pill only on Waiting on you > 0), Group by `.fx-sel`, Type `.fx-sel`, search input right (260px; full width ≤ 720). On Board the Filter seg is replaced by an Initiative `.fx-sel` (multi). URL state: `view`, `filter`, `group`, `type`, `q`.

## 3. Quick capture `.pl-capture`
44px dashed box under the toolbar (36px inside an Initiative page panel). Input placeholder "Jot it down… (Enter creates a planned Item; refine later)". Right side "in <Initiative sel>" on Planning; absent on an Initiative page (scope is implied). States: idle · typing (solid focus border, hint "↵ add · ⌘↵ add and open") · saving (disabled, "adding…") · error (red border, message, Retry with the same operationId). On success: clear, keep focus, toast "Added '…' to <group> · Undo · Open" 6 s. First word matching a type sets `type` and shows `auto` tag + Undo in the toast. The capture never asks for more fields.

## 4. Group `.pl-group`
Header 40px, `--fx-surface-2`: chevron + title (link to Initiative page; chevron toggles collapse, remembered per project) · one-liner `.pl-line` (template in IA.md §2; include the `.pl-mini` bar only when total ≤ 12) · Initiative pill (Planned · ● In motion · ✓ Done · — Abandoned) · ⋯ menu (New Item here, Edit, Reorder Initiatives, Close, Abandon). Rows below, max 8 visible per group in Alive, then `.pl-more` "N more planned · N landed today". Groups with no alive rows collapse to header + one quiet line. Group order follows Initiative `order`; "No Initiative" last; "Proposed from outside" first when non-empty.

Quiet Initiatives: a single `.pl-quiet` line after the last group (IA.md §3). Clicking expands them in place as normal groups.

## 5. Row `.pl-row`
Grid `18px 92px minmax(0,1fr) 150px 44px`, gap 12, min-height 44, 3px left rail in the tone colour (none for Planned). Columns: drag handle (visible on hover/focus) · status pill (fixed 92px so titles align) · main: title line (title link, type `.fx-tag`, optional `.pl-sub` "2 of 5") + fact line (12px `--fx-text-2`, one line, ellipsis at end) · who (18px avatar + name; agents square) · age (relative, `title` absolute). Hover `--fx-hover`; selected `--fx-accent-bg`. Done rows get `.done` (75% opacity). Sub-items render only inside the parent Item page, and inside the list when the parent row is expanded (chevron on `.pl-sub`), indented by 18px with a 1px guide (`.pl-child`).

Fact line per derived status (exact words):
- Proposed: `proposed from outside by <name> · Plan it · Decline`
- Planned: `no Lane yet` + ` · N comments` when > 0
- Dated: `not before <D Mon>` + optional reason excerpt
- Working: `<n> Lane(s) · <n> saves · last save <age>`; when two Items share a Lane: `shares Lane <name> with 1 other Item · <n> saves`
- Checking: `check running <m> min · queue position <n>` or `check queued`
- Ready: `check passed · landing, position <n>` or `check passed · awaiting review by <name>`
- Waiting: `<span class="dec">waiting on you</span> · <what> · Answer` (or `waiting on <name>`)
- Check failed: `<check> failed <age> · <n> tests · log`
- Conflict: `conflicts with main in <n> files since <age>`
- Done: `landed <short sha> · <age>` or `closed by hand · <actor> · "<reason>"`
- Abandoned: `abandoned · "<reason>"`

Row menu (⋯ on hover, or Shift+F10): Open, Edit, Move to…, Set not before…, Split, Merge into…, Hand to an agent, Close by hand, Abandon.

## 6. Reorder
Drag handle within a group (pointer) and keyboard: Space/Enter on a focused row's handle grabs; ⌥↑/⌥↓ moves; Enter drops; Esc cancels. Drop line 2px accent. Cross-group drag moves the Item to that Initiative (fact line shows "moved to <Initiative>" for 1 h with Undo). Toast "Moved to #6 · Undo". On policy refusal show the error toast "You can only reorder your own Items here" (agents) or "Reordering is off for agents" and leave order unchanged. Phones: no drag; row menu "Move up / Move down / Move to…".

## 7. Board `.pl-board`
Five columns Planned · Working · Checking · Ready · Done (7 days). Card `.pl-card`: eyebrow `<Initiative> · #order`, title (2 lines), fact line (short form of §5) with actor avatar right. Flags: Dated cards keep the grey rail and "not before"; Waiting cards show the amber pill in the fact line; Failed and Conflict cards get the red/violet rail and sit in Working. Columns scroll separately, 20 cards then "N more". Empty column: one quiet line. Done column footer links to History. Board is read-only in v1 (no drag between columns; status is derived).

## 8. Initiative page (`04-initiative.html`)
Head: crumbs, h1 + Initiative pill, meta (opened by, items, plan link if body has one), situation = one-liner + "Last landing: <age or none yet>". Actions: Edit, More, primary New Item.

Progress panel:
- Swimlanes `.pl-swim`: one row per top-level Item in `order`: title (+type tag) · four-segment bar `.pl-bar4` (planned · working · checking · landed) · pill. Fill rules: Planned → seg1 active; Working → 1–2; Checking → 1–3 (3 half when sub-items split); Ready → 1–3 + seg4 empty; Waiting → filled so far, next segment amber; Failed/Conflict → next segment red/violet; Done → all green; Dated/Proposed → all empty. Max 30 rows, then "N more" link to the list below. Header legend row once.
- Charts `.pl-charts`: Burn-up (scope step line in `--fx-text-3` dashed, landed line in `--fx-passed`, end dots) and Flow (stacked areas bottom-up landed · in flight · waiting · planned; blocked merges into waiting colour). Inline SVG `viewBox 0 0 400 160`, 3 grid lines, x labels first/mid/last day, legend with current values, one-line `.fx-faint` observation computed from the series ("scope grew 5 since 24 Oct", "in flight widened 30–31 Oct"; omit when nothing notable). Range: last 30 days, or since opening if shorter. Under two days of data the whole chart row collapses to the quiet line "Charts begin after two days of events. First point: <date>." Tooltips: native `<title>` per day column. No animation.

Below: Items panel (Alive · All seg; capture input; rows) left; What and why, Conversation (decision toggle), History right (340px).

## 9. Item page (`02-item.html`)
Head: crumbs Planning › Initiative › Item; h1 + derived pill; meta: type tag, `#order in <Initiative>`, added by, `n of m sub-items landed`; situation sentence assembled: `<b>N Lanes open.</b> <lane> saved <age> · <lane> checking, queue position n · nothing waiting on you.` Actions: Edit, Move to…, More ▾ (Split, Merge, Set not before, Hand to an agent, Close by hand, Abandon), primary **Start a Lane** (hidden when the Item is Done/Abandoned; "Reopen" ghost instead).

Left: What and why (`.pl-body`, Edit link; empty → one line "No details yet. Edit."), Sub-items (rows, Add, Reorder; absent when none and the Item is a sub-item itself), Conversation (decision comments get the amber left border and DECISION eyebrow; `auto` tag on system entries such as "Started Lane … from this Item"; compose with a "decision" checkbox).

Right 340px: **Work** chain `.pl-chain` (Intent → Lanes → newest Check with journey rail → Landed; footer "Status comes from these records. Closing happens when a linked Lane lands."), Fields `dl` (Initiative, Type, Order, Not before, custom fields, Linked counts; each value has an inline change link), Refine buttons (Split into sub-items, Merge into…, Hand to an agent, Close by hand, Abandon…), History (3 latest, "Exact record" opens the full provenance view that exists today).

Hand to an agent = the existing CopyPrompt pattern with text: "Refine Forge planning Item <id> in project <name>: read it with `plan show`, improve title/why/done-when, split if needed, comment your reasoning. Do not start work."

## 10. History (`05-history.html`)
Toolbar: View seg, Scope seg (Done + abandoned · Everything), Initiative, Type, search (320px). Results as rows `.pl-hist-row` (no handle, no rail colour beyond tone, date column instead of age), newest close first, 50 per page with "More". Search hits highlighted with `.pl-mark` in title and in the one matching excerpt (body, comment or reason). Empty: "No match for '…' in history." Situation: `<b>N closed</b> this week · n landed, n closed by hand · n abandoned.`

## 11. Settings (`06-settings.html`)
Settings › Project › Planning: panel "Track work in planning" with two switches (second indented, disabled when the first is off), reorder policy select; Types chips (add/remove; removing a type in use re-labels nothing, Items keep the label and it shows as `.fx-tag` still); Fields list (≤ 6, add/edit/remove; built-ins listed as text); Quiet Initiatives days select (7 · 14 · 30 · never). Each change saves immediately with the standard toast and Undo.

## 12. Keyboard
`/` focus search · `c` focus capture · `j`/`k` next/previous row · `Enter` open · `e` edit · `m` move to… · `.` row menu · `1`/`2`/`3` List/Board/History · `f` cycle filter · `Esc` clear selection. Rows are `tabindex=0` list items with `aria-selected`. Drag handle has `aria-label="Reorder"` and the grab/move/drop keys from §6.

## 13. Loading, empty, error (see 07-states.html)
- First load: group headers with "…" in the one-liner and three 44px skeleton rows per group, no shimmer > 600 ms; rows never shift after load (fixed heights).
- Empty group: header + "Nothing here. Jot the first item above or move items in."
- Nothing alive: "Nothing alive. History has N closed items."
- No search match: "No match for '…' among alive items. Search history too."
- Read error: `.pl-errbox` above existing rows (never replacing them): "✕ Not loaded · Planning could not be read (<cause>). Shown: <what remains>. Retry."
- Write error: toast with Retry keeping the operationId; row shows pending state (opacity .7) until acknowledged.
- Charts under two days: quiet line.

## 14. Density and responsive
Row 44px, group header 40px, panel header 42px, 13px body, 12px facts. ≤ 1060px: who column hidden; Item page single column; Board horizontally scrollable 240px columns. ≤ 720px: pill top-right over the row, one-liner wraps under the title, capture full width, bottom tab bar as elsewhere; no horizontal page overflow at 390px.

## 15. Budget rules (per view; see BUILD-PLAN for numbers)
Idle = 0 Convex function calls (reactive queries only on index rows that change on writes). Reads are O(pages): one items page (≤ 100 rows) + one aggregates row per visible Initiative + one project status row. No client-side joins over Lanes/checks: the derived status row carries what the fact line needs. No polling, no timers, no refetch on focus. Derived status writes are piggybacked on existing Lane/check/queue/landing mutations (one extra small write each), never a cron.

## 16. Do NOT build
Sprints, points, estimates, velocity, due dates (only `notBefore`), assignees as a field (actors come from Lanes), custom status workflows, drag between Board columns, nested Initiatives, rich-text editor (plain text with light Markdown preview), per-person boards, notifications/email, cost or money anywhere, any LLM call from Forge, animations beyond 150–240 ms fades, tooltips that explain concepts (use (i) only in Settings), percent complete numbers on bars, Gantt with dates, timeline view, bulk edit (v2), saved views (v2), labels beyond `type` + ≤ 6 fields, more than 12 types.
