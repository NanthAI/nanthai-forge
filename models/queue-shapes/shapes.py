"""Run the paired queue shapes or the original measured-load refit arm."""

import argparse
import json
import random
from collections import Counter, defaultdict, deque
from pathlib import Path

from publisher.experiment import Experiment
from run import nearest

HERE = Path(__file__).resolve().parent


class ShapeExperiment(Experiment):
    def __init__(self, base, rows, seed, station, measured, shape):
        self.shape = shape
        self.paths = {}
        self.path_offers = defaultdict(deque)
        for i in range(len(rows)):
            rng = random.Random(seed * 1000003 + i * 31 + 27)
            self.paths[i] = {rng.randrange(shape["packages"])}
            if rng.random() < shape["shared_path_fraction"]:
                self.paths[i].add("shared")
        super().__init__(base, rows, seed, station, measured)
        self.full = {i for i in range(len(rows)) if self.keyed_rng(i, 29).random() < shape["full_fraction"]}
        self.pins, self.prepared = {}, {}
        self.generations, self.started_at, self.first_pass = Counter(), {}, {}
        self.overtaken = {}
        self.last_main_move = Counter()
        self.parked = {}
        self.order_wait = Counter()

    def incompatible_pairs(self, base):
        # The original pair probability came from path overlap times an assumed 1% breakage rate.
        adjacent = [set() for _ in self.rows]
        for i, paths in self.paths.items():
            for distance in range(1, min(i, base["pair_span"]) + 1):
                older = i - distance
                mark = self.keyed_rng(i, distance).random()
                if not paths.isdisjoint(self.paths[older]) and mark < .01:
                    adjacent[i].add(older)
                    adjacent[older].add(i)
        return adjacent

    def submit(self, i):
        for path in self.paths[i]:
            self.path_offers[path].append(i)
        super().submit(i)

    def incumbent(self, i):
        self.pins[i] = self.prepared[i] = len(self.pub)
        self.generations[i] += 1
        self.started_at[i] = self.now
        kind = "full" if i in self.full else "scoped"
        self.check(i, kind, *(self.shape[f"{kind}_{key}"] for key in ("slots", "minutes", "worker_minutes")))
        if i in self.overtaken:
            self.wake_parked()

    def incumbent_done(self, i, bad, transient):
        if bad:
            self.reject(i)
            self.wake_parked()
        elif transient:
            self.stats["transient"] += 1
            self.incumbent(i)
        else:
            self.first_pass.setdefault(i, self.now)
            self.settle(i)

    def blocked(self, i):
        for path in self.paths[i]:
            offers = self.path_offers[path]
            while offers and offers[0] not in self.live:
                offers.popleft()
            if offers and offers[0] < i:
                return True
        return any(
            older < i and generation != self.generations[older]
            and self.started_at[older] <= self.first_pass[i]
            for older, generation in self.overtaken.items()
        )

    def stale_reason(self, i):
        if any(self.last_main_move[path] > self.pins[i] for path in self.paths[i]):
            return "related"
        if i not in self.full and len(self.pub) != self.pins[i]:
            return "scoped"
        return None

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
        self.overtaken.pop(i, None)
        super().reject(i)

    def incumbent_publish(self, i):
        # The serial source queue can advance main before this commit gets its slot.
        if self.prepared[i] != len(self.pub):
            self.settle(i)
            return
        # Scope-limited evidence cannot carry across heads. Let younger disjoint
        # work past once, then honor the older generation unless the younger pass
        # predates the older replacement.
        for older in self.live.difference(self.full):
            if older < i:
                self.overtaken.setdefault(older, self.generations[older])
        self.overtaken.pop(i, None)
        self.publish(i)
        for path in self.paths[i]:
            self.last_main_move[path] = len(self.pub)
        self.wake_parked()

    def wake_parked(self):
        for i in sorted(self.parked):
            self.settle(i)

    def measure(self):
        result = super().measure()
        assert not self.parked
        scored = [i for i in self.pub if self.start <= self.rows[i][0] < self.end]
        scored_landed = sum(self.pub[i] < self.end for i in scored)
        before, after = result["pending"]
        return result | {
            "scored_landed": scored_landed,
            "flow": scored_landed >= .95 * result["viable"] and after - before <= .05 * result["offered"],
            "full_share_landed": len(self.full.intersection(self.pub)) / len(self.pub) if self.pub else None,
            "order_wait_p90": nearest([self.order_wait[i] for i in scored], .9),
        }


def read(name):
    return json.loads((HERE / name).read_bytes())


def replay(refit=False):
    base, shapes = read("base.json"), read("shapes.json")
    station = read("publisher/measurements.json")["service"]
    background = read("publisher/background.json")
    for seed in base["seeds"]:
        jobs = background[str(seed)]
        if refit:
            for rate in (15, 30, 60):
                rows = base["traces"][f"B/{rate}/{seed}"]
                for hold in (False, True):
                    model = Experiment(base, rows, seed, station, jobs, hold)
                    yield dict(shape=f"refit-{rate}", seed=seed, historical_hold=hold, **model.measure())
            continue
        jobs = [job for job in jobs if job[2] != "github-mirror-verify"]
        for name, overrides in shapes.items():
            shape = shapes["baseline"] | overrides
            rate = shape["trace_rate"]
            keep = shape["offers_per_hour"] * (1 - base["profile"]["p"]) / rate
            rows = [row for row in base["traces"][f"B/{rate}/{seed}"] if row[2] < keep]
            model = ShapeExperiment(base, rows, seed, station, jobs, shape)
            yield dict(shape=name, seed=seed, **model.measure())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refit", action="store_true", help="replay the earlier incumbent arm unchanged")
    args = parser.parse_args()
    print(json.dumps(list(replay(args.refit)), indent=2, allow_nan=False))
