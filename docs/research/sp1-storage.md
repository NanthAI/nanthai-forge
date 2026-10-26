# SP1 storage decision

Owner decision, 2026-10-25: neither pure arm. Adopt "Git objects for source bytes, Forge identities for everything, a Forge packed store for everything else". This replaces constraint 7, "Native is the daily format", in [decisions](../decisions.md).

A State stays a Forge SHA-256 record pointing at a Git tree, with a deterministic commit derived for export. Existing native States stay readable through an alias table. Source bytes live in a bare Git repository locally and as immutable packs plus a catalog on R2. Work, evidence, edit streams, decisions and analysis live in Forge's own packed, collectable store. Migration of native States and Git-backed owners is explicit and reversible.

## Comparison

The SP1 native and Git memos and Fable's review used the dogfood history: 403 accepted moves and 2,276 States. MB and GB are decimal. Estimates are not production results.

| Measure | Native today | Git source layer | Improved native |
| --- | --- | --- | --- |
| Source size | 720 MB measured, including carry | 24 MB history measured; full bare repository 75.50 MB including carry | ~18 MB history estimated, excluding carry |
| Source after another year, 30 landings/day | ~18.35 GB local payload estimated | ~675 MB local / ~674 MB hosted payload estimated | Not measured |
| Nested-tree disjointness, matched Git-arm comparison | Median 16.80 ms measured | Median 17.95 ms measured; 60/60 decisions agreed | Not measured |
| Implementation | Current format | ~1,500 LOC added, ~1,567 removed; 5–10 agent-days estimated | 2,000–3,500 LOC, 3–6 weeks estimated; Git projection stays |
| Dogfood conversion | None | 65–85 s measured in prototypes | Not measured |

The native size gap was unbuilt work (deltas), not inherent. Full per-State manifests account for 53%, blobs without deltas for 26%, and one-time carry for 21%. Fable's `measure-native.json` measured 373 MB of manifests reduced to 2.3 MB with parent deltas, and 181 MB of blobs reduced to 15 MB with per-path deltas. With headers, improved native is estimated at 18 MB against Git's measured 24 MB: improved native would equal Git for 2–3× the code.

Both arms demonstrated local collection without losing their retained roots. Real autosnapshot coverage was absent; snapshot retention used synthetic fixtures. Concurrent collection, crash-safe publication of packs and a catalog, actual R2 usage and production migration/rollback remain unrun. Source forecasts exclude Work, evidence, materialised Lanes and check workspaces; the native arm's complete Work restore did not finish within its time box.

## Delivery

B1.4b uses a two-method object interface (`get(id)`, `put(bytes)`) and does not wait for Git. P5-SG, "Git source layer", lands after B1.5b alongside B1.6–B1.8 in week 5, deleting the native→Git projection code it replaces. Size M–L, split if L; estimate 5–10 agent-days, ~1,500 LOC added and ~1,567 removed. Outbound GitHub mirroring becomes a push of the derived commit; inbound external merges and git-push contributions become a fetch plus one State record. Actions checks need no per-run export.

P5-RC, "Records and evidence packing and collection", runs now, weeks 1–2. Records occupy 418 MB, with only ~85 MB reachable. The owner approved this retention rule on 2026-10-25: collect only what current Work, a kept backup, a 7-day snapshot or a pending operation does not reference; full directory backup before first apply. Packing and collection target growth of ~1–2 GB/yr from ~12 GB/yr (estimate), independently of the source layer.

The [Phase 5 plan](../phase5-plan.md) carries the slices and acceptance checks. Spike evidence is the native `MEMO.md`, Git `MEMO.md`, Fable `REVIEW.md` and `measure-native.json` in the lead's SP1 research; these are not packaged here.
