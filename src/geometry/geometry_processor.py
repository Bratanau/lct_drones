"""Оркестратор построения галсов для площадной аэрофотосъемки."""

from __future__ import annotations

import json
import math
from typing import Any, Iterable, Sequence

from shapely import make_valid
from shapely.affinity import rotate
from shapely.geometry import Polygon

from .models import Coordinate, GeometryProcessorError, InvalidPolygonError, PolygonRequest
from .projection import (
    Projection,
    project_polygon,
    round_coordinate,
    select_utm_projection,
    transform_coordinate,
)
from .track_slicer import TrackSlicer


def get_optimal_sweep_angle(polygon_geometry: Polygon) -> float:
    """Return the long-axis azimuth of the minimum rotated rectangle.

    The angle is normalized to ``[0, 180)`` because a sweep direction and its
    reverse produce the same set of coverage lines. The caller rotates the
    polygon by the negative angle so those lines become horizontal.
    """
    if polygon_geometry.is_empty or polygon_geometry.geom_type != "Polygon":
        raise GeometryProcessorError("Для выбора угла нужен непустой Polygon.")
    rectangle = polygon_geometry.minimum_rotated_rectangle
    corners = list(rectangle.exterior.coords)[:-1]
    edges = [
        (corners[index], corners[(index + 1) % len(corners)])
        for index in range(len(corners))
    ]
    start, end = max(
        edges,
        key=lambda edge: math.hypot(
            edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]
        ),
    )
    angle = math.degrees(math.atan2(end[1] - start[1], end[0] - start[0]))
    return angle % 180.0


class FlightPlannerGeometry:
    """Строит параллельные галсы внутри полигона WGS84.

    Вся математика выполняется в UTM-метрах. Класс отвечает за подготовку
    геометрии, выбор направления полета и форматирование результата; сама
    sweep-line нарезка изолирована в :class:`TrackSlicer`.
    """

    def __init__(self, min_segment_length_m: float = 0.01, coordinate_precision: int = 6) -> None:
        if min_segment_length_m < 0:
            raise ValueError("min_segment_length_m не может быть отрицательным.")
        if coordinate_precision < 0:
            raise ValueError("coordinate_precision не может быть отрицательным.")
        self.coordinate_precision = coordinate_precision
        self.track_slicer = TrackSlicer(min_segment_length_m)

    def process(
        self,
        coordinates: Sequence[Sequence[float]],
        track_spacing_m: float,
        task_id_prefix: str = "track",
    ) -> list[dict[str, Any]]:
        """Преобразует полигон в список галсов для маршрутизатора.

        Args:
            coordinates: Внешнее кольцо WGS84 в формате ``[lon, lat]``.
            track_spacing_m: Расстояние между соседними галсами в метрах.
            task_id_prefix: Префикс идентификаторов галсов.

        Raises:
            GeometryProcessorError: При невалидном контуре, неподдерживаемой
                широте или отсутствии пересечений.
        """
        request = PolygonRequest(
            coordinates=list(coordinates), track_spacing_m=track_spacing_m
        )
        polygon_wgs84 = self._build_polygon(request.coordinates)
        projection = select_utm_projection(polygon_wgs84)
        polygon_utm = project_polygon(polygon_wgs84, projection)
        flight_angle = get_optimal_sweep_angle(polygon_utm)
        rotated_polygon = rotate(polygon_utm, -flight_angle, origin=polygon_utm.centroid)
        tracks = self.track_slicer.slice(rotated_polygon, request.track_spacing_m)

        result = [
            self._format_track(
                track, index, task_id_prefix, projection, rotated_polygon, flight_angle
            )
            for index, track in enumerate(tracks, start=1)
        ]
        if not result:
            raise GeometryProcessorError(
                "Полигон не пересекается ни с одной линией заданного шага."
            )
        return result

    def process_request(
        self, request: PolygonRequest, task_id_prefix: str = "track"
    ) -> list[dict[str, Any]]:
        """Обрабатывает уже валидированную Pydantic-модель."""
        return self.process(request.coordinates, request.track_spacing_m, task_id_prefix)

    @staticmethod
    def _build_polygon(coordinates: Iterable[Coordinate]) -> Polygon:
        """Создает полигон и не принимает невалидную топологию молча."""
        polygon = Polygon(coordinates)
        if polygon.is_empty or polygon.area == 0:
            raise InvalidPolygonError("Полигон имеет нулевую площадь.")
        if not polygon.is_valid:
            repaired = make_valid(polygon)
            raise InvalidPolygonError(
                "Полигон невалиден или самопересекается; "
                f"make_valid() дал {repaired.geom_type}."
            )
        return polygon

    @staticmethod
    def _longest_edge_angle(polygon: Polygon) -> float:
        """Backward-compatible alias for the public sweep-angle helper."""
        return get_optimal_sweep_angle(polygon)

    def _format_track(
        self,
        track,
        index: int,
        task_id_prefix: str,
        projection: Projection,
        rotated_polygon: Polygon,
        flight_angle: float,
    ) -> dict[str, Any]:
        """Возвращает один галс в контракте маршрутизатора."""
        restored = rotate(track, flight_angle, origin=rotated_polygon.centroid)
        start = transform_coordinate(restored.coords[0], projection.inverse)
        end = transform_coordinate(restored.coords[-1], projection.inverse)
        return {
            "task_id": f"{task_id_prefix}-{index}",
            "start_node_lonlat": list(round_coordinate(start, self.coordinate_precision)),
            "end_node_lonlat": list(round_coordinate(end, self.coordinate_precision)),
            "length_m": round(track.length, 2),
        }


def process_polygon(
    coordinates: Sequence[Sequence[float]], track_spacing_m: float
) -> list[dict[str, Any]]:
    """Функциональная обертка над :class:`FlightPlannerGeometry`."""
    return FlightPlannerGeometry().process(coordinates, track_spacing_m)


if __name__ == "__main__":
    mock_polygon = [
        [37.892015, 55.670110],
        [37.915050, 55.670110],
        [37.915050, 55.678000],
        [37.892015, 55.678000],
        [37.892015, 55.670110],
    ]
    print(
        json.dumps(
            FlightPlannerGeometry().process(mock_polygon, track_spacing_m=50),
            ensure_ascii=False,
            indent=2,
        )
    )
