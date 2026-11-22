"""Measured competing CI jobs and serial publication from the refit's today arm."""

import random
from collections import deque

from run import Model, noop


class Experiment(Model):
    def __init__(self, base, rows, seed, station, measured, hold=False):
        super().__init__(base, rows, seed, hold)
        self.station = station
        self.source_rng = random.Random(seed + 71)
        self.source_jobs = deque()
        self.source_busy = False
        self.source_use = 0
        for at, duration, purpose in measured:
            self.at(at, self.job, "background:" + purpose, 1, duration, duration, noop)

    def source_job(self, kind, done, *args):
        duration = self.source_rng.choice(self.station[kind + "_seconds"]) / 60
        self.source_jobs.append((kind, duration, done, args))
        self.source_dispatch()

    def source_dispatch(self):
        if self.source_busy or not self.source_jobs:
            return
        kind, minutes, done, args = self.source_jobs.popleft()
        self.source_busy = True
        self.stats["source_" + kind] += 1
        self.source_use += max(0, min(self.end, self.now + minutes) - max(self.start, self.now))
        self.at(self.now + minutes, self.source_done, done, args)

    def source_done(self, done, args):
        self.source_busy = False
        done(*args)
        self.source_dispatch()

    def discarded(self, i):
        self.source_job("recompose", self.incumbent, i)

    def settle(self, i):
        if self.invalid_single(i):
            self.discarded(i)
        else:
            self.source_job("commit", self.incumbent_publish, i)

    def incumbent_publish(self, i):
        if self.invalid_single(i):
            self.discarded(i)
        else:
            self.publish(i)

    def measure(self):
        result = super().measure()
        assert not self.source_busy and not self.source_jobs
        return result | {"source_utilization": self.source_use / (self.end - self.start)}
