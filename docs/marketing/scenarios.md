# Forge scenarios for the public site and marketing

Status: **internal source notes, not approved copy.** These are real-world pains and how Forge answers them. Nothing here may go on the site until each claim is backed by a published measurement from Forge's own work and the owner approves the wording. Each scenario separates **outside numbers** (a speaker's, attributed and unverified) from **Forge evidence** (published results only), and lists the evidence still needed.

Current Forge results to cite: the [B1.5d report](../research/b15d-report.md) (real agents landing ten upstream changes on a fork at N = 1, 3, 5 and 10; every cell listed, including where GitHub wins) and [why-forge](../why-forge.md) (older, historical burst timings). Do not mix the two kinds of number in one sentence.

## S1. "My agents wait hours for CI"

**Source (outside, unverified):** a developer landing a TypeScript and Rust project with autonomous agents, in a video talk (https://youtu.be/NBCM_ZoWZo8, roughly 23:43 to 31:57); learnings noted 2026-10-28. Numbers below are the speaker's, not ours; they were not independently checked and describe his own machines, project and bills.

**Pain, as the speaker described it:**

- On local compute, agents queued for test runs for up to 12 hours per run.
- Moving tests to a paid CI vendor cut the wait to about 1.2 hours, at a compute cost he put above $2,000; his normal CI bill had been under $30. His verdict: specialised CI is built for predefined jobs, not for agents' ad-hoc loops.
- Ephemeral virtual machines with snapshot forking (a third-party service) cut his gate from 40 to 70 minutes to about 6 minutes: many machines at once, each started from a snapshot that already has the repository cloned and built.

**The speaker's own before/after table** (from a screenshot in the video; the project is a small language with faster builds). All values are his:

| | Before snapshots | With snapshots | Later |
|---|---|---|---|
| Where the land gate runs | his machine, 4 slots shared with every agent's builds | 3 to 5 fresh 16-vCPU machines in parallel | same, plus 4 release shards |
| Gate time | 40 to 70 min under load; one lane took 78 min | median 353 s (about 6 min), p90 567 s | median about 1,000 to 1,700 s (17 to 28 min), because the gate grew |
| Landings per day | 66 and 73 | 212 and 220 | 58 to 64 |
| Landings per package per day | 1.7 to 2.6 | 2.4 to 3.5 | 7.4 to 8.0 |

**What made the difference (his agent's words, summarised):**

- Gates stopped fighting builds: a gate shared CPU with every agent's build and waited in the slot queue.
- Main moved while gates ran: one package needed 6 rebases in 75 minutes. This is the problem composition addresses, but see the caution below.
- One machine was not enough: a single serial test group took about 17 minutes until it was split across parallel machines (he now starts up to 24 per round).
- Experiments moved off the shared machine, so timing results became trustworthy.
- Throughput roughly tripled, from about 70 to about 215 landings a day, then the gate crept back up from 6 to 17 to 28 minutes as it grew. Scoped checks and timing-balanced shards are the usual remedy.

**Lessons (ours, from the above):**

1. The gate (verify before landing) is the bottleneck for multi-agent work, not writing the code.
2. What makes it fast: parallel machines, warm state (clone and build once, reuse), running only what changed.
3. Paid compute fixes speed but can surprise a budget.
4. Agents need compute on demand; queueing behind people's CI is the failure mode.

**Forge answer, limited to what is established:**

- **Composition instead of one-by-one rebases.** Concurrent Lanes are composed and checked together, so agents are not asked to rebase and re-run CI after every other landing. In B1.5d, Forge used 331 billed CI minutes and 116 jobs over 11 scored cells, against 910 minutes and 336 jobs for the Git and GitHub arm (the GitHub minutes ran on free public-repository runners; the comparison is the minutes themselves, which are paid on private repositories).
- **Time to main.** In B1.5d, time to main per task was 24 to 35% lower on Forge at every N tested. Wall time to land all ten tasks was mixed: Forge was faster at N = 1 and the ranges overlapped at higher N, with GitHub's median lower at N = 10. The loss comes from the landing loop under contention (conflict and overtake loops), which is planned work.
- **Bring your own CI.** Forge orchestrates checks; it does not require a particular runner vendor. This is a design intent, not a measured claim.
- **Checks on free runners for public repositories** is how the B1.5d GitHub arm and Forge's own checks ran; whether this holds for other projects is not measured.

**Claims removed from the original notes** because the published results do not establish them: "zero rebases with Forge" (a count of rebases was not the measured quantity; conflicts still occur and cost time), "no secrets, no vendor" (checks do use credentials passed through explicitly; see [security](../security.md)), and any implication that a user sees every compute cost before it is spent (no always-visible compute price exists).

**Evidence needed before publishing:**

- our measured gate time on free runners (a target of about 10 minutes for a full run, less when scoped, is a goal and not a result);
- N agents landing together against a merge queue on repositories other than the B1.5d fork;
- cost per landing, measured on real bills, labelled with who pays.

## S2. "Five agents finish at once"

- **GitHub:** a merge queue serialises them, or each pull request rebases and re-runs CI.
- **Forge:** one composed check for the group; non-overlapping edits merge automatically.
- **Evidence to cite:** B1.5d at N = 5 (Forge won every rep on time to main and wall time, with the caveat in the report that its slowest rep sits just above GitHub's fastest other rep) and its coordination section. The older burst timings in why-forge were measured on earlier infrastructure and must be refreshed on hosted Actions before they are quoted as current.
- **Annotation:** "non-overlapping edits merge automatically" describes the design; real overlapping edits are exactly where Forge lost wall time in B1.5d.

## S3. "I can't leave my laptop on"

- Forge lands with your machine off: save, compose, check, accept and mirror run hosted.
- **Evidence:** for the dogfood project, hosted main has been the only accept path since 2026-10-28 ([status](../status.md)); no local machine is needed to land.
- **Annotation:** the ownership and uptime of the hosted deployment, and any availability promise, are not claims this page can make.

## Source notes still outside this repository

Screenshots from the video, and other audience posts the owner kept for post ideas, are held privately in Forge planning (the marketing inventory Issue) and are not published here. They must be re-sourced to a public primary link before any use.
