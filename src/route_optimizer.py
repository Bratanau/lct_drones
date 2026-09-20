"""CVRP optimizer for assigning survey tracks to a heterogeneous UAV fleet."""

from __future__ import annotations

import json
import math
import sys
from itertools import permutations
from typing import Any


from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from .constants import (
    BATTERY_USABLE_FRACTION,
    SOLVER_TIME_LIMIT_SECONDS,
    TURN_TIME_SECONDS,
)
from .schemas import AllocationRequestModel, FleetUnitModel


class AllocationError(ValueError):
    """The fleet cannot serve all requested tracks under its constraints."""


def distance_m(first: list[float], second: list[float]) -> float:
    latitude_scale = 111_320.0
    longitude_scale = latitude_scale * math.cos(math.radians((first[0] + second[0]) / 2))
    return math.hypot((second[1] - first[1]) * latitude_scale, (second[0] - first[0]) * longitude_scale)


def _track_centroid(track: list[list[float]]) -> list[float]:
    return [(track[0][0] + track[1][0]) / 2, (track[0][1] + track[1][1]) / 2]


def _speed(unit: FleetUnitModel) -> float:
    return max(0.1, unit.platform.maxSpeedMS)


def _capacity(unit: FleetUnitModel) -> int:
    return max(1, math.floor(unit.platform.flightMinutes * 60 * BATTERY_USABLE_FRACTION))


def _eligible_units(request: AllocationRequestModel) -> list[FleetUnitModel]:
    if request.plan.mode != "lidar":
        return request.units
    return [
        unit
        for unit in request.units
        if any(payload.casefold() == "lidar" for payload in unit.payloads)
    ]


def _build_data(request: AllocationRequestModel) -> dict[str, Any]:
    units = _eligible_units(request)
    if not units:
        raise AllocationError("Нет БВС с подходящей полезной нагрузкой.")

    tracks = request.plan.segments
    depots = [[unit.homeLat, unit.homeLng] for unit in units]
    points = depots + [_track_centroid(track) for track in tracks]
    return {
        "points": points,
        "track_lengths_m": [distance_m(track[0], track[1]) for track in tracks],
        "tracks": tracks,
        "vehicle_capacities": [_capacity(unit) for unit in units],
        "starts": list(range(len(units))),
        "ends": list(range(len(units))),
        "units": units,
        "vehicle_count": len(units),
        "allocation_algorithm": request.plan.allocationAlgorithm,
    }


def _solve_cvrp(data: dict[str, Any]) -> list[list[int]]:
    manager = pywrapcp.RoutingIndexManager(
        len(data["points"]), data["vehicle_count"], data["starts"], data["ends"]
    )
    routing = pywrapcp.RoutingModel(manager)
    transit_callbacks = []

    for unit in data["units"]:
        speed = _speed(unit)

        def time_callback(from_index: int, to_index: int, *, vehicle_speed: float = speed) -> int:
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            travel_seconds = distance_m(data["points"][from_node], data["points"][to_node]) / vehicle_speed
            service_seconds = 0.0
            if from_node >= data["vehicle_count"]:
                track_index = from_node - data["vehicle_count"]
                service_seconds = data["track_lengths_m"][track_index] / vehicle_speed + TURN_TIME_SECONDS
            return math.ceil(travel_seconds + service_seconds)

        callback = routing.RegisterTransitCallback(time_callback)
        routing.SetArcCostEvaluatorOfVehicle(callback, len(transit_callbacks))
        transit_callbacks.append(callback)

    routing.AddDimensionWithVehicleTransitAndCapacity(
        transit_callbacks,
        0,
        data["vehicle_capacities"],
        True,
        "Time/Battery",
    )
    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search.time_limit.seconds = SOLVER_TIME_LIMIT_SECONDS
    solution = routing.SolveWithParameters(search)
    if solution is None:
        raise AllocationError("OR-Tools не нашел допустимое распределение: проверьте автономность и количество БВС.")

    routes: list[list[int]] = []
    for vehicle in range(data["vehicle_count"]):
        index = routing.Start(vehicle)
        route: list[int] = []
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node >= data["vehicle_count"]:
                route.append(node - data["vehicle_count"])
            index = solution.Value(routing.NextVar(index))
        routes.append(route)
    return routes


def _block_metrics(
    tracks: list[list[list[float]]],
    start: int,
    end: int,
    home: list[float],
    speed: float,
) -> tuple[float, list[list[list[float]]]]:
    """Return distance and oriented lines for one contiguous track block."""
    position = home
    distance = 0.0
    oriented_lines = []
    for track in tracks[start:end]:
        direct = distance_m(position, track[0])
        reverse = distance_m(position, track[1])
        oriented = [track[1], track[0]] if reverse < direct else track
        distance += distance_m(position, oriented[0])
        distance += distance_m(oriented[0], oriented[1])
        oriented_lines.append(oriented)
        position = oriented[1]
    if oriented_lines:
        distance += distance_m(position, home)
    return distance, oriented_lines


def _route_metrics(
    tracks: list[list[list[float]]],
    indices: list[int],
    home: list[float],
    speed: float,
) -> float:
    selected = [tracks[index] for index in indices]
    distance, _ = _block_metrics(selected, 0, len(selected), home, speed)
    return distance / speed + len(selected) * TURN_TIME_SECONDS


def _solve_nearest_home(data: dict[str, Any]) -> list[list[int]]:
    """Assign each segment to the nearest home while respecting flight capacity."""
    routes = [[] for _ in range(data["vehicle_count"])]
    tracks = data["tracks"]
    for track_index, track in enumerate(tracks):
        candidates = sorted(
            range(data["vehicle_count"]),
            key=lambda unit_index: distance_m(
                [data["units"][unit_index].homeLat, data["units"][unit_index].homeLng],
                _track_centroid(track),
            ),
        )
        assigned = False
        for unit_index in candidates:
            unit = data["units"][unit_index]
            required = _route_metrics(
                tracks,
                routes[unit_index] + [track_index],
                [unit.homeLat, unit.homeLng],
                _speed(unit),
            )
            if required <= data["vehicle_capacities"][unit_index]:
                routes[unit_index].append(track_index)
                assigned = True
                break
        if not assigned:
            raise AllocationError(
                "Не удалось назначить все галсы ближайшим БВС с учетом автономности."
            )
    return routes


def _solve(data: dict[str, Any]) -> list[list[int]]:
    """Dispatch the selected allocation algorithm."""
    algorithm = data["allocation_algorithm"]
    if algorithm == "nearest_home":
        return _solve_nearest_home(data)
    if algorithm == "cvrp":
        return _solve_cvrp(data)
    return _solve_contiguous(data)


def _solve_contiguous(data: dict[str, Any]) -> list[list[int]]:
    tracks = data["tracks"]
    vehicle_count = data["vehicle_count"]
    track_count = len(tracks)
    required_blocks = min(vehicle_count, track_count)
    best_cost = float("inf")
    best_routes: list[list[int]] | None = None

    for order in permutations(range(vehicle_count)):
        if required_blocks < vehicle_count and order[required_blocks:]:
            # There are fewer tracks than aircraft; unused aircraft are allowed.
            pass
        dp = [[float("inf")] * (track_count + 1) for _ in range(required_blocks + 1)]
        previous: list[list[tuple[int, int] | None]] = [
            [None] * (track_count + 1) for _ in range(required_blocks + 1)
        ]
        dp[0][0] = 0.0
        for block_index in range(1, required_blocks + 1):
            unit = data["units"][order[block_index - 1]]
            speed = _speed(unit)
            capacity = data["vehicle_capacities"][order[block_index - 1]]
            home = [unit.homeLat, unit.homeLng]
            for end in range(1, track_count + 1):
                for start in range(block_index - 1, end):
                    if dp[block_index - 1][start] == float("inf"):
                        continue
                    distance, _ = _block_metrics(tracks, start, end, home, speed)
                    required = distance / speed + (end - start) * TURN_TIME_SECONDS
                    if required > capacity:
                        continue
                    cost = dp[block_index - 1][start] + required
                    if cost < dp[block_index][end]:
                        dp[block_index][end] = cost
                        previous[block_index][end] = (start, end)

        if dp[required_blocks][track_count] >= best_cost:
            continue
        routes = [[] for _ in range(vehicle_count)]
        end = track_count
        for block_index in range(required_blocks, 0, -1):
            state = previous[block_index][end]
            if state is None:
                break
            start, block_end = state
            routes[order[block_index - 1]] = list(range(start, block_end))
            end = start
        if end == 0:
            best_cost = dp[required_blocks][track_count]
            best_routes = routes

    if best_routes is None:
        raise AllocationError(
            "Не удалось распределить галсы непрерывными блоками: проверьте автономность флота."
        )
    return best_routes


def _reconstruct(
    plan: AllocationRequestModel, units: list[FleetUnitModel], routes: list[list[int]]
) -> list[dict[str, Any]]:
    allocations = []
    for unit, route in zip(units, routes):
        home = [unit.homeLat, unit.homeLng]
        trajectory = [home]
        position = home
        survey_segments = []
        for track_index in route:
            segment = plan.plan.segments[track_index]
            direct = distance_m(position, segment[0])
            reverse = distance_m(position, segment[1])
            oriented = [segment[1], segment[0]] if reverse < direct else segment
            trajectory.extend([oriented[0], oriented[1]])
            survey_segments.append(oriented)
            position = oriented[1]
        if survey_segments:
            trajectory.append(home)
        total_distance = sum(
            distance_m(trajectory[index], point)
            for index, point in enumerate(trajectory[1:])
        )
        seconds = total_distance / _speed(unit)
        allocations.append(
            {
                "uav_id": unit.id,
                "name": unit.name,
                "home_lonlat": [home[1], home[0]],
                "flight_trajectory_lonlat": [[point[1], point[0]] for point in trajectory],
                "survey_segments_lonlat": [
                    [[point[1], point[0]] for point in segment]
                    for segment in survey_segments
                ],
                "stats": {"flight_time_m": math.ceil(seconds / 60), "distance_m": round(total_distance)},
                "distanceM": round(total_distance),
                "estimatedSeconds": math.ceil(seconds),
                "warnings": [],
                "routeNodeIndexes": route,
            }
        )
    return allocations


def allocate_routes(payload: dict[str, Any]) -> dict[str, Any]:
    request = AllocationRequestModel.model_validate(payload)
    data = _build_data(request)
    routes = _solve(data)
    allocations = _reconstruct(request, data["units"], routes)
    assigned = {track_index for route in routes for track_index in route}
    unassigned = [
        index
        for index in range(len(request.plan.segments))
        if index not in assigned
    ]
    return {
        "allocations": allocations,
        "unassigned": unassigned,
        "allocationAlgorithm": request.plan.allocationAlgorithm,
        "solver": "OR-Tools CVRP" if request.plan.allocationAlgorithm == "cvrp" else "deterministic allocation",
    }


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(allocate_routes(payload), ensure_ascii=False))
    except Exception as error:  # noqa: BLE001 - subprocess boundary returns JSON errors.
        print(json.dumps({"errors": [str(error)]}, ensure_ascii=False))
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
