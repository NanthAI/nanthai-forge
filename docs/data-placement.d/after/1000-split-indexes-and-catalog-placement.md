### Split indexes and catalog placement

The [Work projection index domains](#work-projection-index-domains) give the
reader map and completed migration. **Modelled copy-equivalents per write** fell
from 19 to core 11 / planning 17 / data 9; these are not measured billed write
bytes. The frozen dogfood model is 5.88 → 2.83 GB. Reconstruction from measured
native document bytes is 7.94 → 3.97 GB under the same copy assumption; physical
reclamation still needs the dashboard. Routing now reads one physical domain,
without layout lookups, fallback mirrors, extra RPCs or idle scans.

Immutable descriptors now share existing 256-entry `projectObjectCatalog` pages.
Mutable State parents/generation/protection, pending uploads and small new outputs
stay rows; random insertion into dense pages would increase read/write I/O.
`projectObjectReceipts` keeps original upload-id, nonce and size retry/cleanup
pins with three indexes instead of the descriptor table's seven. **Measured dev
migration:** 38,003 descriptors across nine projects, every digest/size verified;
18,427,473 serialized bytes removed versus 11,604,506 receipt bytes plus
3,367,626 catalog bytes (including pre-existing pages). The conservative net
logical reduction is at least 3,455,341 B, not a dashboard saving. See
[compaction](../../operations/storage-compaction.md) and
[maintenance costs](../../operations/cost-to-serve.md#maintenance-cost-and-unmeasured-work).
