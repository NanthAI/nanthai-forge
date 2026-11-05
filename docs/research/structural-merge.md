# Structural merge replay (SP2): a negative selection result

Status: **research, no merger selected.** The spike asked whether a structural (declaration-aware) merge would resolve conflicts that Forge's line-level three-way merge cannot, and whether one was safe to ship. The answer on this evidence is **neither candidate is ready to select**. This page records the negative result, its coverage limits, one wrong-merge example, the identity limits of Forge's own source graph, and the evidence still needed. It does not authorize shipping an automatic merger, adding a native dependency or importing any third-party merge tool, and it changes no product behavior.

Labels: **M** = measured; **E** = estimated; **U** = unrun. The original inputs, outputs, bundle and licence investigation are kept privately; this page contains aggregates and synthetic descriptions only, with no private source excerpts, authors, accounts or internal case identifiers.

## What was compared

- **Arm M:** an existing structural merge driver (an open-source tool, v0.20.0) run standalone with fixed role names and the same bytes as the other arm, a 60-second deadline per file and no global Git configuration changed.
- **Arm S:** a small in-house prototype (238 physical lines) that first tries the existing line merge, then aligns top-level named declarations, import modules, named test calls or fenced Markdown sections, merges each aligned unit, preserves both sides' ordering and refuses cycles or ambiguous identities. It uses the TypeScript parser Forge already uses for JS/TS and adds no parser dependency.
- Each arm ran three times on identical inputs. "Determinism" means identical resolution status and output hash on one host; cross-platform and swapped-side determinism are **U**.

A **file case** is one conflicted file with a base, two sides and the recorded human repair as ground truth. Classes: *cheap* (imports, inventories, generated registrations, additive tests, compiler options, Markdown), *different-declaration* (disjoint named declarations in one file), *same-declaration* (shared declaration edited by both) and *other* (add/add, unsupported shapes).

## Coverage and its limits

| Stratum | Episodes | File cases | Notes |
|---|---:|---:|---|
| Explicit sync pins | 19 | 38 | Base, pre-sync head, target and saved repair were retained exactly. Bases are common ancestors in a partial ancestry graph, not a complete DAG proof. |
| Inferred earlier targets | 20 of 33 | 39 | A single temporal target candidate fit; reported **separately** and never pooled into the explicit denominator. The other 13 episodes had no candidate replay (several `main` heads fit, or paths absent). |
| Friction mentions | 55 conflict mentions | — | 7 duplicates, 3 not discrete source merges, 45 under-specified. Outcomes **U**; not counted as 45 distinct episodes. |

Totals: 73 byte-file cases and 438 arm invocations (two arms × three runs), plus 4 delete/edit cases that were not fed to a byte-only driver. Add/add cases used an empty base; both arms left them unresolved.

Other limits: the retrospective judge is an **isolation judge** (affected focused tests, core build, web build, typechecks; documentation checks for docs episodes; a repair-tree baseline must pass first, otherwise the candidate is unjudgeable, not wrong). Other files of a multi-file episode are fixed to the recorded repair, so a pass never counts as a complete automatic resolution. The whole historical final-landing test closure and the full suite are **U**; they were not stored contracts. Recorded repairs sometimes add helpers or strengthen predicates beyond the input edits, so they are useful ground truth but not always a pure merge.

## Results

Raw driver outcomes before the judge. "Resolved / byte-equal" counts conflict-free files, then those identical to the recorded repair.

Explicit sync pins (38 file cases):

| Class | n | M resolved / byte-equal | S resolved / byte-equal |
|---|---:|---:|---:|
| cheap | 11 | 8 / 3 | 4 / 2 |
| different-declaration | **0** | 0 / 0 | 0 / 0 |
| same-declaration | 24 | 8 / 5 | 0 / 0 |
| other | 3 | 0 / 0 | 0 / 0 |

Inferred earlier targets (39 file cases):

| Class | n | M resolved / byte-equal | S resolved / byte-equal |
|---|---:|---:|---:|
| cheap | 17 | 6 / 6 | 6 / 2 |
| different-declaration | 3 | 1 / 0 | 0 / 0 |
| same-declaration | 15 | 8 / 6 | 0 / 0 |
| other | 4 | 0 / 0 | 0 / 0 |

- Explicit pins: 16 M and 4 S raw file resolutions; whole episodes 8 of 19 for M and 2 of 19 for S before checks (including an already-clean control and one broken output). Inferred: 15 M and 6 S file resolutions; whole episodes 4 of 20 and 2 of 20. These are **opportunity counts**, not fewer operator interventions or successful landings.
- All 73 attempted cases were stable across three runs, including unresolved ones.
- Judges completed: 12 repair trees, 16 candidate arm/tree combinations, 12 passing, 7 of those complete episodes. Observed *confirmed-wrong-on-review* among passing file-isolation outputs: **M 1 of 13, S 0 of 3** (1 of 12 and 0 of 2 among adjudicated). The passing outputs are a selected subset, not an unbiased error-rate estimate; the population wrong-but-plausible rate is **unknown**.
- No different-declaration case exists in the explicit sample, and the inferred sample has only three. That is the case a declaration-aware merge exists to win, so the central question stayed open.

## Wrong-merge example (synthetic)

A merged output compiled and passed its isolation judge but was wrong. In outline, the repair guarded reuse of an earlier check run with both conditions below; the automatic merge kept only the first.

```ts
// side A and the merged output
if (run.scope !== 'partial') return run;
// recorded repair: also rejects the legacy partial flag
if (run.scope !== 'partial' && run.partial !== true) return run;
```

A synthetic run with `scope: 'full'` and `partial: true` was returned by the merged output but rejected by the repair. A negative probe confirmed it. A syntactically clean, test-passing resolution can therefore be semantically wrong, so passing parse, build and determinism is not a safety argument. Other reviewed non-equal outputs were formatting, moved licence-header comments, reordered registrations or declarations, and one case where the human deliberately took the other side (a policy disagreement, judge unrun). Two outputs claiming a resolution failed the build (a missing import, a call with the wrong argument count) and were correctly rejected by the gate.

Unfavourable prototype iterations are part of the result: revision 1 could duplicate concurrently edited opaque loops, and revision 2 could lose a licence header during import insertion. The final prototype refuses changed opaque statements and keeps a shared header. That does not retroactively validate the earlier outputs or show production safety.

## Graph identity limits

The brief assumed declaration indexes with stable identities already existed. At the pinned `main`, the JS/TS analysis used the TypeScript parser and other languages used Lezer; there was **no persistent symbol lineage across States**, and symbol ids include State and offset. Arm S therefore built its own named-declaration model rather than consume graph ids as merge authority. It is weak on repeated imports from one module, class-member edits, rename and move lineage, registries, duplicate headings and same-section prose. Setext Markdown and a graph-backed identity merge are unimplemented. A missing graph edge never counts as evidence of semantic independence ([AGENTS.md](../../AGENTS.md)).

## Dependency and licence cost (summary)

The structural tool declares **GPL-3.0-only**; Forge's portable code is Apache-2.0 with server code AGPL-3.0-only, so linking it into the Apache portable package would change that combination's obligations. A separately installed executable talking over files or a CLI can be an aggregate if source and notice obligations are met, but that is a legal reading to confirm before any bundling, not a settled conclusion. The measured macOS ARM64 cost was about 7.6 MiB download and 79 MiB extracted; other platforms' binaries were untested, and the upstream library API is documented as unstable. The licence investigation itself stays private. **Importing the tool is not authorized by this page.**

## Decision rule applied

1. *Different-declaration superiority:* explicit sample 0 cases, so no decision; inferred sample three files, M resolved one, S none, contract proof incomplete.
2. *No contract-passing wrong resolution:* the adoption-predicate counterexample must be counted. It disqualifies a safety claim even though no accepted-`main` failure was observed.
3. *M resolves at least half of the cheap class:* explicit 8 of 11, inferred 6 of 17 (below half), before rejecting failed contracts. Pooling would hide the different evidence quality; the threshold is not shown for the intended corpus.

**Outcome: do not select or bundle M, and do not productionise S on these data. Retain the current merge behavior.** No self-metric changed: after-fixer landings and operator interventions per landing were not measured in production, and dropped landings and red-`main` minutes were not exercised because no landing occurred. No speed or cost gain is claimed.

## Next evidence needed

- Retain and export exact base, pre-sync, target and repair tuples with conflict paths and the proving-test selection, so cases need no inference.
- Collect a real set of different-declaration conflicts and replay it through the same contract gate; the existing planning work on measuring same-file, different-declaration conflicts decides whether this is worth doing at all.
- If a third-party tool is evaluated further, keep it external, pinned and optional. If the in-house route is pursued, reuse the existing TypeScript and Lezer boundary and implement explicit declaration alignment instead of treating current graph ids or absent edges as proof.
- Treat the earlier retrospective gate as a floor: a full historical contract closure per episode would be needed before any wrong-merge rate is quoted.

Verification that ran for the spike: its repair tree built, typechecked, linted and format-checked; the prototype's 13 tests and the negative probe passed; 14 distinct Forge test files ran across the recorded repetitions (544 tests, 540 passed, 4 failed by design as rejected candidates, 0 skipped). `npm run verify` was not run.
