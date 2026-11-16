# Headless behaviour layer for the React app

Status: **decided: React Aria Components**, with conditions ([decision](../decisions.md#2026-11-16-react-aria-components-is-the-headless-layer)). The web app stays on React 19 (framework spike, Issue 348436e5). Issue f97fb89d owns the choice; the design-system Lane (6ebb58ab) binds it. Labels: **M** measured, **R** read from release history, docs or issues, **U** unrun.

## Recommendation

**React Aria Components (RAC)**, built with its English-only locale plugin, as the one behaviour layer for menus, dialogs, the command palette and reorderable lists.

- It is the only candidate that covers all four jobs in one library: a sortable list (GridList with `useDragAndDrop`) has keyboard and screen-reader support built in, and an insertion line matches the design rule "an orange line shows where it lands".
- It needed no API corrections in the prototype. It is mature (stable since 1.0 in December 2023, monthly releases) and Apache-2.0.
- With the locale plugin its bytes match the others (about 76 KB gzip for both pieces).

The runner-up is Base UI plus dnd-kit, which needs two libraries and hand-written announcements. vercel-labs/ui is not ready yet: its first npm release was four days old, it has an open focus-return bug, and the prototype needed five corrections.

## What was built

The same two pieces were built once per candidate, in a throwaway Vite 8.3 + React 19.3 app outside the repository, styled with the approved P7 tokens:

1. **A command palette.** It opens with ⌘K or Ctrl+K and has a search field over grouped commands. Enter runs the highlighted command, Escape closes it, and focus goes back to where it was. Each row also has a menu: Move to top, up, down or bottom.
2. **The Backlog ordering list.** A row is reordered by dragging its handle, or from the keyboard on that handle (pick up, arrows, drop, Escape to cancel). Every move is announced.

One Playwright script (Chromium) drove all three: 22 steps covering keyboard flow, focus return, the live-region text a screen reader is sent, pointer drag, and axe-core with an ARIA snapshot. Screenshots taken mid-drag judged how the drag looks.

| Candidate | Versions |
| --- | --- |
| vercel-labs/ui | `@ui-sdk/react` and `@ui-sdk/core` 0.1.0-beta.5 |
| React Aria Components | `react-aria-components` 1.22.1, `@react-aria/optimize-locales-plugin` 2.1.0 |
| Base UI + dnd-kit | `@base-ui/react` 1.9.0, `@dnd-kit/core` 6.3.1, `@dnd-kit/sortable` 10.0.0 |

## Results

| | vercel-labs/ui | React Aria Components | Base UI + dnd-kit |
| --- | --- | --- | --- |
| Maturity (R) | First on npm 2026-11-12; five betas in three days; the `latest` tag lags `beta`; 81 open issues | 1.0 in Dec 2023; monthly releases; Autocomplete is still a release candidate (issue 10843) | Base UI 1.0 in Dec 2025, monthly minors, 26 open bugs. dnd-kit core's last release was Dec 2024; its rewrite (`@dnd-kit/react` 0.5) is pre-1.0 |
| Licence | Apache-2.0 | Apache-2.0 | MIT, MIT |
| gzip added, both pieces (M) | 75.3 KB | 103.9 KB; **76.5 KB** English only | 78.0 KB |
| Palette only / list with row menu (M) | 62.8 / 58.6 KB | 52.5 / 93.2 KB; 49.2 / 68.1 KB English only | 42.7 / 62.0 KB |
| One menu alone (M) | 58.1 KB | 51.1 KB; 47.5 KB English only | 51.0 KB |
| Behaviour script, dev and production builds (M) | 22/22 | 21/22: an empty search highlights nothing, so Enter needs an arrow first (by design) | 22/22 |
| axe-core, page and open palette (M) | 0 violations | 0 violations | 0 violations |
| Focus after a ⌘K palette closes, opened from a row's menu button (M) | Goes to the palette trigger, not where you were (open issue 619) | The row you came from | The exact element |
| Keyboard reorder (M) | Space or Enter, arrows, Space or Enter; Home and End; Escape cancels | Enter on the handle; arrows walk the insertion points, so moving up two takes three presses; Enter drops; Escape cancels | Space, arrows, Space; Escape cancels |
| What a screen reader is sent (M, Chromium live regions and focus) | "Picked up X, position 3 of 6." "Dropped X at position 1 of 6." "Moved X back to position 3 of 6." | Focus moves onto labelled drop targets ("Insert between A and B"), plus built-in localized start, drop and cancel messages. The start message tells you to press Tab, which reads oddly for a single list | Announcements you write yourself. **The defaults read the raw id** ("Picked up draggable item c3") |
| Pointer drag (M, screenshots) | The draft order moves live and the row follows the pointer | Native drag with an orange insertion line, the design's drop line | The rows shift live under transforms |
| Tab stops in a list of n rows | 1 (roving handles) + n menu buttons | 1 (a grid) | 2n |
| Corrections an agent needed (M) | 5, below | 0 to the API | 0, given that the agent knows to replace the dnd-kit defaults |
| Framework compatibility | React 19 works. Vue, Svelte, Solid and Web Components adapters exist, but do not help an Exact app, which cannot import npm code | React only | React only |

Bytes are added over a plain React 19.3 page with the same markup (68.4 KB gzip floor), in a Vite production build, with gzip level 9; brotli is 12 to 17% smaller. The "English only" figures use `@react-aria/optimize-locales-plugin`, which drops RAC's built-in strings for other locales; without it every user downloads about 27 KB of translations.

## Bundle and startup boundary

- **CLI and MCP: no effect.** The layer is web-only and goes in `devDependencies`, bundled by Vite. CLI and MCP code never imports it, so CLI startup time and installed bytes do not change.
- **Web: the layer cannot be eager.** The web eager JavaScript budget is 270 KB gzip and 246 KB is in use ([speed budgets](../agents/speed-budgets.md)). A single menu already costs 47 to 58 KB in every candidate, because the shared core dominates. So the binding Lane must keep the layer out of the first-paint chunk: the shell renders plain buttons, the layer loads with the route or on first use (palette on ⌘K, Backlog ordering with the Plan route), or the rebuild removes enough eager code first. Raising the budget is an owner decision; this comparison does not change it.
- **Calls: none.** These are static components with zero Convex calls and no timers. Idle cost is unchanged.

## Agent corrections (vercel-labs/ui)

The skill and docs ship in the package and are clear about where to start. A sortable list is not a ready component, though: it is a primitive you write yourself on `createReorder`. Writing it needed:

1. A button slot declares `focus` and `press`. TypeScript named the missing field.
2. A prop of kind `"key"` crashed at render with an internal `keyOf` error. Kind `"string"` works.
3. The drag CSS from the docs (`--drag-x`, `--drag-y`) was missing. The behaviour test passed, but the row did not move.
4. The rows rendered the committed order instead of the draft, so a keyboard move did not show until the drop. The test still passed.
5. Reading the draft order needs a `state` field on the root slot, which TypeScript caught.

Items 3 and 4 passed every automated check and showed only in screenshots. A design system built on this layer needs a visual check of drag states, not only behaviour tests.

## Not verified

- **VoiceOver output (U).** VoiceOver was not run, because it takes over speech and the keyboard on a shared machine. The evidence is the live-region text and the accessible names and focus in Chromium. A person should run VoiceOver with Safari on the bound component before the Done-when line is ticked.
- **Touch drag and Firefox or Safari engines (U).** The checks ran in Chromium only.
- **Long lists (U).** Reorder was checked on 6 rows, not on hundreds.

## What the decision settled

The [decision](../decisions.md#2026-11-16-react-aria-components-is-the-headless-layer) answered each open point of this comparison:

- **Exact.** Rejected for Phase 7, so the layer is needed.
- **The palette rule.** The release-candidate Autocomplete is accepted, inside the one shared palette component at a pinned version. Enter on an empty search runs nothing.
- **The locale plugin.** Required, and guarded by a byte budget on the layer's chunk. If it breaks it is fixed; the layer loads after first paint, so about 27 KB of translations is not a reason to change library.
- **Drop line or shifting rows.** The design keeps the drop line.
- **Keyboard reorder.** RAC's built-in model stands: Enter picks up, arrows choose the place, Enter drops, Escape cancels, with the handle's menu as the direct way.
- **vercel-labs/ui.** Looked at again after Phase 7. If it reaches a stable release with issue 619 fixed and a shipped sortable list, it has the best reorder announcements, an agent-first API and the smallest bytes. The shared components keep that change away from the screens.

One gap the comparison did not cover: moving a region between a full-width row and two columns (the dock). It is proven on RAC in stage B before any screen binds to it.
