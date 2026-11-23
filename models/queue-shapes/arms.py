# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Ferdinando Valsecchi
"""Calibrated queue-shapes engine with switchable batching (a) and stale-pass (b) arms."""

import random
from collections import Counter, defaultdict, deque

from publisher.experiment import Experiment
from run import nearest, noop


HOLD_MINUTES = 5.0  # HOSTED_TRAIN_HOLD_MS

BENCH_30_SHAPE = {
    "offers_per_hour": 40,
    "full_minutes": 9.0,
    "full_worker_minutes": 18.0,
    "full_slots": 2,
    "scoped_minutes": 9.0,
    "scoped_worker_minutes": 18.0,
    "scoped_slots": 2,
    "full_fraction": 1.0,
    "packages": 12,
    "shared_path_fraction": 0.0,
}

# Fitted to the live sustained-load bench (Item b9a2cccd, comment 0659ee5e):
# 14 peak bench jobs (2-shard checks), 1.5 min plan/setup/teardown overhead (~21 worker-min/check),
# 15% non-pair refusal rate (~20% total refused share with the 3 overlap pairs), 25% scoped rechecks.
BENCH_30_CALIBRATION = {
    "capacity": 14,
    "check_overhead_min": 1.5,
    "refusal_rate": 0.15,
    "scoped_recheck_fraction": 0.25,
    "audit_times": (11.0, 25.0, 39.0, 53.0, 67.0),
}


def bench_30_rows():
    """Exact 60-minute arrival schedule from scripts/bench-t3code/sustained-plan.mjs."""
    rows = []
    for block in range(10):
        for idx, offset in enumerate((0.0, 0.75, 2.25, 4.5)):
            rows.append([block * 6.0 + offset, 0.0 if idx == 3 else 0.99, 0.5])
    return rows


class CalibratedShapeExperiment(Experiment):
    """Calibrated queue-shapes model with optional batching (arm a) and stale-pass keep (arm b).

    Calibration changes over the uncalibrated singleton arm:
    - First checks use full admission (`admissionCheck="full"`), carrying across disjoint
      main moves; only rechecks after a refusal use scoped selection at `1 - full_fraction`.
    - Checks pin `main` when they acquire runner slots (compose-at-dispatch), not at enqueue.
    - Check dispatch supports submission order (Forge's queue) or FIFO arrival order
      (GitHub Actions' shared runner queue on the `bench-30` calibration cell).
    """

    def __init__(
        self,
        base,
        rows,
        seed,
        station,
        measured,
        shape,
        *,
        batching=False,
        skip_stale=False,
        max_batch=8,
        min_fresh_batch=4,
        split_mode="suspects",
        strict_admission_only_batch=False,
        dispatch_order="submission",
        bench_mode=False,
        check_overhead_min=0.0,
        refusal_rate=0.0,
        capacity_override=None,
        scoped_recheck_fraction=None,
        full_recheck_saturated=False,
        hold_deciding=False,
    ):
        self.shape = shape
        # Cohort hold (Item 10b0a94b; option B, owner 2026-11-22): a refused entry waits, at most
        # HOLD_MINUTES, for peers already deciding their own first pass, and a deciding peer fills the
        # free slot for lever 2. Only peers deciding before the hold began keep it.
        self.hold_deciding = hold_deciding
        self.deciding, self.held, self.hold_waits = {}, {}, {}
        # Lever 2 (owner 2026-11-22, Item 10b0a94b): a recheck that starts with no free slot left
        # runs full, so its pass can carry across later disjoint main moves.
        self.full_recheck_saturated = full_recheck_saturated
        assert not full_recheck_saturated or shape["full_slots"] == shape["scoped_slots"]
        self.batching = batching
        self.skip_stale = skip_stale
        self.max_batch = max_batch
        self.min_fresh_batch = min_fresh_batch
        self.split_mode = split_mode
        self.strict_admission_only_batch = strict_admission_only_batch
        self.dispatch_order = dispatch_order
        self.bench_mode = bench_mode
        self.check_overhead_min = check_overhead_min
        self.refusal_rate = refusal_rate

        self.paths = {}
        self.path_offers = defaultdict(deque)
        if bench_mode:
            for i in range(len(rows)):
                block, idx = divmod(i, 4)
                paths = {f"task-{i}"}
                if block in (0, 3, 6) and idx in (0, 1):
                    paths.add(f"pair-{block}")
                self.paths[i] = paths
        else:
            for i in range(len(rows)):
                rng = random.Random(seed * 1000003 + i * 31 + 27)
                self.paths[i] = {rng.randrange(shape["packages"])}
                if rng.random() < shape["shared_path_fraction"]:
                    self.paths[i].add("shared")

        super().__init__(base, rows, seed, station, measured)
        if capacity_override is not None:
            self.capacity = capacity_override
        if bench_mode:
            self.start = 0.0
            self.end = 60.0
            self.solo = {i for i in range(len(rows)) if i % 4 == 3}
            self.flake = 0.0
            self.pairs = [set() for _ in rows]
            audit_wall = 9.0 + check_overhead_min
            for at in BENCH_30_CALIBRATION["audit_times"]:
                self.at(at, self.job, "background:audit", 2, audit_wall, 2 * audit_wall, noop)

        full_frac = (
            1.0 - scoped_recheck_fraction if scoped_recheck_fraction is not None else shape["full_fraction"]
        )
        self.full_recheck = {i for i in range(len(rows)) if self.keyed_rng(i, 29).random() < full_frac}
        self.extra_refusal = {i for i in range(len(rows)) if self.keyed_rng(i, 37).random() < refusal_rate}
        self.pins, self.prepared = {}, {}
        self.generations, self.started_at, self.first_pass = Counter(), {}, {}
        self.last_kind, self.last_pass_at, self.check_to_commit = {}, {}, {}
        self.overtaken = {}
        self.last_main_move = Counter()
        self.parked, self.parked_batches = {}, {}
        self.order_wait = Counter()
        self.pending_checks = []  # (order_key, prio, queued_at, seq, tag, payload)
        self.q_seq = 0
        self.batches, self.batch_seq = {}, 0
        self.force_full, self.admitted = set(), set()

    def incompatible_pairs(self, base):
        adjacent = [set() for _ in self.rows]
        for i, paths in self.paths.items():
            for distance in range(1, min(i, base["pair_span"]) + 1):
                older = i - distance
                mark = self.keyed_rng(i, distance).random()
                if not paths.isdisjoint(self.paths[older]) and mark < 0.01:
                    adjacent[i].add(older)
                    adjacent[older].add(i)
        return adjacent

    def slots_saturated(self, slots=None):
        needed = self.shape["full_slots"] if slots is None else slots
        return bool(self.waiting) or bool(self.pending_checks) or (self.used + needed > self.capacity)

    def dispatch(self):
        super().dispatch()
        self.dispatch_checks()

    def release(self, slots, done, args):
        self.used -= slots
        self.dispatch()
        done(*args)

    def check_kind_for(self, i, is_recheck=False):
        if i in self.force_full or not is_recheck:
            return "full"
        if i in self.full_recheck:
            return "full"
        # Decided once, when the check takes its slots (run_single): no slot left for the next entry.
        # Dispatch only sizes the slot request, which the lever needs equal for both kinds.
        if self.full_recheck_saturated and getattr(self, "_starting", False):
            needed = self.shape["full_slots"]
            if self.waiting or self.pending_checks or self.used + needed >= self.capacity:
                return "full"
            if self.hold_deciding and any(peer != i for peer in self.deciding):
                return "full"
        return "scoped"

    def enqueue_check(self, order_key, tag, payload, priority=1):
        self.q_seq += 1
        self.pending_checks.append((order_key, priority, self.now, self.q_seq, tag, payload))
        self.dispatch_checks()

    def submit(self, i):
        for path in self.paths[i]:
            self.path_offers[path].append(i)
        self.live.add(i)
        if self.batching and not self.strict_admission_only_batch:
            self.enqueue_check(i, "ready", (i, False))
        else:
            self.enqueue_check(i, "fixed", [i])

    def _queue_sort_key(self, item):
        order_key, priority, queued_at, seq, _, _ = item
        if self.dispatch_order == "fifo":
            return (priority, queued_at, seq)
        return (order_key, seq)

    def _select_batch_indices(self, anchor_i, anchor_rec):
        """Pick up to max_batch compatible ready entries without introducing a path-order cycle.

        `min_fresh_batch=None` batches only entries that already passed their own check
        (today's admitted cohorts); a fresh arrival always checks alone.
        """
        if not anchor_rec and self.min_fresh_batch is None:
            return [0]
        same_class = [
            (idx, payload[0])
            for idx, (_, _, _, _, tag, payload) in enumerate(self.pending_checks)
            if tag == "ready" and payload[1] == anchor_rec
        ]
        if len(same_class) < 2:
            return [0]
        all_pending = []
        for idx, (_, _, _, _, tag, payload) in enumerate(self.pending_checks):
            if tag == "fixed":
                for member in payload:
                    all_pending.append((member, idx))
            else:
                all_pending.append((payload[0], idx))
        all_pending.sort()
        chosen_set, chosen_members = {0}, [anchor_i]
        for idx, cand_i in sorted(same_class, key=lambda pair: pair[1]):
            if idx == 0:
                continue
            if len(chosen_set) >= self.max_batch:
                break
            cand_members = sorted(chosen_members + [cand_i])
            lo, hi = cand_members[0], cand_members[-1]
            cand_set = chosen_set | {idx}
            cycle = False
            for other, other_idx in all_pending:
                if other_idx in cand_set or other <= lo or other >= hi:
                    continue
                other_paths = self.paths[other]
                if any(m < other and not other_paths.isdisjoint(self.paths[m]) for m in cand_members):
                    if any(m > other and not other_paths.isdisjoint(self.paths[m]) for m in cand_members):
                        cycle = True
                        break
            if not cycle:
                chosen_set, chosen_members = cand_set, cand_members
        min_size = 2 if anchor_rec else self.min_fresh_batch
        return sorted(chosen_set) if len(chosen_set) >= min_size else [0]

    def dispatch_checks(self):
        while self.pending_checks:
            self.pending_checks.sort(key=self._queue_sort_key)
            _, _, queued_at, _, tag, payload = self.pending_checks[0]
            if tag == "fixed":
                members = payload
                slots = (
                    self.shape["full_slots"]
                    if len(members) > 1
                    else self.shape[f"{self.check_kind_for(members[0], members[0] in self.admitted)}_slots"]
                )
                if self.used + slots > self.capacity:
                    return
                self.pending_checks.pop(0)
                for member in members:
                    self.ci_wait[member] += self.now - queued_at
                if len(members) == 1:
                    self.run_single(members[0], is_recheck=(members[0] in self.admitted))
                else:
                    self.run_batch(members)
                continue
            anchor_i, anchor_rec = payload
            chosen = self._select_batch_indices(anchor_i, anchor_rec)
            solo_kind = self.check_kind_for(anchor_i, is_recheck=anchor_rec)
            needed = self.shape["full_slots"] if len(chosen) >= 2 else self.shape[f"{solo_kind}_slots"]
            if self.used + needed > self.capacity:
                return
            chosen_set = set(chosen)
            picked = [self.pending_checks[idx] for idx in chosen]
            self.pending_checks = [item for idx, item in enumerate(self.pending_checks) if idx not in chosen_set]
            for _, _, q_at, _, _, (member, _) in picked:
                self.ci_wait[member] += self.now - q_at
            if len(picked) == 1:
                member, is_rec = picked[0][5]
                self.run_single(member, is_recheck=is_rec)
            else:
                self.run_batch([item[5][0] for item in picked])

    def _start_pool_job(self, kind, slots, wall, work, done, *args):
        assert self.used + slots <= self.capacity
        self.used += slots
        self.peak = max(self.peak, self.used)
        self.slot_minutes += max(0, min(self.end, self.now + wall) - max(self.start, self.now)) * slots
        self.cost[kind] += work
        self.count[kind] += 1
        self.at(self.now + wall, self.release, slots, done, args)

    def run_single(self, i, is_recheck=False):
        self.pins[i] = self.prepared[i] = len(self.pub)
        self.generations[i] += 1
        self.started_at[i] = self.now
        self._starting = True
        kind = self.check_kind_for(i, is_recheck=is_recheck)
        self._starting = False
        self.last_kind[i] = kind
        slots, wall, work = (self.shape[f"{kind}_{key}"] for key in ("slots", "minutes", "worker_minutes"))
        bad = self.invalid_single(i)
        transient = not bad and self.flakes.random() < self.flake
        factor = self.timing.lognormvariate(0, self.sigma)
        total_wall = wall * factor + self.check_overhead_min
        total_work = work * factor + self.check_overhead_min * slots
        self._start_pool_job(kind, slots, total_wall, total_work, self.incumbent_done, i, bad, transient)
        if i in self.overtaken:
            self.wake_parked()

    def incumbent_done(self, i, bad, transient):
        if bad:
            self.reject(i)
            self.wake_parked()
        elif transient:
            self.stats["transient"] += 1
            self.enqueue_check(i, "fixed", [i], priority=0)
        else:
            if self.hold_deciding and i not in self.first_pass:
                self.deciding[i] = self.now
            self.admitted.add(i)
            self.first_pass.setdefault(i, self.now)
            self.last_pass_at[i] = self.now
            self.settle(i)

    def blocked(self, i, members=()):
        for path in self.paths[i]:
            offers = self.path_offers[path]
            while offers and offers[0] not in self.live:
                offers.popleft()
            # A held entry holds no queue order (the code's cohort hold), so peers it awaits pass it.
            first = next((o for o in offers if o not in self.held), None)
            if first is not None and first < i and first not in members:
                return True
        return any(
            older < i
            and older not in members
            and generation != self.generations[older]
            and self.started_at[older] <= self.first_pass[i]
            for older, generation in self.overtaken.items()
        )

    def stale_reason(self, i):
        if any(self.last_main_move[path] > self.pins[i] for path in self.paths[i]):
            return "related"
        if len(self.pub) != self.pins[i]:
            if i in self.extra_refusal and self.generations[i] == 1:
                return "refusal"
            if self.last_kind.get(i) != "full":
                if self.skip_stale and self.slots_saturated(self.shape["scoped_slots"]):
                    self.stats["stale_pass_kept"] += 1
                    return None
                return "scoped"
        return None

    def discarded(self, i):
        self.stop_deciding(i)
        self.source_job("recompose", self.enqueue_recheck, i)

    def stop_deciding(self, i):
        if self.deciding.pop(i, None) is None:
            return
        oldest = min(self.deciding.values(), default=None)
        for held, since in sorted(self.held.items()):
            if oldest is None or oldest > since:
                self.release_hold(held)

    def release_hold(self, i):
        if i in self.held:
            self.hold_waits[i] = self.now - self.held.pop(i)
            self.enqueue_check(i, "ready", (i, True))

    def enqueue_recheck(self, i):
        if self.batching and self.hold_deciding and i not in self.hold_waits and self.deciding:
            self.held[i] = self.now
            self.at(self.now + HOLD_MINUTES, self.release_hold, i)
        elif self.batching:
            self.enqueue_check(i, "ready", (i, True))
        else:
            self.enqueue_check(i, "fixed", [i])

    def settle(self, i):
        if self.blocked(i):
            if i not in self.parked:
                self.stats["order_holds"] += 1
                self.parked[i] = self.now
            return
        if i in self.parked:
            self.order_wait[i] += self.now - self.parked.pop(i)
        reason = self.stale_reason(i)
        if reason:
            self.stats[reason + "_rechecks"] += 1
            if reason == "related" and self.skip_stale and self.slots_saturated(self.shape["full_slots"]):
                self.force_full.add(i)
            self.discarded(i)
        elif self.prepared[i] != len(self.pub):
            self.source_job("recompose", self.carried, i, len(self.pub))
        else:
            self.source_job("commit", self.incumbent_publish, i)

    def carried(self, i, main_position):
        self.prepared[i] = main_position
        self.stats["carried"] += 1
        self.settle(i)

    def reject(self, i):
        self.stop_deciding(i)
        self.overtaken.pop(i, None)
        super().reject(i)

    def _mark_overtaken(self, upper, excluded):
        if self.skip_stale and self.slots_saturated(self.shape["scoped_slots"]):
            return
        for older in self.live:
            if older < upper and older not in excluded and self.last_kind.get(older) == "scoped":
                self.overtaken.setdefault(older, self.generations[older])

    def incumbent_publish(self, i):
        if self.prepared[i] != len(self.pub):
            self.settle(i)
            return
        self._mark_overtaken(i, {i})
        self.overtaken.pop(i, None)
        self.publish(i)
        self.stop_deciding(i)
        self.check_to_commit[i] = self.now - self.last_pass_at[i]
        for path in self.paths[i]:
            self.last_main_move[path] = len(self.pub)
        self.wake_parked()

    def _batch_verdict(self, members):
        bad_members = [m for m in members if self.invalid_single(m)]
        pair_bad = any(
            m2 in self.pairs[m1] for idx, m1 in enumerate(members) for m2 in members[idx + 1 :]
        )
        return bool(bad_members) or pair_bad, bad_members

    def run_batch(self, members):
        members = sorted(members)
        self.batch_seq += 1
        bid = self.batch_seq
        self.stats["batches_started"] += 1
        self.stats["batch_members_started"] += len(members)
        pin = len(self.pub)
        self.batches[bid] = {"id": bid, "members": members, "pin": pin, "prepared": pin, "started_at": self.now}
        for member in members:
            self.pins[member] = self.prepared[member] = pin
            self.generations[member] += 1
            self.started_at[member] = self.now
            self.last_kind[member] = "full"
        bad, bad_members = self._batch_verdict(members)
        transient = not bad and self.flakes.random() < self.flake
        factor = self.timing.lognormvariate(0, self.sigma)
        slots, wall, work = (self.shape[f"full_{key}"] for key in ("slots", "minutes", "worker_minutes"))
        total_wall = wall * factor + self.check_overhead_min
        total_work = work * factor + self.check_overhead_min * slots
        self._start_pool_job("batch_full", slots, total_wall, total_work, self.batch_done, bid, bad, bad_members, transient)
        if any(member in self.overtaken for member in members):
            self.wake_parked()

    def batch_done(self, bid, bad, bad_members, transient):
        members = self.batches[bid]["members"]
        if bad:
            self.batches.pop(bid)
            self.stats["batch_splits"] += 1
            if self.split_mode == "suspects" and bad_members:
                suspects = set(bad_members)
                clean = [m for m in members if m not in suspects]
                if clean:
                    self.enqueue_check(clean[0], "fixed", clean, priority=0)
                for suspect in bad_members:
                    self.enqueue_check(suspect, "fixed", [suspect], priority=0)
            else:
                middle = (len(members) + 1) // 2
                for half in (members[:middle], members[middle:]):
                    if half:
                        self.enqueue_check(half[0], "fixed", half, priority=0)
        elif transient:
            self.stats["transient"] += 1
            self.batches.pop(bid)
            self.enqueue_check(members[0], "fixed", members, priority=0)
        else:
            for member in members:
                self.admitted.add(member)
                self.first_pass.setdefault(member, self.now)
                self.last_pass_at[member] = self.now
            self.settle_batch(bid)

    def settle_batch(self, bid):
        if bid not in self.batches:
            return
        batch = self.batches[bid]
        member_set = set(batch["members"])
        if any(self.blocked(member, member_set) for member in batch["members"]):
            if bid not in self.parked_batches:
                self.stats["order_holds"] += 1
                self.parked_batches[bid] = self.now
            return
        if bid in self.parked_batches:
            wait = self.now - self.parked_batches.pop(bid)
            for member in batch["members"]:
                self.order_wait[member] += wait
        pin = batch["pin"]
        if any(self.last_main_move[path] > pin for member in batch["members"] for path in self.paths[member]):
            self.stats["related_rechecks"] += 1
            members = self.batches.pop(bid)["members"]
            self.source_job("recompose", self.requeue_batch, members)
        elif batch["prepared"] != len(self.pub):
            self.source_job("recompose", self.batch_carried, bid, len(self.pub))
        else:
            self.source_job("commit", self.publish_batch, bid)

    def requeue_batch(self, members):
        for member in members:
            self.enqueue_check(member, "ready", (member, True))

    def batch_carried(self, bid, main_position):
        if bid not in self.batches:
            return
        self.batches[bid]["prepared"] = main_position
        self.stats["carried"] += 1
        self.settle_batch(bid)

    def publish_batch(self, bid):
        if bid not in self.batches:
            return
        batch = self.batches[bid]
        if batch["prepared"] != len(self.pub):
            self.settle_batch(bid)
            return
        members = self.batches.pop(bid)["members"]
        self.stats["batches_landed"] += 1
        self.stats["batch_members_landed"] += len(members)
        self._mark_overtaken(max(members), set(members))
        for member in members:
            self.overtaken.pop(member, None)
            self.publish(member)
            self.check_to_commit[member] = self.now - self.last_pass_at[member]
            for path in self.paths[member]:
                self.last_main_move[path] = len(self.pub)
        self.wake_parked()

    def wake_parked(self):
        for i in sorted(self.parked):
            self.settle(i)
        for bid in sorted(self.parked_batches):
            self.settle_batch(bid)

    def measure(self):
        result = super().measure()
        assert not self.parked and not self.parked_batches and not self.batches and not self.pending_checks
        assert not self.held
        scored = [i for i in self.pub if self.start <= self.rows[i][0] < self.end]
        scored_landed = sum(self.pub[i] < self.end for i in scored)
        before, after = result["pending"]
        landed = len(self.pub)
        landing_checks = self.count["full"] + self.count["scoped"] + self.count["batch_full"]
        landing_work = self.cost["full"] + self.cost["scoped"] + self.cost["batch_full"]
        extra = {
            "scored_landed": scored_landed,
            "flow": scored_landed >= 0.95 * result["viable"] and after - before <= 0.05 * result["offered"],
            "checks_per_landing": landing_checks / landed if landed else None,
            "worker_minutes_per_landing": landing_work / landed if landed else None,
            "order_wait_p90": nearest([self.order_wait[i] for i in scored], 0.9),
            "held": len(self.hold_waits),
            "hold_wait_p50": nearest(list(self.hold_waits.values()), 0.5) or 0.0,
            "hold_wait_p90": nearest(list(self.hold_waits.values()), 0.9) or 0.0,
            "check_to_commit_p90_s": (nearest([self.check_to_commit[i] for i in scored], 0.9) or 0.0) * 60.0,
        }
        if self.bench_mode:
            extra["stationary_per_hour"] = sum(10.0 <= t < 60.0 for t in self.pub.values()) / (50.0 / 60.0)
            extra["pending_greens_60"] = sum(
                1 for i in range(len(self.rows)) if i not in self.solo and self.pub.get(i, 1e9) >= 60.0
            )
        return result | extra
