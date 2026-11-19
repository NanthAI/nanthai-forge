## Planning search

Before filing an Issue or friction, search for an existing planning item and
comment on it instead of creating a duplicate. One `planning {"search":"relevant words","limit":10}`
is enough; `status:"all"` also finds closed work. Page `nextCursor` only to browse, never
for a duplicate check: each search is billed at the whole index size. Search is read-only,
ranked by Convex full-text relevance, and filters status/kind/initiative inside the
search index. Omitted status includes proposed/open/in-progress; an explicit status
is exact. Cursors bind the search, filters, page size and generation. `query` reports
the actual normalized terms and any terms omitted by the provider’s 16-term bound.
List/search summaries include `initiativeId` (null when unassigned), `bodyLength` and
`hasDoneWhen`. Unprepared legacy payload headers report null for unknown body
metadata; preparation fills it without per-item list reads. A detail read requires a complete UUID; validation names `id` and its shape.

New Issues and friction captures return `likelyDuplicates`, a bounded five-result
search of active Issues before creation. This is advisory: it adds no confirmation
or denial. Original-operation retries retain the original candidates. Partial or
unavailable index coverage is named. Search does not reconcile Intent status.

Search materialization normally adds one derived `planningSearch` row per current item in
the planning partition of the Work index, atomically maintained by planning writes and rebuilds.
Search previews bound title/body to 400 characters and report lengths/truncation;
full source remains unchanged. Rows are measured with Convex's physical-size helper.
Oversized text uses 16k-character, whole-word fragments plus a compact current root;
search returns each item at its best matching fragment, rejecting retired versions.
Fragment pages can contain fewer items or no items; follow nextCursor to completion.
Legacy generations report `partial-needs-preparation`. After deployment, the owner
can explicitly run `projectHostedPlanningPrepare:page` with projectId, owner, exact
generationId, a fresh operationId per page and cursor:null initially, then the
returned nextCursor until isDone. Replay the same page/operation after an unknown
reply. Each page prepares at most 20 items/4 MB of search-row output, plus metadata on
legacy payload headers; source and history remain
unchanged. An item can span output pages; cursors pin its version. Each operation
hydrates at most one payload-bearing item (up to 100 existing payload parts). Larger
legacy payloads report WORK_INDEX_REBUILD_REQUIRED and use the existing paged index
rebuild; they are never silently excluded from complete coverage. Reads never start a preparation or rebuild.

A search page makes one external Convex query after capability discovery (a cold
client adds one discovery query). A fresh managed CLI also reads release metadata
once before dispatch: three steady-current queries for a cold CLI search in total.
MCP pays release/discovery at startup, then one query per warm search. Startup bytes
and update work are separate and unmeasured here. Search has no per-result external
calls, writes, R2 requests or idle calls. Ordinary rows use one indexed search.
For each distinct oversized item/version encountered on a page, fragment validation
adds at most one compact root read and one indexed top-fragment read. Thus up to 100
roots and 100 bounded fragments can additionally be read, with at most 101 search
engine queries inside the same external call; each query incurs the provider's
query-GB charge. Ordinary 1k/10k fixtures incur no such additional reads. It reads at most 100 matching search rows, with a 512,000-byte read target
(the provider can include the final row beyond the target), plus current access and
generation metadata. `matchedRecordBytes` counts serialized returned DB rows, not
billed DB I/O. At 1,000 and 10,000 items the page budget is the same; total retained
search text/index storage grows with item bytes. Convex also charges search query-GB
against the entire search-index size, including retained generations and other
projects; equality filters do not reduce that charge. See [Convex costs](https://docs.convex.dev/search/text-search#costs).
`search_planning` sits on `projectPlanningRecords`. Its seven
ordinary planning indexes and full-text index cover planning rows and search fragments.
The core table has no planning/search indexes. Reads select their physical domain directly,
without a layout query, mirror or legacy fallback. The historical dogfood reading was 7.47 MB billed per
search before isolation; post-migration query-GB must be measured independently.
For 1 KiB search documents, 50 returned rows are approximately 50 KiB plus fixed
metadata at either scale; nominal indexed text is about 1 MiB/10 MiB respectively
(actual index overhead and provider billing must be measured after deployment).
Synthetic 500-character-body fixtures read 53 documents per 50-result page: about
74.8 KB serialized DB read bytes at 1,000 items and 75.0 KB at 10,000. These include
50 matches and three access/generation/head records; they are fixture measurements,
not provider billing or production latency.
Peak result memory is O(page bytes), and wall time is indexed lookup plus one page;
live latency and billed usage are unverified until the lead deploys and measures.
Issue creation keeps its existing workspace-query + command-action calls; duplicate
lookup runs inside the workspace query. A pre-search server adds one rejected
argument probe before the ordinary workspace query and explicitly reports duplicate
coverage as unavailable; its ordinary filing remains available. Friction keeps one capture mutation. Both
read up to five candidate rows plus fragment validation when needed; planning writes add one derived row per ordinary item or bounded fragments for oversized text, and
friction retains the bounded candidate page with its original record. If adding hints
would exceed the existing physical row limit, the same mutation writes one bounded
indexed receipt separately; replay adds one receipt-row lookup in that case (and
when probing a legacy record). Normal filings retain one row/write. The receipt
follows existing project deletion; neither source inputs nor filing capability are
reduced. For 364 items,
membership/Done-when triage takes four 100-item list commands (12 backend queries plus four fresh managed CLI release reads: 16 total),
with no per-Initiative scans or per-Issue detail calls. Full bodies still require
detail reads. The reported earlier 340-item triage used four list commands, six
Initiative scans and 181 detail reads; those were command counts, not measured
Convex call totals.

Vector search is deferred: lexical recall must be measured on historical duplicate
groups first; this implementation uses no embedding provider or embedding spend.
