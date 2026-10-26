# Owner decisions design QA

Source visual truth: the supplied DIRECTION and mockups 01-project-decisions-list.html, 02-intent-and-review-context.html and 04-superseded-record.html. Browser-rendered reference captures are retained under `/tmp/s52-d1-screenshots/reference-*.png`.

Implementation: the production decision components, Intent detail integration, shared shell and immutable 19-record owner fixture, plus the mockup's illustrative Intent decision. Local fixture only; no hosted accounts, writes or deployments.

Viewport: desktop 1440 × 1100 CSS px; mobile 390 × 844 CSS px; deviceScaleFactor 1. Both themes are explicitly selected through Forge's theme preference and asserted before every capture. Full-page capture heights follow content; no density resampling. Reference boards include mockup chrome and several examples, so comparisons exclude their annotations and use the matching component regions.

## Findings

No actionable P0/P1/P2 differences remain in the implemented decision components.

- Fonts/typography: the mockup's 11px eyebrow, 13.5px/650 what, 12.5px why, 12px links, and 11.5px footer rules are copied. Full what text wraps without a clamp; cross-record previews and compact rows alone may shorten. Existing Manrope headings and system UI body stacks are reused.
- Spacing/layout: copied 12/14px record padding, five-line anatomy, day bands, 3px stale rail, 380px reference side track, 16px gaps, and responsive single-column breakpoints. Intent records sit immediately after Details and before Lanes; project decisions remain a count pointer.
- Colors/tokens: both palettes use the existing Forge tokens. Superseded stays stale, without strikethrough or red. Focused light/dark record comparisons match the source colors and hierarchy.
- Assets: this is text UI. Existing Forge glyphs are reused; the supplied undo glyph is added to that shared set. No mockup chrome or decorative raster assets are recreated.
- Copy/content: Owner decisions naming, overrides/replacements, entered-by actor and recorded-time threshold match the direction. Real immutable decidedAt values take precedence over the illustrative dates in the mockups. The fixture clock yields 3 h for the illustrative Intent record versus 2 h in the source board.

## Comparison evidence

Full views were inspected together with their source captures: reference-list-light with list-light, reference-record-light with record-light, and reference-intent-review-dark with intent-dark/review-collapsed-dark/review-expanded-dark/now-dark. A matching Active first-page capture is also retained as list-active-light/dark. All uses complete real text; the All view expands every retained row.

Focused region comparisons were opened together in the same image input:

- reference-intent-record-light.png vs intent-record-light.png.
- reference-intent-record-dark.png vs intent-record-dark.png.
- reference-disclosure-dark.png vs disclosure-dark.png.

These readable crops compare the exact same Intent what, why, override and actor. The only record differences are age and the existing product column width. Full-view source/implementation heights differ because the boards contain annotations/extra examples and the real record dates produce different day populations.

## Comparison history

1. Initial comparison found an over-wide list, wrapped cross-record links and long duplicated chain previews. Fixed with the supplied work grid, inline shortened cross-record previews and compact chain text. Re-captured and compared list and record views.
2. Dark captures exposed a fixture theme override from the real theme picker. The fixture now sets forge-theme before mounting; captures assert the theme. Added the production cockpit stylesheet to the fixture, corrected inline footer alignment, and re-captured all views in both themes. Focused record and collapsed disclosure crops were compared after these fixes.

## Interactions and runtime checks

Browser tests pass for Active/Superseded/All and target filters, day pagination, record/replacement navigation, Intent placement and one Timeline event, disclosure closed initially and expandable, three-row Now pointer and its stale disappearance, empty state, full what CSS, and 390px overflow. Browser page/console error collection is empty.

The mounted immutable reader makes two fake Convex calls initially (page plus selection revalidation), zero additional calls for three unrelated Work revisions and an idle wait, then two calls when decisionVersion changes. Decision components add no polling or Convex subscriptions. Production billing/traffic was not measured.

## Open questions and expected scope differences

- The owner confirmed that Views stays retired and Decisions follows the existing Intents, Lanes and Planning segments. The approved current navigation replaces the source board's fifth-segment assumption.
- Shared shell branding/gutters and the existing Intent side column remain current product components. The fixture has zero Lanes and no Candidate, so its surrounding Intent content differs from the board; the decision record comparison uses the matching region.
- Composer/Record/Hand to an agent decision actions are absent per the slice scope, with B1.5b TODOs. Review gate rendering belongs to B1.2d; this slice adds only the collapsed context disclosure.
- The source board's Now pointer and agent note in the list's right column are illustrative context. The pointer is implemented on Now; the optional permanent agent note is omitted.

## Implementation checklist

- Complete read-only surfaces and focused interactions verified.
- Actual light and dark screenshots captured and visually inspected.
- Cross-record navigation and exact identity disclosure verified.
- Remote/full verify, live hosted integration and landing remain the lead's work.

## Follow-up polish

The existing Exact record summary weight is slightly heavier than the board's disclosure text. This does not change layout or affordance (P3).

## Screenshot inventory

- `/tmp/s52-d1-screenshots/disclosure-dark.png`: 380 × 38 px.
- `/tmp/s52-d1-screenshots/disclosure-light.png`: 380 × 38 px.
- `/tmp/s52-d1-screenshots/empty-dark.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/empty-light.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/intent-dark.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/intent-light.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/intent-record-dark.png`: 1050 × 131 px.
- `/tmp/s52-d1-screenshots/intent-record-light.png`: 1050 × 131 px.
- `/tmp/s52-d1-screenshots/list-active-dark.png`: 1440 × 1790 px.
- `/tmp/s52-d1-screenshots/list-active-light.png`: 1440 × 1790 px.
- `/tmp/s52-d1-screenshots/list-dark.png`: 1440 × 2795 px.
- `/tmp/s52-d1-screenshots/list-light.png`: 1440 × 2795 px.
- `/tmp/s52-d1-screenshots/list-mobile-dark.png`: 390 × 2659 px.
- `/tmp/s52-d1-screenshots/list-mobile-light.png`: 390 × 2659 px.
- `/tmp/s52-d1-screenshots/now-dark.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/now-light.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/record-dark.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/record-light.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/reference-disclosure-dark.png`: 380 × 38 px.
- `/tmp/s52-d1-screenshots/reference-disclosure-light.png`: 380 × 38 px.
- `/tmp/s52-d1-screenshots/reference-intent-record-dark.png`: 994 × 131 px.
- `/tmp/s52-d1-screenshots/reference-intent-record-light.png`: 994 × 131 px.
- `/tmp/s52-d1-screenshots/reference-intent-review-dark.png`: 1440 × 1375 px.
- `/tmp/s52-d1-screenshots/reference-intent-review-light.png`: 1440 × 1375 px.
- `/tmp/s52-d1-screenshots/reference-list-dark.png`: 1440 × 2451 px.
- `/tmp/s52-d1-screenshots/reference-list-light.png`: 1440 × 2451 px.
- `/tmp/s52-d1-screenshots/reference-record-dark.png`: 1440 × 1136 px.
- `/tmp/s52-d1-screenshots/reference-record-light.png`: 1440 × 1136 px.
- `/tmp/s52-d1-screenshots/replacement-dark.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/replacement-light.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/review-collapsed-dark.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/review-collapsed-light.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/review-expanded-dark.png`: 1440 × 1100 px.
- `/tmp/s52-d1-screenshots/review-expanded-light.png`: 1440 × 1100 px.

final result: passed
