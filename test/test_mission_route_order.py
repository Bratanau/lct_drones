"""Встройка оптимизатора порядка галсов в plan_mission и распределение по флоту."""

from __future__ import annotations

import math
import unittest
from unittest import mock

from src.geometry.service import plan_mission
from src.route_optimizer import allocate_routes

# «П»-образный участок, [lat, lon], как присылает фронтенд.
U_SHAPE = [
    [55.6700, 37.8900], [55.6700, 37.9035], [55.6745, 37.9035], [55.6745, 37.8990],
    [55.67135, 37.8990], [55.67135, 37.8945], [55.6745, 37.8945], [55.6745, 37.8900],
]
SETTINGS = {"sensor": "rgb", "altitude": 120, "speed": 8, "frontOverlap": 75, "sideOverlap": 70}


def mission(**settings):
    return {"mode": "survey", "boundary": U_SHAPE, "settings": {**SETTINGS, **settings},
            "platform": {"maxSpeedMS": 18}}


def raster_plan():
    """Тот же план, но с исходным порядком нарезки — оптимизатор выключен."""
    with mock.patch(
        "src.geometry.service._optimize_track_order",
        side_effect=lambda tracks, segments, *_: (segments, None),
    ):
        return plan_mission(mission())["plan"]


def route_length(segments):
    """Длина облёта по порядку, метры; расстояния считаются независимо от проекта."""
    def dist(a, b):
        k = 111_320
        return math.hypot((b[0] - a[0]) * k, (b[1] - a[1]) * k * math.cos(math.radians((a[0] + b[0]) / 2)))
    points = [p for segment in segments for p in segment]
    return sum(dist(a, b) for a, b in zip(points, points[1:]))


class RouteOrderTests(unittest.TestCase):
    def test_sweep_segments_are_optimized(self) -> None:
        plan = plan_mission(mission())["plan"]
        self.assertEqual(plan["routeOrder"]["method"], "optimized")
        self.assertGreaterEqual(plan["routeOrder"]["improvementPercentVsSnake"], 0)

    def test_same_tracks_are_kept(self) -> None:
        optimized = plan_mission(mission())["plan"]["segments"]
        raster = raster_plan()["segments"]
        key = lambda s: tuple(sorted(map(tuple, s)))  # noqa: E731 - галс без учёта направления
        self.assertEqual(sorted(map(key, optimized)), sorted(map(key, raster)))

    def test_optimized_order_is_much_shorter_than_raster(self) -> None:
        optimized = plan_mission(mission())["plan"]["segments"]
        raster = raster_plan()["segments"]
        self.assertLess(route_length(optimized), 0.6 * route_length(raster))

    def test_contour_is_untouched(self) -> None:
        plan = plan_mission(mission(trajectoryAlgorithm="contour"))["plan"]
        self.assertEqual(plan["trajectoryAlgorithm"], "contour")
        self.assertIsNone(plan["routeOrder"])

    def test_contiguous_allocation_accepts_optimized_order(self) -> None:
        segments = plan_mission(mission())["plan"]["segments"]
        units = [
            {"id": f"u{i}", "name": f"U{i}", "homeLat": 55.6695, "homeLng": 37.889 + 0.001 * i,
             "payloads": ["RGB"], "platform": {"maxSpeedMS": 12, "flightMinutes": 40}}
            for i in range(2)
        ]
        result = allocate_routes({"plan": {"mode": "survey", "segments": segments}, "units": units})
        assigned = sorted(i for a in result["allocations"] for i in a["routeNodeIndexes"])
        self.assertEqual(assigned, list(range(len(segments))))


if __name__ == "__main__":
    unittest.main()
