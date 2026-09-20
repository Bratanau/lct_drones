"""CVRP optimizer for assigning survey tracks to a heterogeneous UAV fleet."""

from __future__ import annotations

import json
import math
import sys
from typing import Any

from ortools.constraint_solver import pywrapcp, routing_enums_pb2


class AllocationError(ValueError):
    """The fleet cannot serve all requested tracks under its constraints."""


def distance_m(first: list[float], second: list[float]) -> float:
    latitude_scale = 111_320.0
    longitude_scale = latitude_scale * math.cos(math.radians((first[0] + second[0]) / 2))
    return math.hypot((second[1] - first[1]) * latitude_scale, (second[0] - first[0]) * longitude_scale)


def _track_centroid(track: list[list[float]]) -> list[float]:
    return [(track[0][0] + track[1][0]) / 2, (track[0][1] + track[1][1]) / 2]


def _speed(unit: dict[str, Any]) -> float:
    return max(0.1, float((unit.get("platform") or {}).get("maxSpeedMS", 18)))


def _capacity(unit: dict[str, Any]) -> int:
    platform = unit.get("platform") or {}
    flight_seconds = float(platform.get("flightMinutes", 28)) * 60
    # Keep 15% as an explicit return/emergency reserve.
    return max(1, math.floor(flight_seconds * 0.85))


def _build_data(plan: dict[str, Any], units: list[dict[str, Any]]) -> dict[str, Any]:
    tracks = plan.get("segments") or []
    if not tracks:
        raise AllocationError("Не переданы галсы для распределения.")
    if not units:
        raise AllocationError("Добавьте хотя бы один БВС в флот.")

    depots = [[float(unit["homeLat"]), float(unit["homeLng"])] for unit in units]
    centroids = [_track_centroid(track) for track in tracks]
    points = depots + centroids
    vehicle_count = len(units)
    track_count = len(tracks)
    min_speed = min(_speed(unit) for unit in units)
    demands = [0] * vehicle_count + [math.ceil(distance_m(track[0], track[1]) / min_speed) for track in tracks]

    matrix: list[list[int]] = []
    for source_index, source in enumerate(points):
        row = []
        for target_index, target in enumerate(points):
            if source_index == target_index:
                row.append(0)
                continue
            # CVRP requires one common matrix and one demand per job. Use the
            # slowest eligible cruise speed, which makes capacity feasibility
            # conservative for a heterogeneous fleet.
            row.append(math.ceil(distance_m(source, target) / min_speed))
        matrix.append(row)

    return {
        "time_matrix": matrix,
        "demands": demands,
        "vehicle_capacities": [_capacity(unit) for unit in units],
        "starts": list(range(vehicle_count)),
        "ends": list(range(vehicle_count)),
        "tracks": tracks,
        "units": units,
    }


def _solve(data: dict[str, Any]) -> list[list[int]]:
    manager = pywrapcp.RoutingIndexManager(
        len(data["time_matrix"]), len(data["units"]), data["starts"], data["ends"]
    )
    routing = pywrapcp.RoutingModel(manager)

    def time_callback(from_index: int, to_index: int) -> int:
        return data["time_matrix"][manager.IndexToNode(from_index)][manager.IndexToNode(to_index)]

    transit_callback = routing.RegisterTransitCallback(time_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback)

    def demand_callback(index: int) -> int:
        return data["demands"][manager.IndexToNode(index)]

    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        0,
        data["vehicle_capacities"],
        True,
        "Time/Battery",
    )
    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search.time_limit.seconds = 5
    solution = routing.SolveWithParameters(search)
    if solution is None:
        raise AllocationError("OR-Tools не нашел допустимое распределение: проверьте автономность и количество БВС.")

    routes: list[list[int]] = []
    for vehicle in range(len(data["units"])):
        index = routing.Start(vehicle)
        route: list[int] = []
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node >= len(data["units"]):
                route.append(node - len(data["units"]))
            index = solution.Value(routing.NextVar(index))
        routes.append(route)
    return routes


def _reconstruct(plan: dict[str, Any], units: list[dict[str, Any]], routes: list[list[int]]) -> list[dict[str, Any]]:
    allocations = []
    for unit, route in zip(units, routes):
        home = [float(unit["homeLat"]), float(unit["homeLng"])]
        trajectory = [home]
        position = home
        survey_segments = []
        for track_index in route:
            segment = plan["segments"][track_index]
            direct = distance_m(position, segment[0])
            reverse = distance_m(position, segment[1])
            oriented = [segment[1], segment[0]] if reverse < direct else segment
            trajectory.extend([oriented[0], oriented[1]])
            survey_segments.append(oriented)
            position = oriented[1]
        if survey_segments:
            trajectory.append(home)
        total_distance = sum(distance_m(trajectory[index], point) for index, point in enumerate(trajectory[1:]))
        seconds = total_distance / _speed(unit)
        allocations.append(
            {
                "uav_id": unit["id"],
                "uavId": unit["id"],
                "name": unit["name"],
                "home": home,
                "flight_trajectory_lonlat": [[point[1], point[0]] for point in trajectory],
                "flightTrajectory": trajectory,
                "surveySegments": survey_segments,
                "segments": survey_segments,
                "stats": {"flight_time_m": math.ceil(seconds / 60), "distance_m": round(total_distance)},
                "distanceM": round(total_distance),
                "estimatedSeconds": math.ceil(seconds),
                "warnings": [],
                "routeNodeIndexes": route,
            }
        )
    return allocations


def allocate_routes(plan: dict[str, Any], units: list[dict[str, Any]]) -> dict[str, Any]:
    data = _build_data(plan, units)
    routes = _solve(data)
    allocations = _reconstruct(plan, units, routes)
    assigned = {track_index for route in routes for track_index in route}
    unassigned = [index for index in range(len(data["tracks"])) if index not in assigned]
    return {"allocations": allocations, "assignments": allocations, "unassigned": unassigned, "solver": "OR-Tools CVRP"}


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(allocate_routes(payload["plan"], payload["units"]), ensure_ascii=False))
    except Exception as error:  # noqa: BLE001 - subprocess boundary returns JSON errors.
        print(json.dumps({"errors": [str(error)]}, ensure_ascii=False))
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
