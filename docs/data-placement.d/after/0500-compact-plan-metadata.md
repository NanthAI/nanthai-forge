### Compact Plan metadata

`_workStorePlan` leaves share `projectWorkDataRecords` with the current record partition. Each contains at most
128 rows and 11 KB of encoded payload, with earlier splits by bytes; a decoded payload is bounded at 256 KB.
The existing parent/position index routes writes through non-overlapping ranges. Sparse creation positions share
leaves instead of paying for empty fixed windows. Normal same-status upkeep reads and flushes one leaf; a split
writes two, and status/Initiative moves can touch two ranges. Bulk work caches leaves within the transaction.
Settled pages store only positions, so unused titles cannot trigger overflow. Item bodies, comments, original
versions and exact detail/agent reads keep their existing placement. No table, index or retention rule is added.

Coverage remains `planRowsVersion: 1`; earlier and current row payloads are readable without a public DTO change.
An old layout or an oversized leaf requests a coalesced replacement repair. Its first phase deletes this
partition's Plan pages (32 documents/1 MB per step), then re-applies exact search roots (100/1 MB per step).
The one `planRowsPreparation` control object in the generation is below 512 JSON bytes on the fixture and
contains only ids/progress, never source text. It disappears on success. A blocked pass stops; a relevant source
edit queues a fresh pass, including one restart when an edit arrived during the preceding pass. Each scheduled
step is fenced, bounded and retry-safe. There is no query-triggered backfill, polling or idle scheduling.
Project purge discovers the nested task reference from the schema; generation removal makes obsolete callbacks
no-ops. These disposable bytes retire with their existing generation/project lifetime.

Ordinary operation RPC counts and browser reply/egress are unchanged. Exceptional replacement adds one internal
mutation per clear/root page; legacy alias coverage can require two additional document reads once when
requesting repair, with no per-Item lookup; a 324-root fixture takes five steps with existing pages, or six with 40 planted
stale pages. During preparation or genuinely oversized metadata, exact legacy reads remain available. Source
writes are neither denied nor truncated, and repair needs no mandatory operator step. A step retains a bounded
source page and touched-leaf cache; isolated runtime peak memory and billed execution remain separate checks.

The [Plan budgets](../../../tests/fixtures/plan-read-budget.json) stay at 40,000 normalized read/stored JSON bytes for
324 roots and 80,000 for 648, covering dense and sparse positions, aliases and varied bodies. Current fixture
reads are about 32 KB (62 KB doubled), with legacy body-bearing reads about 660 KB (1.32 MB doubled). The
128-row occupancy tests include 400-character titles and 20 relations: byte splits keep each measured edit below
16 KB per side and the entire view below 40 KB. Every stored/returned row is checked against the PlanRow key
allow-list. Observed 16 KB payload retirement reads one document (16,269 normalized bytes), versus two/32,538
before classification caching; the header case falls from 792 to 396 bytes. Provider billed caching is unmeasured.

At $0.20/decimal GB of DB I/O, the paired one-write/one-open-tab fixture models about -$0.12 per 1,000 planning
writes after upkeep, applied to the $1.688095 reference only as a fixture overlay. Its varied bodies change the
legacy denominator, so this is not a measured billed or historical improvement over the earlier fixture. Fixed
storage/index and exceptional preparation work remain separate; no CPU or egress saving is claimed.

Plan reuses transactional `projectFinishReadRows` variants: one authority/Work-pointer row per active Work project and one schema/status/coverage header per generation. Empty projects and removal tombstones retain no Plan project header. Headers share the existing project purge and generation deletion paths. Controller history and unused Work metadata remain exact in their source rows and are absent from these reads. Only project authority/Work-pointer changes add a narrow header lookup; journal/controller-only patches add none, and byte-identical headers are not rewritten. Generation upkeep touches only its selected fields. RPC counts and idle costs stay unchanged. The Plan fixture budgets 4 KB for one project header and up to two generation headers; the landing ledger records the separate fixed project row (300/302 fixture bytes), nine fixed index entries (676/694 key bytes) and the measured three-entry index-write guard increase. These cannot merge into the finite observer header without making that observer depend on the Work pointer. The ordinary page update guard allows 16 KB per read/write side for unique title references, with two reads/two writes in the steady-state fixture; a split or move can touch another leaf. Optional oversized headers retain exact source reads instead of denying a project or generation write.
