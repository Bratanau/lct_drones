"""Расстояния между точками [lat, lon]: градус долготы короче градуса широты."""

from __future__ import annotations

import unittest

from src.geometry.service import _distance
from src.route_optimizer import distance_m


class DistanceTests(unittest.TestCase):
    def check(self, distance) -> None:
        # На широте Москвы градус долготы ≈ 62.6 км, градус широты ≈ 111.3 км.
        self.assertAlmostEqual(distance([55.75, 37.6], [55.75, 38.6]), 62_650, delta=300)
        self.assertAlmostEqual(distance([55.25, 37.6], [56.25, 37.6]), 111_320, delta=300)

    def test_mission_service_distance(self) -> None:
        self.check(_distance)

    def test_route_optimizer_distance(self) -> None:
        self.check(distance_m)


if __name__ == "__main__":
    unittest.main()
