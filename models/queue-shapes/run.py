# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Ferdinando Valsecchi
"""Discrete-event CI pool and the parallel singleton arm from the queue refit."""

import heapq
import math
import random
import statistics
from collections import Counter, deque


def noop():
    pass


def nearest(values, q):
    ordered = sorted(values)
    return ordered[math.ceil(q * len(ordered)) - 1] if ordered else None


class Pool:
    def __init__(self, capacity):
        self.capacity = capacity
        self.events, self.waiting = [], deque()
        self.cost, self.count = Counter(), Counter()
        self.now = self.serial = self.peak = self.used = 0
        self.slot_minutes = 0
        self.ci_wait = Counter()

    def at(self, when, callback, *args):
        self.serial += 1
        heapq.heappush(self.events, (when, self.serial, callback, args))

    def job(self, kind, slots, wall, work, done, *args):
        assert 0 < slots <= self.capacity and 0 < work <= slots * wall + 1e-8
        self.waiting.append((kind, slots, wall, work, self.now, done, args))
        self.dispatch()

    def dispatch(self):
        blocked = deque()
        while self.waiting and self.used < self.capacity:
            request = self.waiting.popleft()
            kind, slots, wall, work, queued_at, done, args = request
            if slots + self.used > self.capacity:
                blocked.append(request)
                continue
            self.used += slots
            self.peak = max(self.peak, self.used)
            self.slot_minutes += max(0, min(self.end, self.now + wall) - max(self.start, self.now)) * slots
            self.cost[kind] += work
            self.count[kind] += 1
            if kind in ("full", "scoped"):
                self.ci_wait[args[0]] += self.now - queued_at
            self.at(self.now + wall, self.release, slots, done, args)
        self.waiting.extendleft(reversed(blocked))

    def release(self, slots, done, args):
        self.used -= slots
        self.dispatch()
        done(*args)

    def drain(self):
        while self.events:
            self.now, _, done, args = heapq.heappop(self.events)
            done(*args)
        assert self.used == 0 and not self.waiting


class Model(Pool):
    def __init__(self, base, rows, seed, hold=False):
        profile = base["profile"]
        super().__init__(profile["capacity"])
        self.rows, self.seed = rows, seed
        self.t, self.u, self.jobs = (profile[key] for key in ("T", "U", "jobs"))
        self.start = base["warm_hours"] * 60
        self.end = self.start + base["score_hours"] * 60
        self.flake = base["flake"]
        self.pd = (profile["p"] - self.flake) / (1 - self.flake)
        self.solo = {i for i, row in enumerate(rows) if row[1] < self.pd}
        self.pairs = self.incompatible_pairs(base)
        self.timing, self.flakes = (random.Random(seed + offset) for offset in (1, 2))
        capture = base["capture"]
        median, high = capture["check_q"]
        self.sigma = math.log(high / median) / statistics.NormalDist().inv_cdf(.9)
        self.discard = capture["discard"] / capture["landings"]
        self.hold = [minutes * self.t / median for minutes in base["hold_samples"]] if hold else [0]
        self.race = {}
        self.live = set()
        self.pub, self.rej = {}, {}
        self.stats = Counter()
        for i, row in enumerate(rows):
            self.at(row[0], self.submit, i)

    def incompatible_pairs(self, base):
        adjacent = [set() for _ in self.rows]
        for i in range(len(self.rows)):
            for distance in range(1, min(i, base["pair_span"]) + 1):
                older = i - distance
                mark = random.Random(self.seed * 1000003 + i * 31 + distance).random()
                if mark < base["pair_probability"]:
                    adjacent[i].add(older)
                    adjacent[older].add(i)
        return adjacent

    def keyed_rng(self, i, tag):
        return random.Random(self.seed * 1000003 + i * 31 + tag)

    def submit(self, i):
        self.live.add(i)
        self.incumbent(i)

    def invalid_single(self, i):
        return i in self.solo or not self.pairs[i].isdisjoint(self.pub)

    def incumbent(self, i):
        self.check(i, "full", self.jobs, self.t, self.u)

    def check(self, i, kind, slots, wall, work):
        bad = self.invalid_single(i)
        transient = not bad and self.flakes.random() < self.flake
        factor = self.timing.lognormvariate(0, self.sigma)
        self.job(kind, slots, wall * factor, work * factor, self.incumbent_done, i, bad, transient)

    def incumbent_done(self, i, bad, transient):
        if bad:
            self.reject(i)
        elif transient:
            self.stats["transient"] += 1
            self.incumbent(i)
        else:
            if i not in self.race:
                self.race[i] = self.keyed_rng(i, 13)
            if self.race[i].random() < self.discard / (1 + self.discard):
                self.stats["discard"] += 1
                self.discarded(i)
            else:
                hold = self.keyed_rng(i, 12).choice(self.hold)
                self.at(self.now + hold, self.settle, i)

    def publish(self, i):
        assert not self.invalid_single(i)
        self.live.remove(i)
        self.pub[i] = self.now

    def reject(self, i):
        self.live.remove(i)
        self.rej[i] = self.now

    def measure(self):
        self.drain()
        assert not self.live and len(self.pub) + len(self.rej) == len(self.rows)
        scored = [i for i, row in enumerate(self.rows) if self.start <= row[0] < self.end]
        delivered = sum(self.start <= stamp < self.end for stamp in self.pub.values())
        successful = [i for i in scored if i in self.pub]
        latency = [self.pub[i] - self.rows[i][0] for i in successful]
        landed = len(self.pub)
        hours = (self.end - self.start) / 60

        def pending(t):
            return (sum(row[0] < t for row in self.rows)
                    - sum(x < t for x in self.pub.values()) - sum(x < t for x in self.rej.values()))

        before, after = pending(self.start), pending(self.end)
        viable = sum(i not in self.solo for i in scored)
        landing_checks = self.count["full"] + self.count["scoped"]
        landing_work = self.cost["full"] + self.cost["scoped"]
        return dict(
            flow=delivered >= .95 * viable and after - before <= .05 * len(scored),
            offered=len(scored), viable=viable, per_hour=delivered / hours,
            p50=nearest(latency, .5), p90=nearest(latency, .9), pending=[before, after],
            landed=landed, rejected=len(self.rej),
            checks_per_landing=landing_checks / landed if landed else None,
            worker_minutes_per_landing=landing_work / landed if landed else None,
            all_worker_minutes_per_landing=sum(self.cost.values()) / landed if landed else None,
            ci_wait_p90=nearest([self.ci_wait[i] for i in successful], .9),
            ci_utilization=self.slot_minutes / ((self.end - self.start) * self.capacity),
            peak=self.peak, counts=dict(self.count), stats=dict(self.stats),
        )
