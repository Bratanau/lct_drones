"""Тесты production-ready Python-ядра геометрии."""

import unittest

from shapely.geometry import Polygon

from src.geometry.geometry_processor import FlightPlannerGeometry, get_optimal_sweep_angle
from src.geometry.models import InvalidPolygonError, PolygonRequest


class FlightPlannerGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.planner = FlightPlannerGeometry()
        self.rectangle = [
            [37.892015, 55.670110],
            [37.915050, 55.670110],
            [37.915050, 55.678000],
            [37.892015, 55.678000],
            [37.892015, 55.670110],
        ]

    def test_builds_wgs84_tracks_with_required_schema(self) -> None:
        tracks = self.planner.process(self.rectangle, track_spacing_m=50)
        self.assertGreater(len(tracks), 0)
        self.assertEqual(
            set(tracks[0]),
            {"task_id", "start_node_lonlat", "end_node_lonlat", "length_m"},
        )
        self.assertEqual(len(tracks[0]["start_node_lonlat"]), 2)
        self.assertGreater(tracks[0]["length_m"], 0)
        self.assertTrue(all(abs(value) <= 180 for value in tracks[0]["start_node_lonlat"]))

    def test_selects_long_axis_of_minimum_rotated_rectangle(self) -> None:
        rotated_rectangle = Polygon([(0, 0), (8.66, 5), (7.66, 6.73), (-1, 1.73)])
        self.assertAlmostEqual(get_optimal_sweep_angle(rotated_rectangle), 30.0, places=1)

    def test_pydantic_validation_rejects_invalid_coordinates(self) -> None:
        with self.assertRaises(ValueError):
            PolygonRequest(coordinates=[[181, 55], [182, 55], [181, 56]], track_spacing_m=10)

    def test_self_intersecting_polygon_is_rejected(self) -> None:
        bow_tie = [[37.89, 55.67], [37.92, 55.68], [37.89, 55.68], [37.92, 55.67]]
        with self.assertRaises(InvalidPolygonError):
            self.planner.process(bow_tie, track_spacing_m=20)


if __name__ == "__main__":
    unittest.main()
