### Dashboard storage and the sample model

Convex database storage includes documents **and indexes**. For design sensitivity,
count each index as approximately one extra copy of its rows. This is a model of
amplification, not a vendor formula asserting that every index stores the whole
payload. The inventory model counts one document, two built-ins, custom B-tree
indexes and one extra copy-equivalent for a search index. Search bytes may behave
differently. Provider document/index breakdown remains unmeasured.

All dashboard numbers below are **measured, owner dashboard, 10 November, before
cleanup**: 21.47 GB total, versus about 8.7 GB on the previous day. The roughly
2.4-fold rise across many tables coincided with a plan change; a measurement
change is a hypothesis, not established growth attribution. The dashboard exposes
five named tables and a 6.12 GB remainder, not individual sizes for that remainder.
Those reported components sum to 21.52 GB, 0.05 GB above the reported total;
the source does not reconcile that discrepancy, so it is not allocated to a table.
The other columns are **modelled** from bounded chronological JSON samples and
full table counts, not full-table byte sums or random samples. GB is decimal.

| Table | Dashboard GB (measured) | Rows counted | Sample mean / p95 JSON B | Logical / indexed GB (modelled) | Contents and preservation |
| --- | ---: | ---: | ---: | ---: | --- |
| `projectWorkRecords` (before split) | 10.84 | 200,262 | 2,210 / 4,186 | 0.443 / 8.409 | Work/source/planning projections: rebuildable; canonical source, planning history and audit kept forever. |
| `projectHostedCheckRuns` | 2.01 | 2,200 | 27,081 / 86,119 | 0.060 / 0.655 | Verdict, proof and source/configuration pins kept; execution detail is operational exhaust under the approved window. |
| `projectHostedCheckCallbacks` | 0.89 | 24,186 | 2,471 / 1,703 | 0.060 / 0.299 | Callback inbox payload is exhaust; digest retry receipts and reuse aliases remain. |
| `projectObjects` | 0.84 | 119,617 | 526 / 613 | 0.063 / 0.629 | R2 descriptors, not source bytes. Reachable Git/State bindings remain; immutable descriptor copies can use catalog pages. |
| `projectSourceTasks` | 0.82 | 30,402 | 5,696 / 12,934 | 0.173 / 0.866 | Fan-out inputs/progress/results: operational after whole-job completion; retained job outcome/source live elsewhere. |
| All other tables | 6.12 | — | — | Not individually dashboard-reconciled | Includes the candidate classes below; not an unexplained second byte store. |
| **Total** | **21.47** | — | — | No exact physical total model | Dashboard after cleanup remains a lead measurement. |

The Work sample contains 645 rows. Its current deployment-wide count differs
from the frozen dogfood generation's 154,496 rows, of which 103,355 are `viewFiles`.
Their sampled sizes are 1.94–2.97 KB, with contributors the largest nested field;
legacy payload pages reach roughly 10–36 KB. Dividing indexed dashboard storage
by a frozen generation count does not establish 70 KB logical Work rows. Work,
check-run and callback models do not fully explain their dashboard figures.
