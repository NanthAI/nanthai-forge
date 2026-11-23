# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Ferdinando Valsecchi
"""Regression coverage for the order and scoring assumptions in the shape arm."""

import unittest

from arms import BENCH_30_CALIBRATION, BENCH_30_SHAPE, CalibratedShapeExperiment, bench_30_rows
from shapes import ShapeExperiment, bench_replay, read, replay


class ShapeTest(unittest.TestCase):
    def model(self, rows, full_minutes, scoped_minutes, full, warm_hours=0):
        base = read("base.json")
        base["warm_hours"], base["score_hours"], base["flake"] = warm_hours, 1, 0
        base["capture"]["check_q"] = [10, 10]
        shape = read("shapes.json")["baseline"] | {
            "full_minutes": full_minutes, "full_worker_minutes": full_minutes, "full_slots": 1,
            "scoped_minutes": scoped_minutes, "scoped_worker_minutes": scoped_minutes, "scoped_slots": 1,
        }
        station = {"commit_seconds": [1], "recompose_seconds": [1]}
        model = ShapeExperiment(base, rows, 137, station, [], shape)
        model.full = full
        model.paths = {i: {i} for i in range(len(rows))}
        model.pairs = [set() for _ in rows]
        return model

    def test_disjoint_main_advance_requires_another_scoped_check(self):
        model = self.model([[0, .99], [1, .99]], full_minutes=2, scoped_minutes=8, full={1})
        result = model.measure()
        self.assertEqual(list(model.pub), [1, 0])
        self.assertEqual(result["counts"], {"full": 1, "scoped": 2})
        self.assertEqual(result["stats"]["scoped_rechecks"], 1)

    def test_disjoint_reusable_full_pass_charges_compose_without_another_check(self):
        model = self.model([[0, .99], [1, .99]], full_minutes=8, scoped_minutes=2, full={0})
        result = model.measure()
        self.assertEqual(list(model.pub), [1, 0])
        self.assertEqual(result["counts"], {"full": 1, "scoped": 1})
        self.assertEqual(result["stats"]["source_recompose"], 1)

    def test_spent_overtake_protects_the_older_replacement_from_a_later_pass(self):
        model = self.model([[0, .99], [1, .99], [9, .99]], full_minutes=2, scoped_minutes=8, full={1, 2})
        result = model.measure()
        self.assertEqual(list(model.pub), [1, 0, 2])
        self.assertEqual(result["stats"]["order_holds"], 1)

    def test_warmup_landing_cannot_lift_scored_delivery_over_the_flow_threshold(self):
        model = self.model([[59, .99], [119, .99]], full_minutes=2, scoped_minutes=2, full={0, 1}, warm_hours=1)
        result = model.measure()
        self.assertEqual(result["per_hour"], 1)
        self.assertEqual(result["viable"], 1)
        self.assertEqual(result["pending"], [1, 1])
        self.assertEqual(result["scored_landed"], 0)
        self.assertFalse(result["flow"])


class CalibratedArmsTest(unittest.TestCase):
    def calibrated(self, rows, *, capacity=2, full_minutes=4, scoped_minutes=2, paths=None, solo=None, pairs=None, **kwargs):
        base = read("base.json")
        base["warm_hours"], base["score_hours"], base["flake"] = 0, 2, 0
        base["capture"]["check_q"] = [10, 10]
        shape = read("shapes.json")["baseline"] | {
            "full_minutes": full_minutes,
            "full_worker_minutes": full_minutes,
            "full_slots": 1,
            "scoped_minutes": scoped_minutes,
            "scoped_worker_minutes": scoped_minutes,
            "scoped_slots": 1,
        }
        station = {"commit_seconds": [1], "recompose_seconds": [1]}
        model = CalibratedShapeExperiment(
            base, rows, 137, station, [], shape, capacity_override=capacity, **kwargs
        )
        if paths is not None:
            model.paths = paths
        else:
            model.paths = {i: {i} for i in range(len(rows))}
        model.solo = set() if solo is None else set(solo)
        model.pairs = [set() for _ in rows] if pairs is None else pairs
        return model

    def test_batching_never_holds_a_landing_when_a_slot_is_free(self):
        model = self.calibrated([[0, 0.99], [1, 0.99]], capacity=2, full_minutes=4, batching=True, min_fresh_batch=2)
        result = model.measure()
        self.assertEqual(result["stats"].get("batches_started", 0), 0)
        self.assertAlmostEqual(model.pub[0], 4 + 1 / 60, places=3)
        # Arrival 1 starts immediately at t=1 (zero wait), finishes check at t=5, carries via 1s recompose + 1s commit.
        self.assertAlmostEqual(model.pub[1], 5 + 2 / 60, places=3)

    def test_batching_groups_queued_landings_and_splits_solo_culprit(self):
        # Slot 0 is occupied by arrival 0 (t=0..4); arrivals 1,2,3 queue and batch at t=4; arrival 2 is solo-red.
        model = self.calibrated(
            [[0, 0.99], [1, 0.99], [2, 0.99], [3, 0.99]],
            capacity=1,
            full_minutes=4,
            batching=True,
            min_fresh_batch=2,
            solo={2},
        )
        result = model.measure()
        self.assertEqual(sorted(model.pub), [0, 1, 3])
        self.assertEqual(sorted(model.rej), [2])
        self.assertGreaterEqual(result["stats"]["batches_started"], 2)
        self.assertEqual(result["stats"]["batch_splits"], 1)

    def test_admitted_only_batching_never_groups_a_landing_without_its_own_pass(self):
        # Same saturated queue as the culprit-split case: arrivals 1-3 wait behind arrival 0.
        # With fresh batching off, each fresh arrival checks alone, so solo red 2 delays nobody.
        model = self.calibrated(
            [[0, 0.99], [1, 0.99], [2, 0.99], [3, 0.99]],
            capacity=1,
            full_minutes=4,
            batching=True,
            min_fresh_batch=None,
            solo={2},
        )
        result = model.measure()
        self.assertEqual(sorted(model.pub), [0, 1, 3])
        self.assertEqual(sorted(model.rej), [2])
        self.assertEqual(result["stats"].get("batches_started", 0), 0)
        self.assertEqual(result["counts"]["full"], 4)

    def test_admitted_only_batching_groups_rechecks_of_passed_landings(self):
        # Arrival 0 holds the only slot; arrivals 1 and 2 already passed alone and wait to recheck.
        # When the slot frees they recheck together in one full check and land together.
        model = self.calibrated(
            [[0, 0.99], [0, 0.99], [0, 0.99]],
            capacity=1,
            full_minutes=4,
            batching=True,
            min_fresh_batch=None,
            scoped_recheck_fraction=0.0,
        )
        model.submit(0)
        for i in (1, 2):
            model.live.add(i)
            model.admitted.add(i)
            model.path_offers[i].append(i)
            model.enqueue_check(i, "ready", (i, True))
        model.events = [ev for ev in model.events if ev[2] != model.submit]
        result = model.measure()
        self.assertEqual(sorted(model.pub), [0, 1, 2])
        self.assertEqual(result["stats"]["batches_started"], 1)
        self.assertEqual(result["stats"]["batch_members_landed"], 2)
        self.assertEqual(result["counts"], {"full": 1, "batch_full": 1})

    def test_batching_splits_unattributed_pair_incompatibility_by_halves(self):
        # Pairwise incompatibility occurs only on overlapping paths (matching incompatible_pairs).
        paths = {0: {0}, 1: {"shared"}, 2: {"shared"}, 3: {3}}
        pairs = [set(), {2}, {1}, set()]
        model = self.calibrated(
            [[0, 0.99], [1, 0.99], [2, 0.99], [3, 0.99]],
            capacity=1,
            full_minutes=4,
            batching=True,
            min_fresh_batch=2,
            paths=paths,
            pairs=pairs,
        )
        result = model.measure()
        # Arrival 1 and 2 are pairwise incompatible: [1,2,3] splits into [1,2]+[3], then [1,2] splits into [1]+[2].
        self.assertEqual(sorted(model.pub), [0, 1, 3])
        self.assertEqual(sorted(model.rej), [2])
        self.assertEqual(result["stats"]["batch_splits"], 2)

    def test_acyclic_batch_selection_avoids_deadlock_with_overlapping_fixed_entry(self):
        # Arrival 0 occupies the single slot; arrivals 1,2,3 wait with 2 fixed (overlapping 1 and 3).
        paths = {0: {0}, 1: {"a"}, 2: {"a", "b"}, 3: {"b"}}
        model = self.calibrated(
            [[0, 0.99], [1, 0.99], [2, 0.99], [3, 0.99]],
            capacity=1,
            full_minutes=2,
            batching=True,
            min_fresh_batch=2,
            paths=paths,
        )
        # Mark arrival 2 as fixed after submit to exercise the cycle guard against mixed fixed/ready queues.
        model.submit(0)
        model.enqueue_check(1, "ready", (1, False))
        model.live.add(1)
        model.path_offers["a"].append(1)
        model.enqueue_check(2, "fixed", [2])
        model.live.add(2)
        model.path_offers["a"].append(2)
        model.path_offers["b"].append(2)
        model.enqueue_check(3, "ready", (3, False))
        model.live.add(3)
        model.path_offers["b"].append(3)
        model.events = [ev for ev in model.events if ev[2] != model.submit]
        model.measure()
        self.assertEqual(sorted(model.pub), [0, 1, 2, 3])

    def test_skip_stale_keeps_disjoint_scoped_pass_only_while_saturated_and_rechecks_on_intersection(self):
        # Arrival 0 (t=0..4) lands at ~4.0; arrival 1 (t=0.5..4.5, overlapping p0) enters scoped recheck
        # (t=4.5..10.5, duration 6). Arrival 2 (t=1.5, starts at t=4..8) lands on disjoint p2 at ~8.0 while
        # 1 is still running; arrivals 3 and 4 keep capacity=2 saturated at t=10.5 when 1 finishes.
        paths = {0: {"p0"}, 1: {"p0"}, 2: {"p2"}, 3: {"p3"}, 4: {"p4"}}
        rows = [[0, 0.99], [0.5, 0.99], [1.5, 0.99], [8.5, 0.99], [9.0, 0.99]]
        model_inc = self.calibrated(
            rows, capacity=2, full_minutes=4, scoped_minutes=6, paths=paths, skip_stale=False, scoped_recheck_fraction=1.0
        )
        res_inc = model_inc.measure()
        self.assertGreaterEqual(res_inc["stats"].get("scoped_rechecks", 0), 1)

        model_b = self.calibrated(
            rows, capacity=2, full_minutes=4, scoped_minutes=6, paths=paths, skip_stale=True, scoped_recheck_fraction=1.0
        )
        res_b = model_b.measure()
        self.assertEqual(sorted(model_b.pub), [0, 1, 2, 3, 4])
        self.assertEqual(res_b["stats"].get("scoped_rechecks", 0), 0)
        self.assertGreaterEqual(res_b["stats"].get("stale_pass_kept", 0), 1)

        # On intersecting path move, arm b still runs a recheck (never publishes stale intersecting pass).
        paths_hit = {0: {"p0"}, 1: {"p0"}}
        model_hit = self.calibrated(
            [[0, 0.99], [0.5, 0.99]],
            capacity=2,
            full_minutes=4,
            scoped_minutes=2,
            paths=paths_hit,
            skip_stale=True,
            scoped_recheck_fraction=1.0,
        )
        res_hit = model_hit.measure()
        self.assertEqual(sorted(model_hit.pub), [0, 1])
        self.assertEqual(res_hit["stats"].get("related_rechecks", 0), 1)

    def test_bench_30_calibration_matches_sustained_load_bench_envelope(self):
        rows = list(bench_replay(["incumbent", "strict-8"]))
        by_arm = {arm: [r for r in rows if r["arm"] == arm] for arm in ("incumbent", "strict-8")}
        med = lambda arm, key: sorted(r[key] for r in by_arm[arm])[1]
        # Item b9a2cccd comment 0659ee5e: dogfood 1.70 chk/l, p90 55.1 min; strict-8 1.50 chk/l, p90 38.0 min.
        self.assertGreaterEqual(med("incumbent", "checks_per_landing"), 1.55)
        self.assertLessEqual(med("incumbent", "checks_per_landing"), 1.95)
        self.assertGreaterEqual(med("strict-8", "checks_per_landing"), 1.40)
        self.assertLessEqual(med("strict-8", "checks_per_landing"), 1.70)
        self.assertLess(med("strict-8", "checks_per_landing"), med("incumbent", "checks_per_landing"))
        self.assertLess(med("strict-8", "p90"), med("incumbent", "p90"))

    def test_option_b_beats_the_incumbent_at_every_seed_with_a_hold_bounded_at_five_minutes(self):
        # Item 10b0a94b, owner decision 2026-11-22 (option B): both levers with today's deciding-peer hold.
        rows = list(bench_replay(["incumbent", "option-b"]))
        for seed in read("base.json")["seeds"]:
            inc, b = (next(r for r in rows if r["arm"] == arm and r["seed"] == seed) for arm in ("incumbent", "option-b"))
            for key in ("p50", "p90", "checks_per_landing", "worker_minutes_per_landing", "pending_greens_60"):
                self.assertLessEqual(b[key], inc[key], f"{key} at seed {seed}")
            self.assertGreaterEqual(b["per_hour"], inc["per_hour"])
            self.assertLessEqual(b["hold_wait_p90"], 5.0)

    def test_option_c_keeps_option_b_flow_on_bench_30_and_counts_only_holders_that_land_first(self):
        # Item 196d5e4e option C (lead 2026-11-23): lever 2 only when a slot holder can land first.
        # Comment 6d898eb6's cell: 90% of rechecks narrow, a scoped run at 0.47 of a full run's jobs.
        rows = list(bench_replay(["option-b", "option-c"], narrow=0.9, scoped_jobs=0.47))
        for seed in read("base.json")["seeds"]:
            b, c = (next(r for r in rows if r["arm"] == arm and r["seed"] == seed) for arm in ("option-b", "option-c"))
            self.assertLessEqual(c["p90"], b["p90"], f"p90 at seed {seed}")
            self.assertGreaterEqual(c["stationary_per_hour"], b["stationary_per_hour"], f"landings/h at seed {seed}")
        base, station = read("base.json"), read("publisher/measurements.json")["service"]
        model = CalibratedShapeExperiment(
            base, bench_30_rows(), 137, station, [], BENCH_30_SHAPE, bench_mode=True,
            full_recheck_saturated=True, hold_deciding=True, full_recheck_first_only=True,
        )
        # Entry 1 rechecks; entry 2 is newer and still checking (no pass yet).
        model.live, model.running = {0, 1, 2}, {2}
        self.assertTrue(model.lands_first_holder(1), "its bounded overtake step is unspent")
        model.overtaken = {1: 1}
        self.assertFalse(model.lands_first_holder(1), "after the step a newer unpassed holder waits")
        model.first_pass = {2: 0.0}
        self.assertTrue(model.lands_first_holder(1), "a pass from before this generation may go ahead")
        model.first_pass, model.running = {}, {0}
        self.assertTrue(model.lands_first_holder(1), "an older holder lands first")

    def test_arms_do_not_regress_forge_baseline_at_any_seed(self):
        base = read("base.json")
        shape = read("shapes.json")["baseline"]
        station = read("publisher/measurements.json")["service"]
        background = read("publisher/background.json")
        keep = shape["offers_per_hour"] * (1 - base["profile"]["p"]) / shape["trace_rate"]
        for seed in base["seeds"]:
            jobs = [job for job in background[str(seed)] if job[2] != "github-mirror-verify"]
            rows = [row for row in base["traces"][f"B/{shape['trace_rate']}/{seed}"] if row[2] < keep]
            inc = CalibratedShapeExperiment(base, rows, seed, station, jobs, shape).measure()
            for kw in (dict(batching=True), dict(skip_stale=True), dict(batching=True, skip_stale=True)):
                res = CalibratedShapeExperiment(base, rows, seed, station, jobs, shape, **kw).measure()
                self.assertTrue(res["flow"])
                self.assertGreaterEqual(res["per_hour"], inc["per_hour"])
                self.assertLessEqual(res["p50"], inc["p50"])
                self.assertLessEqual(res["p90"], inc["p90"])
                self.assertLessEqual(res["checks_per_landing"], inc["checks_per_landing"])
                self.assertLessEqual(res["worker_minutes_per_landing"], inc["worker_minutes_per_landing"])


if __name__ == "__main__":
    unittest.main()
