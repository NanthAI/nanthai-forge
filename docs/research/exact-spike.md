# Exact as the web app framework: spike

Status: **prototype built and measured; recommendation no-go for the signed-in app rebuild, with a re-check trigger.** The final verdict is a design-review call on Issue 348436e5. The spike asks whether Exact (`expo/exact`, MIT, pre-1.0) should replace React for the signed-in web app. It builds the hardest screen, Lanes with the live top-bar Lane line, against the development deployment, and measures it against today's web. Labels: **M** = measured, **E** = estimated, **R** = read from Exact's source or docs, **U** = unrun.

The prototype lives outside this repository and is not kept. Forge gains no dependency, file or package from this spike. Exact's template repository has no licence, so the spike only reads it and copies nothing.

## Recommendation

**No-go for now: keep React 19 and add the headless layer from Issue f97fb89d ([headless layer comparison](headless-layer.md)).** Exact meets every technical line of the spike. It pauses better than today's web when idle or hidden, paints Lanes sooner, ships fewer bytes and uses less memory. Every screen in P7 would be built on it, though, and the three costs below fall on exactly that work:

1. **Live data rests on a pre-1.0 re-implementation of the Convex sync protocol.** The spike hit a real bug in it. After a sleep, the stream cannot reopen until the closing call is guarded. Forge's whole app is live Convex reads, so this layer is the critical path. Today it is maintained outside both Convex and Forge.
2. **The toolchain is a source build.** There is no packaged CLI. First setup builds Exact's compiler from Rust source: 54 s for setup plus 56 s for the compiler, and about 10 GB on disk. Every builder machine and CI image would carry that. The upstream repository also changes daily.
3. **The agent edit loop is slower than today's, not faster.** A one-line edit takes 2.3 s to show against 1.7 s for Vite. Exact's own budget for this loop is 100 ms.

The pivot cost is a rewrite of every signed-in screen in Contract. On top of that come a new data module, a different Convex client and new test drivers. Builders' first contact with the language would add rework on every screen; this spike hit nine compile errors, each fixed from the compiler's message. That cost is only worth paying once the three risks above are retired.

### What would flip it to go

Re-run this spike, as a measurement only and with the same probes, when **all** of these hold:

- Exact ships a packaged CLI or prebuilt toolchain, so setup needs no Rust build.
- Its Convex binding reopens a stream after a pause without a local patch, and it carries a compatibility promise (a 1.0 release, or maintenance by Convex).
- A transition's new delay and its new position apply together in one commit. Today they need two commits (see [Motion](#the-lane-line-motion)).
- One edit shows in under 1 s on the dev loop.

If only the first and last hold, Exact is a candidate for a new standalone surface that never touches live data, not for the main app.

## Criteria

Each row is one line from the Issue's Done-when list.

| Done-when line | Result | Verdict |
| --- | --- | --- |
| Live Convex data without the npm client; zero idle calls; hidden-tab pause | **M:** real Lanes stream over Exact's grant-checked socket (`net.websocket`) through `@exact/convex`, with no Convex npm client. Idle: 0 frames sent in 10 min, socket closed after 5 min without input. Hidden: socket closed 30 s after hiding, 0 frames for the next 9.5 min, one catch-up on return (below). | Met (with a local fix for a reconnect bug) |
| Sign-in with the chosen provider (Issue de67c77d) | **M:** a signed token reaches the stream through `cx.setAuth`, and grant-checked `fetch` supplies it. The spike used a development CLI token from a loopback helper because Forge does not run Convex Auth yet. **R:** Exact documents a Convex Auth path (deployment mutations, an auth session in the system browser, a refresh token in the secret store) that has run on the web. It also has WebAuthn passkey and OAuth PKCE packages. **U:** Convex Auth sign-in end to end. | Path exists; provider unproven |
| The line's glide and the motion rules, without general layout animation | **M:** marks move by CSS transitions on `translate`, which the browser runs, in the house ease `cubic-bezier(.23,1,.32,1)`. Starts are staggered and exits are animated. Reduced motion runs zero animations. Changing the delay needs a two-commit workaround. | Met |
| Measured against today's web | Tables below: first paint, bytes, idle and hidden traffic, memory, edit loop, builds, keyboard and screen reader. | Met |
| A diff highlighter and a Markdown path | **M:** `@lezer/javascript` highlights a TypeScript diff in the data module (47 KB gzip, loaded with the app). Contract's `markup="markdown"` renders Markdown. **R:** its dialect has no setext headings, indented code, reference links or raw HTML. **U:** tables in Markdown. | Met, with dialect limits |
| Written go/no-go with the fallback named | This page. The fallback is React 19 plus the f97fb89d headless layer. | Met |

## Measurements

The measurements compare the production build of the prototype with a preview build of today's web. The same Chromium (Playwright) loaded both at 1280×800 with the cache off, three runs each; medians are given, with all three runs in brackets. Both read the same dogfood project, which has 26 open Lanes. Today's web signs in as a test account. Each run probes only the Lanes screen.

**The comparison is not like for like.** The prototype is one screen. Today's web is the whole app shell, sign-in included. First paint and bytes therefore favour the prototype more than a full rebuild would.

### First paint and bytes

| | Exact prototype | Today's web |
| --- | --- | --- |
| Lane rows on screen | **M:** 809 ms (1,316 / 809 / 799) | **M:** 3,345 ms (5,332 / 2,307 / 3,345) |
| First contentful paint | **M:** 48 ms (52 / 48 / 36) | **M:** 40 ms (48 / 40 / 28) |
| Requests | **M:** 16 | **M:** 58 |
| Same-origin documents, scripts and styles (gzip -6) | **M:** 317 KB | **M:** 511 KB, plus the sign-in provider's script |
| Socket frames to show the screen | **M:** 4 sent, 3 received | **M:** 80–94 sent, 14–22 received |

Exact's 317 KB breaks down as follows:

- 124 KB: the app module, of which 47 KB is the diff highlighter
- 88 KB: a WebAssembly motion engine, plus 31 KB of motion glue
- 16 KB: the page
- the rest: Exact's runtime modules

Loading the highlighter only on the review screen would bring the eager figure to about 270 KB. That is right at Forge's 270 KB eager web budget ([speed budgets](../agents/speed-budgets.md)), whose figure counts scripts only. Today's 511 KB counts every same-origin file the Lanes screen loads, lazy chunks included.

### Idle and hidden

Each run lasts 10 minutes after the screen is ready. The counts are frames on the Convex socket and HTTP requests.

| | Exact prototype | Today's web |
| --- | --- | --- |
| Idle, visible, no input | **M:** 0 frames sent. Receives server pings until 5 min, then closes the socket. 0 HTTP. | **M:** drops its subscriptions at 5 min (106 frames), sends one auth refresh at about 10 min. **E:** 0 Convex function calls after the drop, since no subscription remains. Its sign-in provider's session refresh makes 1–3 HTTP requests a minute throughout. |
| Hidden | **M:** closes the socket at 30 s, then sends 0 frames. 0 HTTP. | **M:** drops subscriptions at 30 s, then sends 0 frames. 1–2 HTTP requests a minute to the sign-in provider. |
| Return | **M:** one catch-up of 3 frames (connect, authenticate, one query set). | **M:** 106 frames to resubscribe, 1 HTTP request. |

Both apps make zero Convex calls while idle or hidden. Exact holds no connection at all.

The first hidden run kept the idle sleep after the tab came back, so no catch-up happened. The prototype now treats a return to the tab as attention, and the rerun shows one catch-up. That rule belongs in any rebuild, whichever framework is used.

### Memory

| | Exact prototype | Today's web |
| --- | --- | --- |
| JS heap after garbage collection, Lanes ready | **M:** 4.8 MB (4.8 / 4.8 / 4.7); 290 DOM nodes | **M:** 24.7 MB (23.6 / 24.7 / 28.3); 1,816 DOM nodes |
| Doubled scale: 50 Lanes, three moves | **M:** 5.9 MB; 386 DOM nodes | **U** |

The motion engine's WebAssembly memory is outside the JS heap and is not counted. Today's web has no fixture route for 50 Lanes.

### Builds and the edit loop

| | Exact prototype | Today's web |
| --- | --- | --- |
| One-line edit to the change on screen (dev loop) | **M:** 2,331 ms (2,331 / 2,226 / 2,339). Rebuild about 2.1 s; runtime up about 50 ms after reload. | **M:** 1,674 ms (1,997 / 1,539 / 1,674); a full page reload. |
| Production build, warm | **M:** 2,068 ms (2,210 / 2,052 / 2,068) | **M:** 596 ms (876 / 591 / 596) |
| First setup on a clean machine | **M:** 54 s toolchain setup + 56 s compiler build, about 10 GB on disk, Rust nightly | **U:** `npm ci` on a clean machine |
| Agent driver, one shot (build, launch, drive) | **M:** about 44 s for the first run | Not comparable (Playwright scripts) |

### Keyboard and screen reader

**M:** Exact's `check` finds layout and accessibility problems before a browser opens. On the prototype it caught text contrast of 4.1:1 and stop labels overlapping at 420 px. Both are prototype bugs, not framework limits.

**M:** in Chromium, the tab order follows the line's stops, then the main link, then the Lane rows. Focus rings are visible.

**M:** the accessibility tree shows:

- the line as a navigation landmark, with each stop a link carrying its count ("Saved: 11 Lanes")
- the marks hidden from assistive technology
- 3 headings, 1 list and 23 links

**M:** two defects come from how the prototype is built:

- The keyboard handler on the root adds an extra tab stop.
- After a route change, focus stays on the old link. The prototype does not use Exact's navigation-root pattern, which manages focus.

**U:** VoiceOver by a person.

## The Lane line motion

The line is four stops with marks, and main. A mark is a full-width box moved by `translate`, so a percentage is a fraction of the line's width. A move is one CSS transition. The browser runs it, with no JavaScript per frame.

**M:** a burst of 29 moves at 50 Lanes starts in even steps from 47 ms to 281 ms. All moves end by 880 ms, and no long animation frames occur.

**M:** exits use Exact's exit animations: landed for 600 ms, set aside for 320 ms. The nudge on a failed check, the appear and the ring on main are CSS animations. With reduced motion set, the page runs no animations.

**M:** at 50 Lanes and 1280 px every mark is whole. At 420 px, crowded stops switch to a count ("Checking 19"), and 7 marks hide behind the count.

Two findings:

- **Same-commit ordering.** When one update changes both a mark's delay and its position, Exact applies the position first. Every transition then starts together and the stagger is lost. The prototype answers each new version twice: first the new delays at the old places, then, one commit later, the new places. That is a workaround in app code that every animated list would need.
- **Exit kind is predicted.** A mark that leaves from Checking is drawn as landed, and anything else as set aside. The real reason needs the line feed (Issue 18af654d), which does not exist yet. That gap is the same for any framework.

## Upstream findings

The spike hit these in Exact and can only report them here:

- **Reconnect after a pause.** `@exact/convex` calls close on a stream the host has already released. The reopened stream then fails with "the socket is not open". Guarding that close fixes it.
- **Transition delay ordering**, as above.
- The dev loop misses its stated 100 ms budget by about 20×. The rebuild takes 2 s of that.
