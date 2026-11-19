# Queue-switch bench, 2026-11-17 to 2026-11-19

Bench A/B for incident Item 5e3c3a3c (passed landings waited 60–100 min behind a parked or
re-checking head). It tests three queue switches, each off by default and set as a Convex
environment variable on the bench deployment only:

| Switch | Variable | What it changes |
| --- | --- | --- |
| N1 | `FORGE_QUEUE_NEW_RUN_WAKE` | wakes a passed follower when its order holder binds a new check run |
| O3 | `FORGE_QUEUE_COHORT_KEEP_HEALTHY` | when a shared cohort check fails (or a member withdraws), keeps members whose own admission check passed |
| O4 | `FORGE_QUEUE_CANCEL_HONOURS_FAST` | spares a running solo check that a main move would retire, under `landingMode: "fast"` |

Arms: A = all off, B = N1, C = N1 + O3 + O4. Arms are compared only at the same N and the same
queue policy. All quantiles are interpolated p50/p90. Every cell is a dry (scripted) Forge cell on
the t3code bench fork unless marked live. Each cell's own `result.json` under
`BENCH_ROOT/runs/<cell>/` is the one source of truth for its row.

## Verdict per switch

| Switch | Bench verdict | Judged by |
| --- | --- | --- |
| N1 | Path not reached in any healthy switch-on cell, on either policy. No regression in any cell where it was on. | Unit tests + incident replays |
| O3 | Not reachable on either bench policy: it keeps only members with a passed admission check inside a shared cohort. The accepted policy has no admission check; the dogfood policy almost never forms a cohort. | Unit tests + incident replays |
| O4 | Precondition met only in A′ main-move 154507 (by chance), and in no C′ cell. No regression where it was on. | Unit tests + incident replays |

"Precondition" means the situation the switch acts on happened (either arm can show it);
"reached" means the switch-on behaviour is visible (scripts/bench-t3code/path-evidence.mjs). Under
the dogfood policy (full admission + fast) almost every landing lands on its own admission run, so
the queue situations the three switches change are rare: 0–1 landings per cell take a solo queue
check, and shared cohorts formed in 0–1 cells of 5. So the bench cannot decide these switches; the
decision to keep or delete each one (Item 4647d45b) rests on the unit tests and the incident
replays. The bench result is that turning all three on caused no regression.

## What this bench could and couldn't prove

- **Proven: no regression from N1, O3 or O4.** With all three on (C′), no healthy cell was worse
  than its all-off pair on the server-side metrics, and the replay of the accepted traces was
  identical across arms. Where C′ looked worse (pass-to-land in withdraw-join and parked-head), the
  receipts trace it to landings bunching behind one main move, which happens the same way in A′.
- **Not provable here: that the fixes help.** Their queue situations were not reachable. Under the
  dogfood policy almost every landing lands on its own admission run, so a passed follower behind a
  re-checking holder (N1), an admitted member of a failed shared cohort (O3) and a running solo check
  overtaken by an overlapping landing (O4) occur rarely or never at N=10. Under the accepted policy
  nothing waits after its check, and O3 needs an admission check the policy doesn't run. These fixes
  are judged by their unit tests and the incident replays.
- **Found on the way: the bunched CHANNEL_CHANGED tail.** When several landings pass right after main
  moves, each recomposes onto the new main and lands one after another, at ~30 s per serialized
  commit. That gives 2–6 min pass-to-land tails in both arms. It goes to the claw-back Item 4e013cdb.

## Offline replay (before any cell)

`tests/queue-sim/replay-runner.mjs` replays the 12 accepted bench traces through the real queue
handlers, once per arm (A, B, C and O3+O4). Results were byte-identical across all four arms (same
output hash), 11 pass and 1 fail in every arm. The one failure is a data gap in one trace
("bench replay N=5 rep=3: Incomplete trace: check-11 timing-or-cost"), not a queue result. The
incident fixture (`tests/hosted-landing-queue-sim.test.mjs`, pattern `5e3c3a3c`) passed 2/2 in every
arm. So on the accepted traces the switches change nothing, which matches the path checks below.

## Baseline: N=3 like for like

| Cell | CLI | Wall to all landed | Check wall p50 / p90 | CI runs / billed min | Convex |
| --- | --- | --- | --- | --- | --- |
| accepted forge-n3-r1-dry-a9-20261115T105211 | aea14821 | 866 s | 158 / 173 s | 10 / 30 | $0.0494 |
| accepted forge-n3-r1-dry-a8-20261115T035820 | aea14821 | 883 s | — | 10 / 31 | $0.0493 |
| now forge-n3-r1-dry-a1-20261118T060607 | 14a26884 | 901 s | 155 / 164 s | 10 / 30 | $0.0456 |

Wall is 2% over the a8 run and 4% over a9; the two accepted runs differ by 2% between themselves.
That is within noise. CI use is the same and Convex is 8% lower. (An earlier comparison against an
N=10 cell compared different shapes, see comment 9d1c067b on 5e3c3a3c; the N=3 cell is the
like-for-like baseline.)

## Policy before and after

The incident happened on the dogfood project's policy. The bench project ran the accepted bench
policy. For the switch A/B only, the bench project was switched to the dogfood queue settings and
then restored after the A/B (owner-approved each time):

| Field | Accepted (before) | Dogfood (A′/C′ cells) | Restored |
| --- | --- | --- | --- |
| `acceptance.admissionCheck` | absent (= false) | `"full"` | `false` |
| `acceptance.landingMode` | absent (= `"strict"`) | `"fast"` | `"strict"` |
| every other policy field | — | unchanged | byte-identical to before |

`set-policy` merges acceptance fields, so the restore writes the two fields explicitly. The code
reads them as `admissionCheck ?? false` and `landingMode ?? 'strict'`, so behaviour equals the
accepted policy; only the stored text differs.

### Cost of the dogfood queue settings (A′ data)

| Smoke, N=10, all switches off | Accepted policy (120909) | Dogfood policy (140145) |
| --- | --- | --- |
| CI runs / billed min | 8 / 24 | 20 / 61 (×2.5) |
| Billed min per landing | 2.4 | 6.1 |
| Convex per cell | $0.0673 | $0.0849 (+26%) |
| Convex per 1,000 landings | $6.73 | $8.49 |
| Wall | 597 s | 965 s |

Each landing runs its full admission check and then, if main moved, a queue check, so the dogfood
settings cost about 2.5× the CI minutes. The site's CI-minutes claim holds only on the accepted
policy. Full admission also doubles exposure to upstream flakes (see t23938 below).

## Arms × scenarios

### Accepted policy (queue-only checks), N=10

| Scenario | A | B (N1) | Path |
| --- | --- | --- | --- |
| smoke | 074907: wall 669 s, 8 runs, 23 min, $0.0654 | 093841: wall 595 s, 9 runs, 27 min, $0.0654 | none |
| cohort-fail v1 | 081301: wall 912 s, 26 min, $0.0709 | 100118: wall 856 s, 26 min, $0.0693 | O3 not reachable (no admission) |
| withdraw-join | 063508: INVALID (late join only) | 102836: INVALID (late join only) | withdraw never fired |
| main-move | 091352: wall 702 s, 30 min, $0.0735 | 105348: wall 639 s, 27 min, $0.0725 | not reached |
| parked-head v1 | 084040: wall 1021 s, 6 runs, 42 min, $0.0633 | 111708: wall 1039 s, 7 runs, 50 min, $0.0629 | N1 path not reached |

- Pass-to-land is 3 s at p50 in every accepted-policy cell: nothing waits after its check.
- Parked-head v1: N1 path not reached. The extra CI run in B (7 vs 6, +8 billed min) is
  batch-boundary jitter; 0 runner minutes were discarded in either arm. Every run took 393–431 s
  because the followers' trees contained the head's 240 s slow test.
- Withdraw-join on this policy tested only the late join: the scripted withdraw polled for a
  status shape the reply does not have and withdrew too late (LANDING_NOT_LIVE). The B-vs-A gap
  there is dispatch order inside a shared-package pair, not N1 (comment 9d1c067b's attribution).
  The fixed withdraw (123218) was voided by its own role guard: the withdraw body also sent
  `reason`, which the CLI refuses for a withdraw by submissionId (BAD_ARGUMENT). INVALID.

### Dogfood policy (full admission + fast), N=10

| Scenario | A′ (all off) | C′ (all on) | Target path |
| --- | --- | --- | --- |
| smoke | 140145 | 182347 | none |
| cohort-fail v1 | 143142: retired | — | O3 |
| cohort-fail v2 | 171552: VOID | — | O3 |
| withdraw-join | 151049 | 011406 (re-run; 190044 I/O-degraded) | O3 |
| main-move | 154507 | 234056 (re-run; 221108 INVALID, I/O) | O4 |
| parked-head v2 | 163401 | 002929 (re-run) | N1 |

Server-side metrics (the switches are judged on these only):

| Cell | Arm | CLI | Pass-to-land all p50 / p90 (n) | Held-only p50 (held) | Runner queue | Check wall p50 / p90 | Wall | Runs | Billed / discarded min | Convex |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| smoke 140145 | A′ | df8d6157 | 38.0 / 100.1 s (10) | 83 s (4) | 40 s | 168 / 184 s | 965 s | 20 | 61 / 0 | $0.0849 |
| smoke 182347 | C′ | f1126ef9 | 35.2 / 113.1 s (10) | 153 s (4) | 77 s | 170 / 188 s | 1184 s | 21 | 62 / 1.3 | $0.0837 |
| withdraw-join 151049 | A′ | df8d6157 | 20.9 / 64.8 s (8) | 73 s (3) | 38 s | 164 / 174 s | 1091 s | 20 | 59 / 1.5 | $0.0841 |
| withdraw-join 190044 | C′ | f66abe73 | 34.2 / 46.3 s (10) | — (0) | 42 s | 181 / 196 s | 1223 s | 19 | 58 / 1.6 | $0.0780 |
| withdraw-join 011406 | C′ | f66abe73 | 57.7 / 343.2 s (10) | 172 s (5) | 37 s | 167 / 177 s | 935 s | 20 | 61 / 0 | $0.0804 |
| main-move 154507 | A′ | df8d6157 | 36.5 / 127.2 s (9) | 177 s (4) | 38 s | 167 / 187 s | 1076 s | 20 | 60 / 3.9 | $0.0897 |
| main-move 221108 | C′ | f66abe73 | 33.6 / 45.8 s (10) | 111 s (1) | 37 s | 162 / 184 s | 2944 s | 16 | 49 / 0 | $0.0651 |
| main-move 234056 | C′ | f66abe73 | 37.3 / 52.8 s (10) | 65 s (1) | 42 s | 167 / 177 s | 957 s | 21 | 63 / 0 | $0.0787 |
| parked-head 163401 | A′ | aa7e7a24 | 45.3 / 137.6 s (8) | 180 s (5) | 29 s | 168 / 242 s | 1403 s | 15 | 54 / 5.4 | $0.0695 |
| parked-head 002929 | C′ | f66abe73 | 69.5 / 194.4 s (10) | 145 s (5) | 33 s | 147 / 203 s | 1423 s | 17 | 61 / 0 | $0.0626 |
| cohort-fail 143142 | A′ | df8d6157 | 30.4 / 114.2 s (9) | 193 s (2) | 40 s | 164 / 174 s | 1444 s | 20 | 60 / 2.0 | $0.0810 |
| cohort-fail 171552 | A′ | aa7e7a24 | VOID | | 50 s | | 1503 s | 24 | 72 / 2.1 | $0.0927 |

No cell had runner queue above 120 s, so none is marked CI contention.

Path results on the dogfood policy:

- **N1** precondition met only in A′ parked-head 163401, through incidental waits (the holder
  waited 690 s for a check slot; two other landings re-checked 3 times). The scripted situation
  never happened in either arm: the head's dependent followers pass admission in 130–190 s and land
  while the head's 240 s check still runs, so the head gets COMPOSITION_CONFLICT twice and lands
  last (~1420 s in both cells). C′ 002929: not reached (no holder re-checked).
- **O3**: no admitted member of a failed shared check in any cell; no shared batch at all in the
  C′ withdraw-join re-run.
- **O4** precondition met only in A′ main-move 154507 (one landing re-checked after an overlapping
  commit). C′ 234056: 9 of 10 landed on their admission run; the one queue-checked landing met no
  overlap. Not reached.

### Pass-to-land metric note

`scenario-report`'s pass-to-land uses `heldAfterCheck[0].from`, so it covers only landings held
after a passed check (the "held-only" column). The all-landings figure is each landing's last
operation `ciEndedAt` → `committedAt` from the cell's own record timing. Both are reported; the
switches are read on both.

### Pass-to-land differences are bunching, not switches

C′ withdraw-join 011406 and parked-head 002929 have worse all-landing pass-to-land than A′. The
receipts show why, and it is the same mechanism in both arms:

- back-to-back commits are serialized at ~30 s each (median gap 29 s A′, 30 s C′ in parked-head;
  46–59 s in main-move);
- a passed landing whose main moved goes through CHANNEL_CHANGED (recompose onto the new main,
  then land), one after another. Holds of 124–337 s appear in C′ 011406 and of 152–294 s in A′
  cells (143142, 154507, 163401, 171552);
- in 011406, 5 landings passed admission within 7 s right after the first landing moved main, so
  the serial chain was longer than in A′ 151049. There was no batch, so O3 could not act, and the N1
  and O4 preconditions were false.

Both are claw-back lines for Item 4e013cdb (~30 s per serialized commit; serial recompose-and-land
after a main move).

### Client side vs server side

Client time is the land command's own steps (`landTiming.stepsMs`) from the agents' replies.

| Pair | Client total p50 / p90 A′ | C′ | Read |
| --- | --- | --- | --- |
| smoke 140145 / 182347 | 28.8 / 35.1 s | 30.3 / 34.5 s | noise (+1.5 s) |
| withdraw-join 151049 / 011406 | 29.2 / 33.5 s | 27.2 / 30.4 s | noise |
| main-move 154507 / 234056 | 27.4 / 32.2 s | 25.9 / 30.1 s | noise |
| parked-head 163401 / 002929 | 35.6 / 73.0 s | 26.3 / 32.1 s | A′ slower (capture 2.25 vs 1.20 s, gates 1.93 vs 0.96 s); different CLI and an I/O-heavy afternoon, not like for like |
| withdraw-join 151049 / 190044 | 29.2 / 33.5 s | 63.4 / 100.0 s | I/O-degraded cell (capture 12.4 s) |
| main-move 154507 / 221108 | 27.4 / 32.2 s | 169.5 / 407.5 s | I/O-degraded cell |

In the healthy pairs the client steps differ by no more than noise, so the server-side columns
above carry the comparison.

### I/O-degraded cells and the disk-speed gate

C′ withdraw-join 190044 and C′ main-move 221108 ran while the machine's disk I/O was degraded. The
Lane checkout's file copy (`checkout.phasesMs.copyHash`, normally 2–4 s) took 3–56 s in 190044 and
21–529 s in 221108; dispatch spread was 15–292 s and 48–1557 s against about 40 s normally. With
agents starting minutes apart, every landing landed on its own admission run, so no switch
situation could arise. Both cells were re-run in a quiet window with a disk-speed gate: the series
runner reads the reset Lane's copyHash and refuses a cell above 10 s. The re-runs read 2.8, 2.8
and 2.1 s.

### CLI drift caveat

The bench CLI (the client) auto-updated during the series, so client builds differ across cells:
A′ main-move on df8d6157, A′ parked-head and cohort-fail on aa7e7a24, C′ smoke on f1126ef9, the
rest of C′ on f66abe73. A measurement hold kept the CLI fixed from 19:06 UTC on 2026-11-18. The
bench deployment's server code is deployed only on purpose, so the queue code under test is the
same in every A′/C′ cell. Each cell's `result.versions` names its CLI.

### Harness

The dogfood cells ran on harness pin a4268228. From C′ main-move 221108 on, by lead ruling, only
`scripts/bench-t3code/gates.mjs` was replaced by main's version (the macOS important-usage disk
probe), run with `--unpinned`. The gate only decides whether a cell may start and never touches
timing.

## Retired, void and invalid cells

| Cell | Status | Why |
| --- | --- | --- |
| withdraw-join 063508 (A), 102836 (B) | INVALID, late join only | scripted withdraw never fired (status-shape bug) |
| withdraw-join 123218 (A) | INVALID | role guard: withdraw reply BAD_ARGUMENT (`reason` sent with a submissionId) |
| cohort-fail 143142 (A′) | retired: "scenario cannot reach O3 under admission" | a change whose own test fails is stopped by its admission check and never joins a cohort; numbers kept as a cost point |
| cohort-fail v2 171552 (A′) | VOID | fail-once fired at the admission check, not in the queue (scenario design) |
| main-move 221108 (C′) | INVALID for O4 | I/O-degraded |
| withdraw-join 190044 (C′) | not like for like | I/O-degraded prep |
| parked-head 162746 | not a cell | reset finish failed on the server (HOSTED_ACTION_FAILED) |

## Findings for other Items

- **t27456 late conflict notice** (cohort-fail 143142). Dispatched 22 s, land submitted 71 s. No
  compose, selection or check reservation happened until 1096 s. COMPOSITION_CONFLICT came at
  1116 s, but it was knowable when t22302 committed at 195 s. Second attempt conflicted again at
  1181 s; after sync/resolve the third landed at 1444 s.
- **t23938 upstream flake** (Item 4a83a41f). Admission run on the bench fork failed
  `src/preview/ServerBrowserPage.test.ts > server browser element refs > redacts a data: link whose
  scheme a password value would mask` with `Page.captureScreenshot: Unable to capture screenshot`.
  Full admission runs the whole check twice per landing, so flake exposure doubles.
- **t26770 passed, then waited 11 min** (C′ smoke 182347; Done-when of 5e3c3a3c). It passed
  admission, waited 150 s behind an accepting holder with disjoint files, then main moved, its
  analysis expired and it ran a second check.
- **Semantic conflict across disjoint files** (cohort-fail v2 design). Two changes that each pass
  alone, on disjoint files, can both land through clean-disjoint and leave main with a failing
  test. This is the documented clean-disjoint trade-off and is not counted against any switch
  (Item ddf43617).
- **Claw-back** (Item 4e013cdb): ~30 s per serialized commit; serial recompose-and-land after a
  main move (60–340 s holds).

## Live cell: moved to the end-of-phase full bench

The planned live gpt-6.1-sol Forge N=10 cell, and its qualifying dry smoke, were cancelled by owner
decision on 2026-11-19. The bench runs once, in full, at the end of the phase on the final code,
after the switches become permanent code or are deleted. That run compares against the accepted
cell 8c9b84fc (forge-n10-r1-a1-20261115T120716: wall 860.677 s, Convex $0.0484) and the site's
claims (median 6:00, all ten 12:43, 24 CI min, 19.1M cached input tokens).

State left for that run:
- bench project on the restored accepted policy (owner-approved);
- all three switches unset on the bench deployment;
- bench deployment at Git 24ea63a1;
- bench CLI on main State f578943d (mirror: 24ea63a1);
- a clean harness pin at 24ea63a1 with its own stable build copy.

The qualifying smoke (forge-n10-r1-dry-a1-20261119T071317) was stopped mid-cell when the decision
came. It is not a result: its in-flight landings finished on their own, and none was withdrawn.
