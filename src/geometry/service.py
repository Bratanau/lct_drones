"""Сервисный JSON-контракт для расчета миссии на Python."""

from __future__ import annotations

import json
import math
import sys
from typing import Any

from shapely.geometry import LineString, Point, Polygon, shape

from .geometry_processor import FlightPlannerGeometry
from .models import GeometryProcessorError
from .projection import project_polygon, select_utm_projection

SENSOR_SWATH_FACTORS = {
    "rgb": 0.68,
    "multispectral": 0.47,
    "thermal": 0.52,
    "lidar": 1.1,
}


def plan_mission(payload: dict[str, Any]) -> dict[str, Any]:
    """Рассчитывает план миссии и возвращает JSON-совместимый словарь."""
    settings = payload.get("settings") or {}
    sensor = settings.get("sensor")
    if sensor not in SENSOR_SWATH_FACTORS:
        return {"errors": ["Укажите поддерживаемый сенсор."]}

    altitude = _number(settings.get("altitude"))
    speed = _number(settings.get("speed"))
    front_overlap = _number(settings.get("frontOverlap"))
    side_overlap = _number(settings.get("sideOverlap"))
    errors = _validate_settings(altitude, speed, front_overlap, side_overlap)
    if errors:
        return {"errors": errors}

    geometry = _input_geometry(payload)
    mode = payload.get("mode") or ("lidar" if sensor == "lidar" else "survey")
    platform = payload.get("platform") or {}
    platform_errors = _validate_platform(altitude, speed, platform)
    if platform_errors:
        return {"errors": platform_errors}

    if (geometry.geom_type == "LineString"):
        segments = _line_segments(geometry)
        angle = None
        spacing = max(10.0, altitude * 0.5)
        area_m2 = 0.0
        points = []
    else:
        projection = select_utm_projection(geometry)
        polygon_utm = project_polygon(geometry, projection)
        area_m2 = polygon_utm.area
        spacing = max(5.0, altitude * SENSOR_SWATH_FACTORS[sensor] * (1 - side_overlap / 100))
        if mode == "inspection":
            segments, points = _inspection_plan(polygon_utm, projection, spacing)
        else:
            tracks = FlightPlannerGeometry().process(_coordinates(geometry), spacing)
            segments = [
                [
                    [track["start_node_lonlat"][1], track["start_node_lonlat"][0]],
                    [track["end_node_lonlat"][1], track["end_node_lonlat"][0]],
                ]
                for track in tracks
            ]
            points = []
        if mode == "inspection":
            angle = 0.0
        else:
            angle = _angle_from_tracks(segments)

    coverage = sum(_distance(a, b) for a, b in segments)
    transit = sum(_distance(segments[index - 1][1], segment[0]) for index, segment in enumerate(segments[1:], 1))
    turn_penalty = max(0, len(segments) - 1) * min(20, spacing * 0.75)
    total = coverage + transit + turn_penalty
    flights = _split_flights(segments, speed, platform)
    return {
        "plan": {
            "mode": mode,
            "orientationDegrees": angle,
            "spacingM": round(spacing, 1),
            "areaM2": round(area_m2, 1),
            "coverageDistanceM": round(coverage, 1),
            "transitDistanceM": round(transit, 1),
            "totalDistanceM": round(total, 1),
            "durationSeconds": math.ceil(total / speed),
            "segments": segments,
            "points": points,
            "flights": flights["flights"],
            "battery": flights["summary"],
            "alternatives": [],
            "recommendations": [],
            "safety": {"blocking": [], "warnings": ["Нет данных DEM: высота рассчитывается относительно точки взлёта."]},
        }
    }


def _input_geometry(payload: dict[str, Any]) -> Polygon | LineString:
    if payload.get("boundary"):
        coordinates = [(float(point[1]), float(point[0])) for point in payload["boundary"]]
        geometry: Polygon | LineString = Polygon(coordinates)
    elif payload.get("geometry"):
        geometry = shape(payload["geometry"])
    else:
        raise GeometryProcessorError("Не передана геометрия работ.")
    if geometry.geom_type not in {"Polygon", "LineString"}:
        raise GeometryProcessorError("Поддерживаются Polygon и LineString в JSON API.")
    if not geometry.is_valid or geometry.is_empty:
        raise GeometryProcessorError("Передана невалидная геометрия работ.")
    return geometry


def _coordinates(polygon: Polygon) -> list[list[float]]:
    return [[longitude, latitude] for longitude, latitude in polygon.exterior.coords]


def _inspection_plan(polygon: Polygon, projection: Any, spacing: float) -> tuple[list[list[list[float]]], list[list[float]]]:
    """Строит точки осмотра регулярной метрической сеткой внутри полигона."""
    min_x, min_y, max_x, max_y = polygon.bounds
    points: list[list[float]] = []
    y = min_y + spacing / 2
    while y < max_y:
        x = min_x + spacing / 2
        while x < max_x:
            point = Point(x, y)
            if polygon.covers(point):
                longitude, latitude = projection.inverse.transform(x, y)
                points.append([round(latitude, 6), round(longitude, 6)])
            x += spacing
        y += spacing
    return [[point, point] for point in points], points
def _line_segments(line: LineString) -> list[list[list[float]]]:
    """Преобразует вершины коридора в сегменты [lat, lon]."""
    coordinates = list(line.coords)
    return [
        [list(coordinates[index][::-1]), list(coordinates[index + 1][::-1])]
        for index in range(len(coordinates) - 1)
    ]


def _validate_settings(altitude: float, speed: float, front_overlap: float, side_overlap: float) -> list[str]:
    errors = []
    for name, value, minimum, maximum in (
        ("altitude", altitude, 20, 500),
        ("speed", speed, 1, 30),
        ("frontOverlap", front_overlap, 50, 95),
        ("sideOverlap", side_overlap, 50, 95),
    ):
        if not math.isfinite(value) or not minimum <= value <= maximum:
            errors.append(f"Параметр {name} должен быть в диапазоне {minimum}-{maximum}.")
    return errors


def _validate_platform(altitude: float, speed: float, platform: dict[str, Any]) -> list[str]:
    if altitude < float(platform.get("minAltitudeM", 20)) or altitude > float(platform.get("maxAltitudeM", 500)):
        return ["Высота выходит за ограничения выбранной платформы."]
    if speed > float(platform.get("maxSpeedMS", 18)):
        return ["Скорость превышает ограничение платформы."]
    return []


def _split_flights(segments: list[list[list[float]]], speed: float, platform: dict[str, Any]) -> dict[str, Any]:
    usable_seconds = float(platform.get("flightMinutes", 28)) * 60 * (1 - float(platform.get("reservePercent", 20)) / 100)
    max_distance = min(float(platform.get("maxRangeM", 12000)), usable_seconds * speed)
    flights: list[list[list[list[float]]]] = []
    current: list[list[list[float]]] = []
    current_distance = 0.0
    for segment in segments:
        length = _distance(segment[0], segment[1])
        if current and current_distance + length > max_distance:
            flights.append(current)
            current, current_distance = [], 0.0
        current.append(segment)
        current_distance += length
    if current:
        flights.append(current)
    return {
        "flights": [
            {"number": index, "segments": value, "distanceM": round(sum(_distance(item[0], item[1]) for item in value), 1)}
            for index, value in enumerate(flights, 1)
        ],
        "summary": {"flights": max(1, len(flights)), "usableFlightSeconds": usable_seconds, "reservePercent": float(platform.get("reservePercent", 20)), "maxDistanceM": round(max_distance, 1)},
    }


def _distance(first: list[float], second: list[float]) -> float:
    latitude_scale = 111_320
    longitude_scale = latitude_scale * math.cos(math.radians((first[0] + second[0]) / 2))
    return math.hypot((second[1] - first[1]) * latitude_scale, (second[0] - first[0]) * longitude_scale)


def _number(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def _angle_from_tracks(segments: list[list[list[float]]]) -> float | None:
    if not segments:
        return None
    first, last = segments[0]
    return round(math.degrees(math.atan2(last[0] - first[0], last[1] - first[1])), 2)


def main() -> None:
    """Читает один JSON-документ из stdin и пишет один JSON-документ в stdout."""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(
            json.dumps(
                plan_mission(json.load(sys.stdin)),
                ensure_ascii=False,
            )
        )
    except Exception as error:  # noqa: BLE001 - граница subprocess должна вернуть JSON-ошибку.
        print(json.dumps({"errors": [str(error)]}, ensure_ascii=False))
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
