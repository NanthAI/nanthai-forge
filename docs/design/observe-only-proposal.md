# Observe-only checks and sampled review: an unapproved proposal

Status: **unapproved design input. Nothing here is built, selected or a default.** It preserves a 2026-10-30 design memo so a future builder neither loses it nor mistakes it for decided policy. Every number below (landing counts, windows, rates, budgets, sampling probabilities) is an **illustrative placeholder**, and any language that makes a human step mandatory is a proposal that needs an owner decision. Do not copy any of it into active settings, safety gates, builder obligations or user-facing steps. As of the Phase 5 close the proposal was not found landed; the memo itself said to revisit it after the policy gate and the main audit are deployed and have soaked.

The questions that need an owner decision are listed in [Questions for the owner](#questions-for-the-owner).

## 1. Problem

Today a check either gates or does not exist. Adding a new check (a stricter lint, a new contract-test class, a slower suite, a new provider) risks blocking every landing on day one, so it is either never added or added and then quarantined by hand. Separately, supervised projects review every Candidate: safe, but linear in human attention. With ten or more agents landing, review becomes the slowest remaining loop. The proposal wants (a) a way to *measure* a check before it can block, and (b) a way to spend human review where it is most likely to matter, without lowering the guarantee for cases that need it.

Non-goals: new gate modes, changes to protected-path rules, replacing the full gate, agent usage budgets.

## 2. Observe-only checks

### 2.1 Model

Add one field to a check declaration, `enforcement: 'gate' | 'observe'` (absent means `gate`, so every existing policy keeps today's behavior). An observe check:

- runs on the same exact Candidate as gating checks, scheduled in the same run, with no separate trigger and no extra provider spawn when the run already exists;
- records its verdict, duration and cost as evidence on the run, tagged `observed`;
- never changes the gate function's output, never blocks acceptance and never turns `main` red in the main audit;
- shows in the Candidate view as a collapsed "Observing: N checks" line, with detail on expand and no permanent banner.

The gate's decision input stays the list of `gate` checks only. Observe results are a *separate* evidence list, so a bug in observation code cannot weaken the gate: the gate function does not read it.

### 2.2 Graduation (observe to gate)

Promotion is a declared, owner-visible change, never automatic, but Forge supplies the evidence:

- Illustrative criteria shown on the check: observed on a minimum number of landings over a minimum number of days (the memo suggested 50 landings and 3 days, **unapproved**), a false-failure rate at or under a threshold (the memo suggested 1%, **unapproved**; false failures being failures later reclassified as flaky by reruns or seen on Candidates that landed green on the full gate), a p95 duration within budget, and cost per landing within budget.
- A "promote to gate" action creates an ordinary policy-change Intent, so it is itself reviewed and landed, carrying the evidence summary. Demotion (gate to observe) is the same action reversed, on the reasoning that it only loosens a check that is already noisy; it records who and why. Who may demote is an open question.
- Failing observe checks are not quarantined (quarantine is for gating tests). They feed the same flake classifier, so the false-failure rate uses machinery that already exists.

### 2.3 Cost and scale

Observe checks cost real runner minutes, so the memo proposed bounding them with a per-project daily budget and per-check sampling (run on 1 in k landings). Budget exhaustion would skip observation and record "skipped: budget", never a failure. Storage is one verdict row per check and run inside the existing run document's evidence list, within the caps already enforced for contract reports; no new table and no new scheduler. Observation rides runs that already exist, so there is no polling and no idle cost. **The budget form and default are unapproved and are spend/limit decisions for the owner.**

### 2.4 Failure modes

- An observe check that crashes or times out is recorded `errored`, excluded from the false-failure statistic, and never blocks.
- A misconfigured field must not make a check silently gating or silently observing: the schema accepts only the two literals, and an absent value stays `gate` (fail closed to the safe default).
- Observe results must never justify protected-path or supervised exceptions; those never read observe evidence.

### 2.5 Acceptance sketch

A seeded failing observe check does not block acceptance and does not redden `main`; the same check set to `gate` blocks; promotion is refused until the criteria are met unless the owner overrides with a stated reason; budget exhaustion skips without failing the run.

## 3. Sampled review

### 3.1 Model

Supervised projects review every Candidate today. The memo proposed an opt-in policy, `review.sampling`, for projects that want to review fewer Candidates *without* becoming trusted:

- **Always reviewed (never sampled):** protected or unknown paths, no declared contract, an actor's first Candidate, Candidates from contributors or system actors, anything touching the policy itself, Candidates where an observe check failed, and Candidates whose risk score exceeds a threshold. *Which of these are mandatory, and whether contributors can ever be sampled, are owner decisions; the memo only recommended that contributors always be reviewed.*
- **Sampled:** the remainder is reviewed with a probability `p` (the memo suggested 0.25, **unapproved**), drawn deterministically from the Candidate id and a per-project secret salt so an actor cannot predict or grind the draw. The draw is recorded on the Candidate for audit.
- Unreviewed Candidates land under the contract gate only if all always-review conditions are false and `main` is green, which is exactly the existing trusted path, so sampling can never land something the trusted preset could not.
- Every Candidate landed without review stays in a **retro-review queue** for a bounded window (the memo suggested 7 days, **unapproved**). A retro finding triggers the same fix-forward or compensating-revert path as a red `main`, and the actor's sampling rate is raised until a number of clean reviews.

### 3.2 Risk score

Cheap, deterministic and explainable, from inputs available without model calls: changed-path count and breadth, touched-declaration count, new-file ratio, test-to-source ratio, diff size, whether the contract covers the touched files, and the actor's recent revert or retro-finding rate. Output is a 0 to 1 score plus the top reasons, shown to the reviewer. Start with a hand-set additive score, log it for every Candidate in observe mode first (the score itself is an observe-only signal until sampling is on), then compare scores against later reverts to tune. No learned model in the first phase.

### 3.3 Safety argument

Sampling lowers review *coverage*, not the gate: the machine gate for any Candidate is no weaker than today's trusted path. The risk is a defect that needs human judgment escaping the sample. Proposed mitigations: the always-review set, the retro window, per-actor rate escalation after a revert, and a project-level kill switch that restores review-all. The benefit must be measured, not assumed: if sampling does not save review minutes without raising escaped-defect reverts, it should not graduate.

### 3.4 Cost and scale

No extra runner cost. Reads are the policy plus the Candidate's already-loaded paths and contract, and one deterministic hash per Candidate. The retro queue is a status index on existing Candidate rows, paginated, with no polling. The human effect would be a review load falling roughly by the unsampled fraction of the eligible set.

## 4. Alternatives the memo rejected

- *Auto-promote on a pass-rate threshold:* hides policy changes and lets a flaky window silently start blocking everyone.
- *Sample by actor (every Nth Candidate):* predictable, gameable and unrelated to risk.
- *A separate canary runner pool for observation:* more infrastructure and cost for no extra information.
- *Observation evidence as a soft penalty in the gate:* couples a not-yet-trusted signal to the decision path.

## 5. Sequencing (proposal)

1. After the policy gate and main audit are soaked: add `enforcement` to the check declaration with evidence tagging, and log the risk score in observe mode with no behavior change.
2. Promotion and demotion Intent flow with criteria display.
3. Sampled review and the retro queue, gated on the evidence from step 1.

Metrics to add if built: observe minutes per day, false-failure rate per observe check, promotions, human review minutes per landing, sampled against reviewed counts, retro-review findings, and escaped-defect reverts.

## Questions for the owner

None of these has an approved answer.

1. Default sampling probability and retro-review window, if sampling is wanted at all.
2. Whether contributors may ever be sampled, and which always-review conditions are mandatory (the memo recommended: contributors always reviewed).
3. The observe budget form and default (a daily-minute budget is a limit and a spend decision).
4. Graduation thresholds (landing count, days, false-failure rate, duration and cost budgets), and whether the owner may override them with a stated reason.
5. Who may demote a gating check to observe-only.
6. Whether an observe failure on a Candidate adds a visible "needs a look" tag (the memo recommended one quiet line in the review header only when it fires).
7. Whether the risk score is shown to reviewers at all, and whether it is logged in observe mode first.
