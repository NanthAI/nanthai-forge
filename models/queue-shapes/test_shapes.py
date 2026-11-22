"""Regression coverage for the order and scoring assumptions in the shape arm."""

import unittest

from shapes import ShapeExperiment, read


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


if __name__ == "__main__":
    unittest.main()
