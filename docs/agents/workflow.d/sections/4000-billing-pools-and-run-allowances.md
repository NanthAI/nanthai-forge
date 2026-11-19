### Billing pools and run allowances

A run allowance is separate from the owner's monthly billing pool. Phase 7 uses
[stub billing metadata](../../../billing.md), with no live accounting read or new hold.
Below 20% remaining, the compact stub line names the pool, remaining landings and
reset time. A plan-held stub keeps the original automatic continuation; do not
submit another landing to replace its queue position. Existing service limits
keep their recovery: use their reset time and retry the original command and
operation id. Storage quotas have no time-based reset. Live plan metadata is P8.

Pace on the live limits, not on refusals. A board note reply carries
`budget {limit,left,of,resetAt}` for the tightest board limit once under 20% of
it is left; slow down or batch notes until `resetAt`. A `RATE_LIMITED` refusal
changed nothing: its `recovery.retryAt` is the reset and the CLI `next` is the
exact command to rerun then. Never loop on it before the reset.

Board note text accepts app route patterns such as `/-/{handle}/{project}/lanes`.
Machine absolute, home, drive and file-URL paths are still refused; `paths` entries
remain repository-relative source paths.

A failed inline preflight pins the source selected by that landing operation.
For unchanged source, finish preflight and replay the original operation. If you
edit or save corrected source after that pre-submit refusal, use a fresh
`operationId` with the same landing options; the old id retains its original pins.
`closes` is a boolean, for example `land --save {"closes":false}` keeps the
Intent open; it does not take a list of Issue ids.

Lane status negotiates `lane-status-state` on the existing discovery and head
reads. It includes `state` only for a capable caller; older replies keep their
shape. A refused sync that observes completed or abandoned work offers reopening
that Lane, keeping local edits in place. Active-Lane recovery still offers save.
