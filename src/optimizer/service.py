"""Граница оптимизатора: JSON-словарь на входе, JSON-словарь на выходе.

Это единственный файл, который знает имена полей контракта. Если контракт
поменяется (например, геометрия начнёт отдавать метры), править нужно здесь.

Вход::

    {
      "tracks": [                       # ровно то, что отдаёт FlightPlannerGeometry.process
        {"task_id": "track-1",
         "start_node_lonlat": [lon, lat],
         "end_node_lonlat": [lon, lat],
         "length_m": 1448.93},
        ...
      ],
      "speed": 12,                      # м/с, обязательно
      "depotLonLat": [lon, lat],        # точка взлёта, необязательно
      "maxFlightDistanceM": 15000,      # лимит вылета, необязательно
      "platform": {                     # или лимит из платформы, как в geometry/service.py
        "flightMinutes": 28, "reservePercent": 20, "maxRangeM": 12000
      },
      "turnPenaltyM": 20,               # цена разворота на 180°, по умолчанию 20
      "timeLimitS": 1.0,                # бюджет поиска, по умолчанию 1 с
      "seed": 0
    }

Если заданы и ``maxFlightDistanceM``, и ``platform``, берётся первое.
Если не задано ни то, ни другое — один вылет без ограничения.

Выход::

    {"route": {
       "flights": [{"number": 1, "distanceM": ..., "turnPenaltyM": ..., "totalM": ...,
                    "durationSeconds": ..., "visits": [
                       {"taskId": "track-3", "reversed": false,
                        "startLonLat": [lon, lat], "endLonLat": [lon, lat]}, ...]}],
       "metrics": {"coverageDistanceM", "transitDistanceM", "turnPenaltyM",
                   "totalDistanceM", "durationSeconds", "flights"},
       "baseline": {"totalDistanceM", "flights"},
       "improvementPercent": ...
    }}

``startLonLat``/``endLonLat`` — уже с учётом направления: откуда дрон
заходит на галс и где с него сходит.
"""

from __future__ import annotations

import math
from typing import Any, Mapping, Optional

from .cost import CostMatrix, CostModel
from .model import LocalProjection, OptimizerError, Problem, Track
from .planner import Plan, build_baseline, build_plan

# Длина из геометрии посчитана в UTM, наша — в локальной проекции. Они
# расходятся на доли процента; расхождение больше — почти наверняка
# перепутан порядок lon/lat.
_LENGTH_TOLERANCE = 0.02
_LENGTH_TOLERANCE_ABS_M = 1.0
_MAX_TIME_LIMIT_S = 30.0


def optimize(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Точка входа: словарь запроса → словарь ответа."""
    if not isinstance(payload, Mapping):
        raise OptimizerError("Ожидается JSON-объект.")

    raw_tracks = payload.get("tracks")
    if not isinstance(raw_tracks, list) or not raw_tracks:
        raise OptimizerError("Поле tracks должно быть непустым списком галсов.")
    parsed = [_parse_track(item, index) for index, item in enumerate(raw_tracks)]

    depot_lonlat = payload.get("depotLonLat")
    if depot_lonlat is not None:
        depot_lonlat = _lonlat(depot_lonlat, "depotLonLat")

    speed = _positive(payload.get("speed"), "speed")
    max_flight = _max_flight_distance(payload, speed)
    model = CostModel(turn_penalty_m=_number(payload.get("turnPenaltyM", 20.0), "turnPenaltyM"))
    time_limit = min(_MAX_TIME_LIMIT_S, max(0.0, _number(payload.get("timeLimitS", 1.0), "timeLimitS")))
    seed = int(_number(payload.get("seed", 0), "seed"))

    anchor_points = [p for _, start, end, _ in parsed for p in (start, end)]
    if depot_lonlat is not None:
        anchor_points.append(depot_lonlat)
    projection = LocalProjection.around(anchor_points)

    tracks = []
    for task_id, start, end, length in parsed:
        a = projection.to_xy(*start)
        b = projection.to_xy(*end)
        measured = math.hypot(b[0] - a[0], b[1] - a[1])
        if abs(measured - length) > max(_LENGTH_TOLERANCE_ABS_M, _LENGTH_TOLERANCE * length):
            raise OptimizerError(
                f"Галс {task_id}: длина по координатам {measured:.1f} м, а length_m = {length:.1f} м. "
                "Проверьте порядок координат: ожидается [lon, lat]."
            )
        tracks.append(Track(task_id, a, b, length))

    problem = Problem(
        tracks=tuple(tracks),
        depot=None if depot_lonlat is None else projection.to_xy(*depot_lonlat),
        max_flight_m=max_flight,
    )
    costs = CostMatrix(problem, model)
    plan = build_plan(costs, time_limit_s=time_limit, seed=seed)
    baseline = build_baseline(costs)
    return {"route": _format(plan, baseline, parsed, speed)}


# --- разбор входа ----------------------------------------------------------


def _parse_track(item: Any, index: int) -> tuple[str, tuple[float, float], tuple[float, float], float]:
    if not isinstance(item, Mapping):
        raise OptimizerError(f"Галс #{index}: ожидается объект.")
    task_id = item.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise OptimizerError(f"Галс #{index}: нет task_id.")
    start = _lonlat(item.get("start_node_lonlat"), f"{task_id}.start_node_lonlat")
    end = _lonlat(item.get("end_node_lonlat"), f"{task_id}.end_node_lonlat")
    length = _positive(item.get("length_m"), f"{task_id}.length_m")
    return task_id, start, end, length


def _lonlat(value: Any, field: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise OptimizerError(f"{field}: ожидается пара [lon, lat].")
    lon, lat = _number(value[0], field), _number(value[1], field)
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise OptimizerError(f"{field}: координаты вне диапазона [lon, lat].")
    return lon, lat


def _number(value: Any, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise OptimizerError(f"{field}: ожидается число.") from None
    if not math.isfinite(number):
        raise OptimizerError(f"{field}: ожидается конечное число.")
    return number


def _positive(value: Any, field: str) -> float:
    number = _number(value, field)
    if number <= 0:
        raise OptimizerError(f"{field}: должно быть больше нуля.")
    return number


def _max_flight_distance(payload: Mapping[str, Any], speed: float) -> Optional[float]:
    """Лимит вылета: явный или по формуле из geometry/service.py."""
    explicit = payload.get("maxFlightDistanceM")
    if explicit is not None:
        return _positive(explicit, "maxFlightDistanceM")
    platform = payload.get("platform")
    if platform is None:
        return None
    if not isinstance(platform, Mapping):
        raise OptimizerError("platform: ожидается объект.")
    minutes = _positive(platform.get("flightMinutes", 28), "platform.flightMinutes")
    reserve = _number(platform.get("reservePercent", 20), "platform.reservePercent")
    if not 0 <= reserve < 100:
        raise OptimizerError("platform.reservePercent: ожидается значение от 0 до 100.")
    max_range = _positive(platform.get("maxRangeM", 12000), "platform.maxRangeM")
    usable_seconds = minutes * 60 * (1 - reserve / 100)
    return min(max_range, usable_seconds * speed)


# --- форматирование выхода -------------------------------------------------


def _format(plan: Plan, baseline: Plan, parsed: list, speed: float) -> dict[str, Any]:
    flights = []
    for number, (nodes, part) in enumerate(zip(plan.flights, plan.flight_breakdowns), 1):
        visits = []
        for node in nodes:
            task_id, start, end, _ = parsed[node >> 1]
            reversed_ = bool(node & 1)
            entry, exit_ = (end, start) if reversed_ else (start, end)
            visits.append(
                {"taskId": task_id, "reversed": reversed_,
                 "startLonLat": list(entry), "endLonLat": list(exit_)}
            )
        flights.append(
            {
                "number": number,
                "distanceM": round(part.distance, 1),
                "turnPenaltyM": round(part.turn, 1),
                "totalM": round(part.total, 1),
                "durationSeconds": math.ceil(part.total / speed),
                "visits": visits,
            }
        )
    total = plan.breakdown
    reference = baseline.breakdown.total
    improvement = 0.0 if reference <= 0 else (reference - total.total) / reference * 100
    return {
        "flights": flights,
        "metrics": {
            "coverageDistanceM": round(total.coverage, 1),
            "transitDistanceM": round(total.transit, 1),
            "turnPenaltyM": round(total.turn, 1),
            "totalDistanceM": round(total.total, 1),
            "durationSeconds": math.ceil(total.total / speed),
            "flights": len(plan.flights),
        },
        "baseline": {
            "totalDistanceM": round(reference, 1),
            "flights": len(baseline.flights),
        },
        "improvementPercent": round(improvement, 1),
    }
