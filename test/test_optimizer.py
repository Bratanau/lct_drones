"""Тесты оптимизатора маршрута.

Запуск из корня репозитория::

    python -m unittest discover -s test

Тесты не требуют shapely/pyproj: реальные галсы берутся из заранее
сохранённых фикстур (см. ``test/fixtures/make_fixtures.py``).
"""

from __future__ import annotations

import json
import math
import random
import subprocess
import sys
import unittest
from pathlib import Path

from src.optimizer import OptimizerError, optimize
from src.optimizer.cost import CostMatrix, CostModel
from src.optimizer.model import LocalProjection, Problem, Track, flip
from src.optimizer.planner import build_baseline, build_plan
from src.optimizer.search import local_search, optimize_order, snake
from src.optimizer.split import split_into_flights

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_fixture(name: str) -> list[dict]:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def parallel_tracks(count: int, length: float = 1000.0, spacing: float = 100.0) -> tuple[Track, ...]:
    """Горизонтальные галсы одинаковой длины, все направлены на восток."""
    return tuple(
        Track(f"t{i}", (0.0, i * spacing), (length, i * spacing), length) for i in range(count)
    )


class ProjectionTests(unittest.TestCase):
    def test_degree_lengths_at_moscow_latitude(self) -> None:
        projection = LocalProjection(37.6, 55.75)
        x, _ = projection.to_xy(38.6, 55.75)
        _, y = projection.to_xy(37.6, 56.75)
        self.assertAlmostEqual(x, 62_800, delta=300)   # градус долготы
        self.assertAlmostEqual(y, 111_300, delta=300)  # градус широты

    def test_round_trip(self) -> None:
        projection = LocalProjection(37.9, 55.67)
        lon, lat = projection.to_lonlat(*projection.to_xy(37.91, 55.675))
        self.assertAlmostEqual(lon, 37.91, places=9)
        self.assertAlmostEqual(lat, 55.675, places=9)


class CostTests(unittest.TestCase):
    """Измеритель на случаях, где ответ известен заранее."""

    def costs(self, tracks, depot=None, penalty=0.0) -> CostMatrix:
        return CostMatrix(Problem(tracks, depot), CostModel(turn_penalty_m=penalty))

    def test_single_track_is_its_length(self) -> None:
        costs = self.costs(parallel_tracks(1))
        self.assertAlmostEqual(costs.total([0]), 1000.0)

    def test_snake_on_two_tracks(self) -> None:
        costs = self.costs(parallel_tracks(2))
        self.assertAlmostEqual(costs.total([0, 3]), 2100.0)  # второй перевёрнут

    def test_same_direction_on_two_tracks(self) -> None:
        costs = self.costs(parallel_tracks(2))
        self.assertAlmostEqual(costs.total([0, 2]), 2000.0 + math.hypot(1000, 100))

    def test_snake_turn_costs_exactly_one_penalty(self) -> None:
        costs = self.costs(parallel_tracks(2), penalty=20.0)
        self.assertAlmostEqual(costs.breakdown([0, 3]).turn, 20.0)

    def test_collinear_continuation_has_no_turn(self) -> None:
        tracks = (Track("l", (0, 0), (100, 0), 100), Track("r", (200, 0), (300, 0), 100))
        costs = self.costs(tracks, penalty=20.0)
        self.assertAlmostEqual(costs.breakdown([0, 2]).turn, 0.0)
        self.assertAlmostEqual(costs.total([0, 2]), 300.0)

    def test_depot_legs_are_counted(self) -> None:
        costs = self.costs(parallel_tracks(1), depot=(0.0, -100.0))
        self.assertAlmostEqual(costs.total([0]), 100.0 + 1000.0 + math.hypot(1000, 100))

    def test_reversing_route_with_flips_keeps_cost(self) -> None:
        """Свойство, на котором держится быстрый 2-opt."""
        rng = random.Random(1)
        tracks = tuple(
            Track(f"t{i}", (rng.uniform(0, 500), rng.uniform(0, 500)),
                  (rng.uniform(0, 500), rng.uniform(0, 500)), 0.0)
            for i in range(12)
        )
        tracks = tuple(Track(t.id, t.a, t.b, math.dist(t.a, t.b)) for t in tracks)
        costs = self.costs(tracks, penalty=35.0)
        route = [2 * i + rng.randint(0, 1) for i in range(12)]
        rng.shuffle(route)
        reversed_route = [flip(node) for node in reversed(route)]
        self.assertAlmostEqual(costs.total(route), costs.total(reversed_route))


class SearchTests(unittest.TestCase):
    def assert_valid_route(self, route: list[int], n: int) -> None:
        self.assertEqual(sorted(node >> 1 for node in route), list(range(n)))

    def test_snake_is_optimal_for_parallel_tracks(self) -> None:
        costs = CostMatrix(Problem(parallel_tracks(10)), CostModel())
        route = optimize_order(costs, time_limit_s=0.5)
        self.assert_valid_route(route, 10)
        self.assertAlmostEqual(costs.total(route), costs.total(snake(10)))

    def test_local_search_fixes_unflipped_tracks(self) -> None:
        costs = CostMatrix(Problem(parallel_tracks(6)), CostModel())
        route = local_search([0, 2, 4, 6, 8, 10], costs)  # все в одну сторону
        self.assertAlmostEqual(costs.total(route), costs.total(snake(6)))

    def test_never_worse_than_snake_on_fixtures(self) -> None:
        for name in ("rectangle", "u_shape", "diagonal_strip", "large_field"):
            with self.subTest(fixture=name):
                result = optimize({"tracks": load_fixture(name), "speed": 12, "timeLimitS": 0.5})
                route = result["route"]
                self.assertLessEqual(route["metrics"]["totalDistanceM"], route["baseline"]["totalDistanceM"])
                visited = [v["taskId"] for f in route["flights"] for v in f["visits"]]
                self.assertEqual(sorted(visited), sorted(t["task_id"] for t in load_fixture(name)))

    def test_concave_field_beats_snake(self) -> None:
        result = optimize({"tracks": load_fixture("u_shape"), "speed": 12, "timeLimitS": 0.5})
        self.assertGreater(result["route"]["improvementPercent"], 10.0)

    def test_deterministic_for_same_seed(self) -> None:
        payload = {"tracks": load_fixture("u_shape"), "speed": 12, "timeLimitS": 0.5, "seed": 7}
        self.assertEqual(optimize(payload), optimize(payload))


class SplitTests(unittest.TestCase):
    def test_flights_respect_limit(self) -> None:
        result = optimize({
            "tracks": load_fixture("large_field"), "speed": 12,
            "depotLonLat": [37.84, 55.65], "maxFlightDistanceM": 12000, "timeLimitS": 0.5,
        })
        flights = result["route"]["flights"]
        self.assertGreater(len(flights), 1)
        for flight in flights:
            self.assertLessEqual(flight["totalM"], 12000.05)

    def test_platform_limit_matches_geometry_service_formula(self) -> None:
        # 10 мин × 60 × (1 − 0.2) × 5 м/с = 2400 м < maxRangeM
        tracks = load_fixture("rectangle")[:1]
        with self.assertRaises(OptimizerError):
            optimize({"tracks": tracks, "speed": 5, "depotLonLat": [37.80, 55.60],
                      "platform": {"flightMinutes": 10, "reservePercent": 20, "maxRangeM": 12000}})

    def test_track_that_never_fits_is_reported(self) -> None:
        costs = CostMatrix(Problem(parallel_tracks(2), depot=(0.0, 0.0)), CostModel())
        with self.assertRaises(OptimizerError):
            split_into_flights([0, 3], costs, max_flight_m=500.0)

    def test_dp_split_is_not_worse_than_greedy(self) -> None:
        costs = CostMatrix(Problem(parallel_tracks(9), depot=(500.0, -300.0)), CostModel())
        route = snake(9)
        limit = 4500.0
        greedy, current = [], []
        for node in route:
            if current and costs.total(current + [node]) > limit:
                greedy.append(current)
                current = []
            current.append(node)
        greedy.append(current)
        optimal = split_into_flights(route, costs, limit)
        total = lambda flights: sum(costs.total(f) for f in flights)  # noqa: E731
        self.assertLessEqual(total(optimal), total(greedy) + 1e-6)
        self.assertTrue(all(costs.total(f) <= limit + 1e-6 for f in optimal))

    def test_without_depot_uses_fewest_flights(self) -> None:
        costs = CostMatrix(Problem(parallel_tracks(6)), CostModel(turn_penalty_m=0))
        flights = split_into_flights(snake(6), costs, max_flight_m=2100.0)
        self.assertEqual([len(f) for f in flights], [2, 2, 2])


class BoundaryTests(unittest.TestCase):
    def test_swapped_lat_lon_is_rejected(self) -> None:
        swapped = [
            {**t, "start_node_lonlat": t["start_node_lonlat"][::-1],
             "end_node_lonlat": t["end_node_lonlat"][::-1]}
            for t in load_fixture("rectangle")
        ]
        with self.assertRaisesRegex(OptimizerError, "порядок координат"):
            optimize({"tracks": swapped, "speed": 12})

    def test_rejects_bad_input(self) -> None:
        good = load_fixture("rectangle")
        cases = [
            {"tracks": [], "speed": 12},
            {"tracks": good, "speed": 0},
            {"tracks": good},
            {"tracks": good, "speed": 12, "turnPenaltyM": -1},
            {"tracks": good + good[:1], "speed": 12},
        ]
        for payload in cases:
            with self.subTest(payload=list(payload)):
                with self.assertRaises(OptimizerError):
                    optimize(payload)

    def test_visit_endpoints_follow_direction(self) -> None:
        tracks = load_fixture("rectangle")
        by_id = {t["task_id"]: t for t in tracks}
        route = optimize({"tracks": tracks, "speed": 12})["route"]
        for visit in route["flights"][0]["visits"]:
            source = by_id[visit["taskId"]]
            expected = (source["end_node_lonlat"], source["start_node_lonlat"]) if visit["reversed"] \
                else (source["start_node_lonlat"], source["end_node_lonlat"])
            self.assertEqual((visit["startLonLat"], visit["endLonLat"]), expected)

    def test_cli_round_trip(self) -> None:
        payload = json.dumps({"tracks": load_fixture("diagonal_strip"), "speed": 12})
        done = subprocess.run(
            [sys.executable, "-m", "src.optimizer"], input=payload, capture_output=True,
            text=True, cwd=ROOT, check=False, encoding="utf-8",
        )
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("route", json.loads(done.stdout))

    def test_cli_reports_errors_as_json(self) -> None:
        done = subprocess.run(
            [sys.executable, "-m", "src.optimizer"], input="{}", capture_output=True,
            text=True, cwd=ROOT, check=False, encoding="utf-8",
        )
        self.assertEqual(done.returncode, 1)
        self.assertIn("errors", json.loads(done.stdout))


class PlannerTests(unittest.TestCase):
    def test_plan_and_baseline_share_cost_model(self) -> None:
        costs = CostMatrix(Problem(parallel_tracks(4)), CostModel())
        self.assertAlmostEqual(
            build_plan(costs, time_limit_s=0.2).breakdown.total,
            build_baseline(costs).breakdown.total,
        )


if __name__ == "__main__":
    unittest.main()
