# Web diff path and highlighter choice

Research for the first two acceptance lines of Issue
`22fa2a33-d19c-4882-b6e9-8016818d8cd8`. No library, product UI, conflict
resolution flow or production dependency changed.

**Recommendation:** qualify Highlights 0.4.0 as the next highlighter, retain
Forge's source reader and bounded diff computation, and defer Trees. Do not adopt
Pierre's default two-file diff computation: the 29k-line replacement took
21–37 seconds before plain output. A faster tokenizer alone will not fix the
measured 3.5–3.7-second dogfood read path.

**Full Lane page timing is BLOCKED.** The reader bot reaches an error boundary in
`HostedAttention` when `projectHostedOverlapAcks:list` returns
`HOSTED_REQUEST_FAILED`. The owner approved measuring the unchanged
`ChangesPanel`/`Diff` and real `readBrowserSource` in an isolated local route.
Those results below exclude the surrounding Work/attention subscriptions and
`HostedLaneChanges`' two source-pin queries. They are not successful full-page
navigation measurements. The lead owns the separate reader-page bug.

## Measurement contract

Frontend source: `89c8bf0e1c5dbf286cec6b794172aacbbc58c912401474babf2853814b30db67`.
Node v24.22.1, Apple M4, 16 GiB RAM, Chromium 156.0.8078.4, 1500 × 1000 viewport,
React 19.3.0 and Vite 8.3.0. Disk was 77 GiB free initially and 71 GiB before the
final matrix. Heavy batches ran sequentially through `nforge heavy`; other
builders were active, so this is exploratory measurement, not an exclusive-machine
performance gate. Small timing differences within a frame are not a ranking.

Three fresh browser contexts per cell; authenticated state reused only in memory,
HTTP cache disabled for hosted reads, service workers blocked, no CPU throttle.
Hosted components used Vite development mode and React profiling. Synthetic
renderers used a minified Vite production build with the same content and
viewport. Synthetic times start at demand after the common React/CSS shell is
ready; they include lazy feature loading. They are not cold document navigation.

Pinned comparison: `@pierre/diffs` 1.6.4, `@pierre/highlights` 0.4.0,
resolved Shiki 4.6.0 using `shiki-js`, and the existing Lezer implementation.
Pierre used `Virtualizer` plus `VirtualizedFileDiff`/`VirtualizedFile`, unified
view, `pierre-dark`, no file header, and `tokenizeMaxLength: 1_000_000`.
Its default is 100,000 characters, which would otherwise exclude the largest
fixture from highlighting. This setting exists only in the throwaway benchmark.
Pierre renderer highlighting ran on the main thread; worker measurements are
separate. No claims are made for its experimental worker-pool renderer.

A diff fixture of N rows has N/2 removed and N/2 added TypeScript lines. File and
worker fixtures have N source lines. Every old line is
`export const v${i} = ${i};`; every new line inserts `1 + ` after ` = `, joined
with `\n`, without a final newline. These deliberately exercise a whole-file
replacement, not a representative sparse edit. The two real Lanes supply ordinary
sparse edits. Fixture identity is SHA-256 of before + NUL + after:

| Diff rows | Before / after bytes | SHA-256 |
| ---: | ---: | --- |
| 40 | 439 / 519 | `8cd360a0842858db66f6986b4513e7594b901974873d19824c56106c8f64658f` |
| 400 | 4,779 / 5,579 | `9943e31ffd2b3b910df633b205fc8b666a52125c2fd390a17d1c99588321833c` |
| 3,000 | 38,279 / 44,279 | `d7ec4517c05add805f47bc02b100444f6152088a6e96ffff2eca00d1f46e0527` |
| 29,000 | 398,279 / 456,279 | `cae96a711f5cde545fc0d208774f62f5096a9cf880b7cd7d2b324527aa0a863e` |

The final valid set contains 72 renderer samples, 36 cold worker samples,
15 file-list samples and nine language fixtures per backend. Twenty-seven token
text round trips matched the original fixtures exactly. Two incomplete renderer
attempts were voided for cleanup interruption and harness timing defects; their
results were discarded. The worker probe initially failed because Pierre forbids
resolving themes inside a worker. All worker cells were repeated after matching
its documented main-thread theme/grammar resolution and worker attachment path.
No unfavorable valid cell was removed. The throwaway harness is not shipped.

## Current source path: where the time goes

The existing path is [browser-source.ts](../../web/src/browser-source.ts) →
[ObjectDownloadReader](../../src/blob-download.ts) →
[computeHunks](../../src/review-hunks-core.ts) →
[ChangesPanel](../../web/src/lane/ChangesPanel.tsx) →
[Diff](../../web/src/lane/Diff.tsx) / [LazyLines](../../web/src/lane/LazyLines.tsx)
→ [SyntaxLine](../../web/src/SourceTokens.tsx) →
[highlight worker](../../web/src/source-highlight.worker.ts).

Two retained dogfood comparisons were pinned, rather than following moving Lane
heads:

| | A | B |
| --- | --- | --- |
| Base | `9498c69f3dc990a16658ed8182a848ca405231ea54621323e8e7af7ade701dd5` | `b2b474a112f2b0758f471bb82b76a11e1d363e6992ad5baeae8ff80e169c2a12` |
| Head | `77232cfe25a4f2f6b304e574a5e01159e0e40e97f6a7ff4fc45760b3e42a97bf` | `9498c69f3dc990a16658ed8182a848ca405231ea54621323e8e7af7ade701dd5` |
| Changed files | 15 | 46 |
| Selected file | `convex/projectOwnerDerived.ts` | `convex/projectExchangeReader.ts` |
| Hunks / displayed rows | 13 / 201 | 3 / 22 |
| Selected before / after bytes | 14,741 / 16,183 | 5,995 / 6,117 |
| File-index read, median ms | 1,646 | 1,718 |
| Selected-file read, median ms | 1,804 | 1,859 |
| First plain diff, median ms | 3,507 | 3,617 |
| First highlighted output, median ms | 3,532 | 3,662 |
| Highlighted output range, ms | 3,501–3,817 | 3,611–4,034 |
| Extra time after plain output, median ms | 28.8 | 45.7 |
| Exact-byte diff compute, median ms | 1.0 | 0.1 |
| Scroll frame p95 across samples, ms | 17.1–18.3 | 18.2–18.4 |
| Maximum scroll frame, ms | 18.7 | 18.7 |

“First highlighted output” is the next animation frame containing a colored
syntax token in the mounted diff. It is a first-output proxy, not a guarantee
that every line in the first hunk has finished. The adoption test needs an
explicit complete-first-hunk marker. Frames are 120 animation-frame intervals
while traversing the document after initial output; they include display cadence
and are not CPU-only paint durations.

The additional exact-byte compute probe fetched each selected pair once, then
ran the unchanged browser `computeHunks` five times: A 0.9–2.1 ms, B 0–0.2 ms
(timer resolution accounts for zero). No real source bytes were retained in the
public report.

The source reader made **13 calls and read 63 DB documents per cold view**,
identically across all six primary samples. The first index read costs five
calls; the selected file costs eight. The latter rechecks cached State authority
and fetches only the selected file's blobs. There were no DB writes.

| Function | Calls/view | DB documents read/view | DB read bytes, A |
| --- | ---: | ---: | ---: |
| `projectObjectDownloads:source` | 5 | 31 | 44,368 |
| `projectObjectDownloads:describe` | 6 | 24 | 16,310 |
| `projectObjectDownloads:signDownloads` | 2 | 8 | 5,408 |
| Total | 13 | 63 | 66,086 |

B read 66,084 DB bytes. The provider meter reported zero DB write bytes, network
egress bytes and action compute for these mutation executions. This does not
mean R2 transfers were zero: each view made four successful R2 GETs.

| Bytes/view | A | B |
| --- | ---: | ---: |
| Two State objects, decoded | 656,048 | 654,990 |
| Two selected file blobs, decoded | 30,924 | 12,112 |
| Total decoded R2 body bytes | 686,972 | 667,102 |
| CDP transfer bytes, including response overhead | 689,018 | 669,146 |

Median summed client RPC durations were 3,036 ms (A) and 3,052 ms (B), about
83–86% of time to first highlighted output. Summed provider function durations
were about 1,107 and 1,089 ms. The roughly 1.9-second difference is RPC
transport/queue/round-trip overhead beyond provider execution, not measured
highlighter work. The remaining roughly 0.5–0.6 seconds includes R2 download,
verification, State parsing, serialization and UI scheduling; those components
were not individually instrumented. Diff computation was about a millisecond.
Panel React CPU over the whole visit and scroll was 83/45 ms median, not an
additive first-paint phase. Dev `performance.memory` returned a rounded 33.1 MB
heap observation; it is not a peak or renderer RSS measurement.

The expensive pattern is serialized metadata/authority round trips, repeated
State reads/validation and whole-State transfer before a tiny file diff. The
existing `describe` API already supports signed descriptors; evaluating that
path and sharing a pinned read context could reduce round trips without dropping
fresh access checks. These are follow-up experiments, not implemented changes.

At growth, direct-object call count depends on requested pages, not changed-file
count: 15 and 46 files both cost 13 calls for the selected view. State byte cost
still grows with the repository manifest. Recipes, missing pin projections and
objects beyond direct-object representation add their existing page/leaf work;
13 is not a universal ceiling. Map mode and peer-map fan-out were not measured.

**Idle:** after the final isolated view, a 60-second open-tab window recorded
zero `projectObjectDownloads:*` executions. The log stream stayed open and had
no missing usage fields in the measured source windows. This confirms zero idle
source-reader calls for the isolated path. Full-page idle cost remains unverified
because that page crashes.

Using the existing meter's rate card ($2.20/M calls and $0.22/GB DB I/O), each
source view estimates **$0.00004314**, or about $1.29/month at 1,000 views/day for
30 days, excluding setup, R2 and storage. Six primary views estimate $0.0002588;
the two compute-probe views add $0.0000863. These are attributed source-function
estimates from numeric completion usage, not a complete session bill. R2 billing,
actual billed Convex cost and deployed backend revision were not verified; the
lead owns billing reconciliation. Bytes were observed coming directly from R2.

## Rendering and highlighter comparison

Values below are medians of three cells, in ms. Each pair is plain / highlighted
output. Pierre's two-file parser time is included in diff cells and separated in
the next table. File cells contain no diff computation.

| Fixture | Current Lezer renderer | Pierre + Highlights | Pierre + Shiki JS |
| --- | ---: | ---: | ---: |
| 40-row diff | 11.7 / 44.3 | 24.0 / 52.7 | 22.9 / 104.8 |
| 400-row diff | 11.4 / 45.3 | 23.9 / 68.4 | 37.4 / 203.3 |
| 3k-row diff | 11.5 / plain only | 172.0 / 223.3 | 196.5 / 420.8 |
| 29k-row diff | 22.7 / plain only | 23,362.5 / 23,528.1 | 23,370.4 / 25,451.3 |
| 40-line file | 11.1 / 44.6 | 23.8 / 51.2 | 21.5 / 103.3 |
| 400-line file | 11.0 / 44.1 | 22.9 / 52.0 | 23.0 / 150.1 |
| 3k-line file | 18.9 / 79.7 | 24.0 / 55.3 | 27.9 / 371.3 |
| 29k-line file | 88.8 / 474.6 | 19.5 / 112.8 | 23.3 / 473.6 |

Current 3k/29k diffs are plain because the changed-middle matrix exceeds
1,000,000 cells: `computeHunks` emits a replacement and sets `truncated`, which
`Diff` treats as a reason to disable highlighting. These fixture bytes are below
the size exclusion. Plain-only output is not a successful highlighting result.

| Diff rows | Forge compute, ms | Pierre parse, Highlights cells, ms | Pierre parse, Shiki cells, ms |
| ---: | ---: | ---: | ---: |
| 40 | 0.3 | 1.5 | 1.7 |
| 400 | 1.0 | 5.6 | 9.1 |
| 3,000 | 0.8 | 156.3 | 177.3 |
| 29,000 | 4.9 | 23,345.8 | 23,350.9 |

Pierre's `parseDiffFromFile` calls `diff@9.0.0`'s `createTwoFilesPatch` and then
processes the patch. This is a whole-file-replacement stress case. The valid
29k highlighted ranges were 23.37–24.52 s for Highlights and 22.79–38.62 s for
Shiki; shared-machine noise was substantial. This is evidence against that
unbounded parse path, not evidence that Highlights itself takes 23 seconds.
An adapter from existing comparison/patch data needs its own correctness and
performance test before considering the renderer.

| Post-output scroll / heap observation | Current | Highlights | Shiki JS |
| --- | ---: | ---: | ---: |
| 29k diff frame p95 / maximum, ms | 17.9 / 18.6 | 18.6 / 22.4 | 22.0 / 36.0 |
| 29k diff main JS heap, MiB | 38.3 | 44.4 | 58.5 |
| 29k file frame p95 / maximum, ms | 72.6 / 101.1 | 18.5 / 21.3 | 18.3 / 19.4 |
| 29k file main JS heap, MiB | 80.2 | 42.7 | 59.9 |

The full-file stress test feeds all lines to the existing `SourceView`. Hosted
Code normally uses a 16,000-character source page, so the 29k-line DOM result is
not a measurement of its normal paged view. It demonstrates the value of
virtualization if full-file viewing is adopted. Current diff virtualization
already keeps scrolling smooth; its large replacement output is unhighlighted.
The full-file scroll generated 5,198 current-worker requests versus whole-file
Pierre tokenization. Heap values are post-scroll snapshots, not peak memory.

### Workers, quality and coverage

Cold whole-file worker round trip includes main-thread theme/grammar preparation,
worker initialization, tokenization and transferring tokens back. The current
Lezer cell calls the unchanged `highlightSource` in a fresh benchmark worker;
actual renderer cells above use the shipped digest/cache worker. Pierre uses
its own highlighter APIs, with themes/grammars pre-resolved and attached as its
worker implementation requires.

| Source lines | Current Lezer, ms | Highlights, ms | Shiki JS, ms |
| ---: | ---: | ---: | ---: |
| 40 | 17.3 | 36.0 | 97.6 |
| 400 | 22.3 | 37.7 | 106.5 |
| 3,000 | 48.1 | 49.4 | 150.9 |
| 29,000 | 289.8 | 128.3 | 609.4 |

On 29k lines, Highlights spent 13.7 ms preparing on main, 20.6 ms initializing in
the worker and 16.4 ms tokenizing; transfer/scheduling accounts for much of the
rest. Lezer's 198.5 ms token phase includes its cold grammar import. Shiki spent
22.6 ms preparing, 25.2 ms initializing and 444.9 ms tokenizing. Initialization
phase definitions differ; the whole round trip is the fair cold comparison.

| 29k worker snapshot, MiB | Lezer | Highlights | Shiki JS |
| --- | ---: | ---: | ---: |
| JS heap used / allocated | 2.0 / 32.7 | 13.8 / 22.5 | 3.9 / 42.5 |
| CDP backing storage | 2.7 | 1.3 | 1.2 |
| Observed WASM linear memory | 0 | 4.8 | 0.2 |

GC was not forced, so used-heap ordering is not a peak-memory ranking. Allocated
heap is a capacity snapshot. Do not add backing storage and WASM blindly; their
accounting can overlap. A small WASM instance was also observed in the Shiki JS
worker's imported dependency graph; this is not an Oniguruma measurement or
proof that this bundle works with WASM forbidden.

| Language probe | Current application | Highlights 0.4.0 | Shiki JS 4.6.0 |
| --- | --- | --- | --- |
| TS / TSX / JS | Keywords, types, JSX and regex colored | Colored, finer lexical palette | Colored, TextMate scopes |
| JSON | Plain | Keys, strings, numbers and bool colored | Same constructs colored |
| Markdown | Plain | Heading/emphasis/link/fence colored; TS fence body colored | Markdown colored; TS fence body plain in requested-language-only worker setup |
| CSS | Plain | Selectors, values and properties colored | Same constructs colored |
| Shell | Plain | Loop, expansion, string and comment colored | Same constructs colored |
| Python | Colored; multiline string context lost per line | Multiline string retained | Multiline string retained |
| Rust | Colored; multiline comment context lost per line | Multiline comment retained | Multiline comment retained |
| TS multiline comment | Context lost per line | Retained | Retained |

All three full-document tokenizers retained TS/Rust comment and Python string
context. The current application sends each intersecting line separately, so
its caller loses that context; replacing Lezer is not the only possible fix.
For example `const hidden = 2;` inside a block comment receives keyword/identifier
classes in the current line path, but one comment class in full-document Lezer.
The Markdown result does not mean Shiki cannot highlight embedded TS: loading
embedded grammars needs a dedicated integration test. These nine small probes
are not an exhaustive language-correctness corpus.

Installed coverage: current application has four parser families (JS/TS/JSX,
Python, Java, Rust); Highlights has 152 non-plain built-in lexer IDs and 349
language names/aliases including plain aliases; Shiki has 242 canonical language
entries plus aliases. More languages do not establish better tokenization on
Forge's corpus.

### Bundle, licence and maintenance

Measured first-demand bytes in the production benchmark, after the common shell
was loaded. Actual resource requests included worker grammar requests. Values
are emitted bytes and independently gzipped files, not package install size.

| First 40-row TS diff feature demand | Raw KiB | gzip KiB | Loading |
| --- | ---: | ---: | --- |
| Current diff + SourceView module, TS worker | 200.9 | 70.7 | Feature/grammars lazy; Lezer core also reachable from main's plain-line helper |
| Pierre + Highlights | 872.7 | 304.4 | Renderer and backend lazy in experiment; WASM embedded in JS |
| Pierre + Shiki JS | 792.1 | 185.7 | Renderer, backend, requested grammar and theme lazy |

The current feature entry also contains `SourceView`'s Markdown and shared UI
imports. These are concrete benchmark loading costs, not a claimed production
app delta. Eagerly initializing the same features would move these downloads
onto the initial path (inference); eager and lazy product integrations were not
built. The complete comparison build emitted 530 files, 17,237,867 bytes /
3,633,824 gzip bytes, including both main/worker catalogs and unused lazy
languages/themes. Do not charge that whole catalog to first paint or assume a
production integration ships the comparison harness. The shipped web bundle was
not changed. Exact application entry/chunk deltas remain an adoption measurement.

Highlights' binary was 332,924 bytes / 148,366 gzip bytes; its embedded WASM ESM
was 444,033 / 185,343 bytes before bundling. Inspect the emitted encoding, not
only the package's binary-size metadata.

All three Pierre package manifests declare Apache-2.0. The isolated install's
60 manifests declared six Apache-2.0, 52 MIT, one ISC and one BSD-3-Clause;
this includes type packages and optional peers, not 60 shipped runtime packages.
Package licence files/README licence text and bundled NOTICE files were checked.
`diff@9.0.0` is BSD-3-Clause; `lru_map@0.4.1` is MIT (full notice in README);
Shiki, its engines, regex translation dependencies, Preact and its string renderer
are MIT; `@ungap/structured-clone` is ISC. No installed manifest declared
GPL/AGPL. Preserve the Apache, MIT, ISC and BSD notices for the actual shipped
closure, including Pierre theme's Primer-derived MIT notice, Highlights' bundled
theme notices and Trees' headless-tree-derived MIT notice. Highlights' NOTICE
explicitly substitutes an MIT Aurora theme for the GPL Aurora X original.
This checks the distributed package notices; it is not a source-by-source audit
of every optional grammar in the full catalog.

Diffs 1.6.4 was published immediately before measurement; Highlights 0.4.0 is a
recent beta with bundled lexers, WASM/SIMD and CSP integration risk. Its worker
theme preparation is a real integration requirement. Diffs' Shiki dependency
range permits multiple major versions: pin the resolved version and lockfile.
Shiki offers custom TextMate grammars; Highlights' fixed bundled coverage and
beta API need a corpus and upgrade test. Existing Lezer has a smaller cold cost
and familiar worker path, but Forge maintains its language list and caller.

Primary references: [Diffs documentation](https://diffs.com/docs),
[Highlights package](https://www.npmjs.com/package/@pierre/highlights/v/0.4.0),
[Pierre source and notices](https://github.com/pierrecomputer/pierre),
[Shiki source](https://github.com/shikijs/shiki), and
[Trees documentation](https://trees.software/docs). Installed package bytes and
lock resolution, rather than a moving documentation page, determine this comparison.

## File list and adoption bar

The unchanged `ChangesPanel` was rendered with synthetic paths and an empty
selected-file comparison. Time includes two animation frames after mounting;
therefore it is a paint/readiness observation, not pure list CPU.

| File rows | Median ms | Range ms | Main heap snapshot MiB |
| ---: | ---: | --- | ---: |
| 10 | 25.1 | 23.1–25.5 | 3.2 |
| 50 | 25.0 | 23.9–25.5 | 3.1 |
| 100 | 24.2 | 24.1–24.5 | 3.4 |
| 500 | 35.7 | 25.7–35.8 | 5.5 |
| 1,000 | 38.8 | 38.6–39.3 | 5.4 |

The measured dogfood lists have 15 and 46 files. The list is not the dominant
cost at that scale. **Do not adopt `@pierre/trees` 1.0.0-beta.6 for this slice.**
Its dependency graph brings Preact 11.0.0-beta.0, preact-render-to-string 6.6.5 and
a separate theming version. No Trees performance improvement was measured or
claimed. Revisit only with evidence that file-list interaction, rather than
source retrieval or graph reads, is a bottleneck.

The research highlighter choice is **Highlights for the next bounded adoption
experiment**, with Lezer kept as the measured baseline and Shiki JS as the
comparison for TextMate-specific needs. This is not permission to switch packages
or to introduce a user-visible limit. First reduce/parallelize the read critical
path where authority allows, correct multiline caller context, and distinguish
bounded alignment from unavailable source. If adopting Pierre rendering,
qualify conversion from Forge hunks/patches rather than recomputing two files
through the measured slow path.

Proposed acceptance bar for that fresh slice, on these exact fixtures and pins:

- First complete highlighted hunk after verified bytes: p95 ≤100 ms for
  40/400 rows, ≤250 ms for 3k, ≤500 ms for 29k. No plain-only pass.
- Cold isolated dogfood read through first complete highlighted hunk: p95 ≤2 s
  on this dev path; collect at least 20 fixed samples before judging a p95.
  Repeat full-page navigation after the reader-page bug is fixed.
- Scroll p95 ≤20 ms and p99 ≤33 ms, with startup long tasks and worst frame
  reported separately. Assert the 29k case in a build-failing budget test.
- Worker allocated JS heap plus separately reported WASM stays within a proposed
  64 MiB observation budget at 29k, and stabilizes over repeated file switches.
  Measure peak process memory as well as post-GC snapshots before acceptance.
- No increase from the observed 13 source calls / 63 read documents in the direct
  cold case; no added R2 file fetches to draw a list; zero idle calls. Measure
  warm revisit, changed selection, revocation/retry, recipes and growth by pages.
- All nine language probes preserve text and multiline state. Add TSX generics,
  embedded languages, Unicode, long lines and edits across hunk/page boundaries.
  Check WASM/SIMD/CSP behavior and worker startup/failure without silent loss.
- Build the actual production integration and compare initial versus lazy JS,
  gzip, worker duplication and loaded grammar/theme closure. Keep initial-shell
  syntax loading deferred and carry the actual transitive notices.

The remaining Issue lines—adoption, a build-failing product budget, conflict UI,
Trees adoption if justified and visual implementation—stay open. Full-page
navigation/idle, the experimental Pierre worker-pool renderer, Shiki's Oniguruma
backend, other browsers/devices, Map/peer fan-out, long-session peak memory,
production chunk deltas and actual billed cost are unverified. None is silently
counted as passing this research.
