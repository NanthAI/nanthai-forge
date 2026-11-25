### Open placement candidates

This inventory of the remaining large classes is **modelled**, from the same
pre-cleanup samples. Indexed sizes assume approximate full copies; potential
savings are ceilings/ranges before pointer/R2 costs and overlap with expiry.
They must not be summed as a measured saving. Keeping history forever permits
moving exact bytes behind verified pointers, not deleting them.
The [placement review](../../research/placement-review.md) gives a verdict for every table and R2
use and proposes the slices; none is approved yet.

| Table | Rows / sample mean B | Logical / indexed GB model | What remains to assess |
| --- | ---: | ---: | --- |
| `projectHostedRecordBodies` | 109,335 / 1,279 | 0.140 / 0.839 | Immutable journal/Work bodies, including planning/audit, must stay forever; exact R2 body plus compact hot pointer is a candidate (~0.70 GB ceiling). |
| `projectHostedActionsResults` | 20,490 / 2,151 | 0.044 / 0.176 | Report detail is operational; lossless row compaction landed. R2 detail placement (~0.15 GB original ceiling) is live for every new run: one server-only report object per new run, a bounded summary in the run header ([S3 report transport](../../research/placement-review.md#s3-report-transport)). |
| `projectHostedLandingObservations` | 44,941 / 2,293 | 0.103 / 0.412 | Versioned observation copies include committed recovery/audit history; assess deltas/references (~0.35 GB ceiling), not blanket expiry. |
| `projectHostedRecords` | 109,335 / 487 | 0.053 / 0.426 | Immutable versions/audit stay; deduplicate inline body copies only with equal read-call cost (~0.06 GB ceiling). |
| `projectHostedOperations` | 18,368 / 1,860 | 0.034 / 0.171 | Retry outcomes/receipts stay; bulk transport body pointers are an option (~0.14 GB ceiling), with no proven extra-R2-read win. |
| `projectHostedSaves` | 3,054 / 3,066 | 0.009 / 0.047 | Save/State receipts stay; completed protocol copies are a candidate (0.03–0.16 GB range), not an agreed cut. |
| `projectHostedOverlapLanes` | 1,338 / 9,371 | 0.013 / 0.075 | Current saved-path projection is rebuildable; intern/compress paths (0.03–0.12 GB range), preserving current pins. |
| `projectHostedLandingAttempts` | 4,081 / 4,176 | 0.017 / 0.102 | Causal attempt evidence stays; intern repeated Candidate/policy snapshots (~0.07 GB ceiling). |
| `projectHostedRecordHeads` | 20,071 / 750 | 0.015 / 0.136 | Rebuildable but transaction-critical CAS/current heads; keep pending read-cost parity, zero committed saving. |
| `projectFinishReadRows` | 10,180 / 1,227 | 0.012 / 0.150 | Transactional metric/public projections are rebuildable; narrow nested copies without changing readers (~0.08 GB ceiling). |
| `projectHostedLandingRequests` | 1,479 / 7,713 | 0.011 / 0.308 | Admission/selection/receipt/audit preserved; assess compact hot envelope plus immutable R2 body (~0.20 GB ceiling). |

Other review options are a State-bound R2 descriptor manifest (trusted incremental
baseline plus changed pins, never a fresh full descriptor scan per State), Work
payload/actor interning, and a different overall stack. None is built or selected
by this inventory. All audited indexes have readers, including generic pages and
snapshots; no unread collection was established. Further core/planning-history
splits model only about 0.08 / 0.11 GB and were not pursued in this slice.

Evidence: storage Issue [8c4f126b](https://dev.forge.nanthai.tech/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=8c4f126b-0c04-492e-a66a-aabc6acd4981) (inventory comment `b69f2f14`, catalog
completion `a67d6495`, catch-up `257c5a66`, final split evidence), and cost Issue
[298f9675](https://dev.forge.nanthai.tech/?project=mh7aafndrxmj8c2q0931zbjk2n8h4ffs&projectTab=planning&planningItem=298f9675-b8ad-49d6-96c3-07d94e5f9ebd). The [placement review](../../phase6-plan.md#p6-close-order-owner-2026-11-10)
decides the next implementation slices.
