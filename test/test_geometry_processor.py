"""Тесты production-ready Python-ядра геометрии."""

import unittest

from shapely.geometry import Polygon

from src.geometry.geometry_processor import FlightPlannerGeometry, get_optimal_sweep_angle
from src.geometry.models import InvalidPolygonError, PolygonRequest
from src.geometry.service import plan_mission
from src.geometry.track_slicer import TrackSlicer
from src.route_optimizer import AllocationError, allocate_routes


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

    def test_selects_trajectory_algorithm_in_mission_plan(self) -> None:
        payload = {
            "mode": "survey",
            "settings": {
                "sensor": "rgb",
                "altitude": 120,
                "speed": 8,
                "frontOverlap": 75,
                "sideOverlap": 70,
                "trajectoryAlgorithm": "contour",
            },
            "boundary": [
                [55.77, 37.60],
                [55.77, 37.61],
                [55.78, 37.61],
                [55.78, 37.60],
            ],
        }
        result = plan_mission(payload)
        self.assertEqual(result["plan"]["trajectoryAlgorithm"], "contour")
        self.assertGreater(len(result["plan"]["segments"]), 0)

    def test_slicer_orders_concave_intersections_and_endpoints(self) -> None:
        polygon = Polygon(
            [
                (0, 0),
                (6, 0),
                (6, 6),
                (4, 6),
                (4, 2),
                (2, 2),
                (2, 6),
                (0, 6),
            ]
        )
        tracks = TrackSlicer().slice(polygon, 1)
        self.assertEqual(
            [(track.centroid.y, track.centroid.x) for track in tracks],
            sorted((track.centroid.y, track.centroid.x) for track in tracks),
        )
        self.assertTrue(all(track.coords[0][0] <= track.coords[-1][0] for track in tracks))

    def test_allocates_contiguous_track_blocks(self) -> None:
        result = allocate_routes(
            {
                "plan": {
                    "mode": "survey",
                    "segments": [
                        [[55.0, 37.0], [55.0, 37.001]],
                        [[55.001, 37.0], [55.001, 37.001]],
                        [[55.002, 37.0], [55.002, 37.001]],
                        [[55.003, 37.0], [55.003, 37.001]],
                    ],
                },
                "units": [
                    {
                        "id": "uav-1",
                        "name": "UAV-1",
                        "homeLat": 55.0,
                        "homeLng": 37.0,
                        "payloads": ["RGB"],
                        "platform": {"maxSpeedMS": 18, "flightMinutes": 30},
                    },
                    {
                        "id": "uav-2",
                        "name": "UAV-2",
                        "homeLat": 55.0,
                        "homeLng": 37.0,
                        "payloads": ["RGB"],
                        "platform": {"maxSpeedMS": 18, "flightMinutes": 30},
                    },
                ],
            }
        )
        assigned = [allocation["routeNodeIndexes"] for allocation in result["allocations"]]
        non_empty = [route for route in assigned if route]
        self.assertTrue(all(route == list(range(route[0], route[-1] + 1)) for route in non_empty))
        self.assertEqual(sorted(index for route in assigned for index in route), [0, 1, 2, 3])

    def test_selects_allocation_algorithm(self) -> None:
        payload = {
            "plan": {
                "mode": "survey",
                "allocationAlgorithm": "nearest_home",
                "segments": [
                    [[55.0, 37.0], [55.0, 37.001]],
                    [[55.01, 37.0], [55.01, 37.001]],
                ],
            },
            "units": [
                {
                    "id": "uav-south",
                    "name": "South",
                    "homeLat": 55.0,
                    "homeLng": 37.0,
                    "payloads": ["RGB"],
                    "platform": {"maxSpeedMS": 18, "flightMinutes": 30},
                },
                {
                    "id": "uav-north",
                    "name": "North",
                    "homeLat": 55.01,
                    "homeLng": 37.0,
                    "payloads": ["RGB"],
                    "platform": {"maxSpeedMS": 18, "flightMinutes": 30},
                },
            ],
        }
        result = allocate_routes(payload)
        self.assertEqual(result["allocationAlgorithm"], "nearest_home")
        self.assertEqual([item["routeNodeIndexes"] for item in result["allocations"]], [[0], [1]])

    def test_rejects_lidar_allocation_without_lidar_payload(self) -> None:
        payload = {
            "plan": {"mode": "lidar", "segments": [[[55.0, 37.0], [55.001, 37.0]]]},
            "units": [
                {
                    "id": "uav-rgb",
                    "name": "RGB only",
                    "homeLat": 55.0,
                    "homeLng": 37.0,
                    "payloads": ["RGB"],
                    "platform": {"maxSpeedMS": 18, "flightMinutes": 30},
                }
            ],
        }
        with self.assertRaises(AllocationError):
            allocate_routes(payload)

    def test_pydantic_validation_rejects_invalid_coordinates(self) -> None:
        with self.assertRaises(ValueError):
            PolygonRequest(coordinates=[[181, 55], [182, 55], [181, 56]], track_spacing_m=10)

    def test_self_intersecting_polygon_is_rejected(self) -> None:
        bow_tie = [[37.89, 55.67], [37.92, 55.68], [37.89, 55.68], [37.92, 55.67]]
        with self.assertRaises(InvalidPolygonError):
            self.planner.process(bow_tie, track_spacing_m=20)


if __name__ == "__main__":
    unittest.main()
