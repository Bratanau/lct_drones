"""Геометрическое ядро планировщика полетных галсов БВС.

Модуль принимает полигон в WGS84 в формате ``[longitude, latitude]``,
переводит его в метрическую UTM-проекцию, выбирает направление полета по
минимальному повернутому ограничивающему прямоугольнику и возвращает набор
галсов, пригодный для последующей маршрутизации.

Зависимости:
    shapely: топологические операции и пересечение геометрий;
    pyproj: преобразование WGS84 <-> UTM;
    pydantic: проверка входной модели.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from pydantic import BaseModel, Field, field_validator
from pyproj import CRS, Transformer
from shapely import make_valid
from shapely.affinity import rotate
from shapely.geometry import GeometryCollection, LineString, MultiLineString, Polygon, base
from shapely.ops import transform

Coordinate = tuple[float, float]


class GeometryProcessorError(ValueError):
    """Базовая ошибка обработки геометрии."""


class InvalidPolygonError(GeometryProcessorError):
    """Полигон не соответствует требованиям планировщика."""


class PolygonRequest(BaseModel):
    """Валидированный запрос на построение галсов."""

    coordinates: list[tuple[float, float]] = Field(
        ..., min_length=3, description="Координаты внешнего кольца в формате [lon, lat]."
    )
    track_spacing_m: float = Field(..., gt=0, description="Шаг между галсами в метрах.")

    @field_validator("coordinates")
    @classmethod
    def validate_coordinates(
        cls, coordinates: list[tuple[float, float]]
    ) -> list[tuple[float, float]]:
        """Проверяет диапазоны WGS84 и удаляет дублирующую замыкающую точку."""
        normalized = [(float(lon), float(lat)) for lon, lat in coordinates]
        if normalized[0] == normalized[-1]:
            normalized.pop()
        if len(normalized) < 3:
            raise ValueError("Полигон должен содержать минимум три уникальные точки.")
        if any(not -180 <= lon <= 180 or not -90 <= lat <= 90 for lon, lat in normalized):
            raise ValueError("Координаты должны находиться в диапазонах lon [-180, 180], lat [-90, 90].")
        if len(set(normalized)) != len(normalized):
            raise ValueError("Полигон не должен содержать повторяющиеся вершины.")
        return normalized


@dataclass(frozen=True)
class Projection:
    """Описание выбранной UTM-проекции и ее трансформеров."""

    epsg: int
    forward: Transformer
    inverse: Transformer


class FlightPlannerGeometry:
    """Строит параллельные метрические галсы внутри WGS84-полигона.

    Args:
        min_segment_length_m: Минимальная длина результата пересечения. Это
            защищает маршрутизатор от нулевых отрезков в вершинах полигона.
        coordinate_precision: Количество знаков после запятой в WGS84.

    Notes:
        Входные координаты всегда трактуются как ``[lon, lat]``. Это отличается
        от порядка, используемого Leaflet, и намеренно совпадает с GeoJSON.
    """

    def __init__(self, min_segment_length_m: float = 0.01, coordinate_precision: int = 6) -> None:
        if min_segment_length_m < 0:
            raise ValueError("min_segment_length_m не может быть отрицательным.")
        if coordinate_precision < 0:
            raise ValueError("coordinate_precision не может быть отрицательным.")
        self.min_segment_length_m = min_segment_length_m
        self.coordinate_precision = coordinate_precision

    def process(
        self,
        coordinates: Sequence[Sequence[float]],
        track_spacing_m: float,
        task_id_prefix: str = "track",
    ) -> list[dict[str, Any]]:
        """Нарезает полигон на галсы и возвращает маршрутизируемые узлы.

        Args:
            coordinates: Внешнее кольцо полигона в WGS84: ``[lon, lat]``.
                Замыкающая точка может быть передана повторно.
            track_spacing_m: Расстояние между соседними линиями съемки в метрах.
            task_id_prefix: Префикс уникального идентификатора галса.

        Returns:
            Список словарей с полями ``task_id``, ``start_node_lonlat``,
            ``end_node_lonlat`` и ``length_m``.

        Raises:
            GeometryProcessorError: Если контур невалиден, самопересекается,
                расположен вне диапазона UTM или не дал ни одного галса.
        """
        request = PolygonRequest(coordinates=list(coordinates), track_spacing_m=track_spacing_m)
        polygon_wgs84 = self._build_polygon(request.coordinates)
        projection = self._select_utm_projection(polygon_wgs84)
        polygon_utm = self._project_polygon(polygon_wgs84, projection.forward)
        flight_angle = self._longest_edge_angle(polygon_utm)
        rotated_polygon = rotate(polygon_utm, -flight_angle, origin="centroid", use_radians=False)
        tracks = self._slice_polygon(rotated_polygon, request.track_spacing_m)

        result: list[dict[str, Any]] = []
        for index, track in enumerate(tracks, start=1):
            restored = rotate(track, flight_angle, origin=rotated_polygon.centroid, use_radians=False)
            start_lonlat = self._round_coordinate(
                self._transform_coordinate(restored.coords[0], projection.inverse)
            )
            end_lonlat = self._round_coordinate(
                self._transform_coordinate(restored.coords[-1], projection.inverse)
            )
            result.append(
                {
                    "task_id": f"{task_id_prefix}-{index}",
                    "start_node_lonlat": list(start_lonlat),
                    "end_node_lonlat": list(end_lonlat),
                    "length_m": round(track.length, 2),
                }
            )
        if not result:
            raise GeometryProcessorError("Полигон не пересекается ни с одной линией заданного шага.")
        return result

    def process_request(self, request: PolygonRequest, task_id_prefix: str = "track") -> list[dict[str, Any]]:
        """Обрабатывает уже валидированную Pydantic-модель."""
        return self.process(request.coordinates, request.track_spacing_m, task_id_prefix)

    def _build_polygon(self, coordinates: Iterable[Coordinate]) -> Polygon:
        """Создает полигон и строго проверяет его топологию."""
        polygon = Polygon(coordinates)
        if polygon.is_empty or polygon.area == 0:
            raise InvalidPolygonError("Полигон имеет нулевую площадь.")
        if not polygon.is_valid:
            # Вызываем make_valid для диагностики и полезного сообщения, но не
            # принимаем измененную геометрию молча: маршрутизатор ожидает одну зону.
            repaired = make_valid(polygon)
            geometry_type = repaired.geom_type
            raise InvalidPolygonError(
                f"Полигон невалиден или самопересекается; make_valid() дал {geometry_type}."
            )
        return polygon

    @staticmethod
    def _select_utm_projection(polygon: Polygon) -> Projection:
        """Выбирает северную или южную UTM-зону по центроиду полигона."""
        centroid = polygon.centroid
        longitude = centroid.x
        latitude = centroid.y
        if not -80 <= latitude <= 84:
            raise GeometryProcessorError("UTM поддерживает широты только от -80 до 84 градусов.")
        zone = math.floor((longitude + 180) / 6) + 1
        epsg = (32600 if latitude >= 0 else 32700) + zone
        source = CRS.from_epsg(4326)
        target = CRS.from_epsg(epsg)
        return Projection(
            epsg=epsg,
            forward=Transformer.from_crs(source, target, always_xy=True),
            inverse=Transformer.from_crs(target, source, always_xy=True),
        )

    @staticmethod
    def _project_polygon(polygon: Polygon, transformer: Transformer) -> Polygon:
        """Переводит WGS84-полигон в метрическую систему координат."""
        projected = transform(transformer.transform, polygon)
        if not isinstance(projected, Polygon):
            raise GeometryProcessorError("После репроекции геометрия перестала быть Polygon.")
        return projected

    @staticmethod
    def _longest_edge_angle(polygon: Polygon) -> float:
        """Возвращает азимут самой длинной грани minimum rotated rectangle."""
        rectangle = polygon.minimum_rotated_rectangle
        corners = list(rectangle.exterior.coords)[:-1]
        edges = [
            (corners[index], corners[(index + 1) % len(corners)])
            for index in range(len(corners))
        ]
        longest_start, longest_end = max(
            edges,
            key=lambda edge: math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]),
        )
        return math.degrees(
            math.atan2(longest_end[1] - longest_start[1], longest_end[0] - longest_start[0])
        )

    def _slice_polygon(self, polygon: Polygon, spacing_m: float) -> list[LineString]:
        """Пересекает выровненный полигон горизонтальными sweep-line."""
        min_x, min_y, max_x, max_y = polygon.bounds
        extension = max(max_x - min_x, max_y - min_y) + spacing_m
        tracks: list[LineString] = []
        y = min_y + spacing_m / 2
        while y < max_y:
            sweep_line = LineString([(min_x - extension, y), (max_x + extension, y)])
            intersection = polygon.intersection(sweep_line)
            tracks.extend(self._extract_lines(intersection))
            y += spacing_m
        return tracks

    def _extract_lines(self, geometry: base.BaseGeometry) -> list[LineString]:
        """Рекурсивно извлекает непустые LineString из результата intersection."""
        if isinstance(geometry, LineString):
            return [geometry] if geometry.length > self.min_segment_length_m else []
        if isinstance(geometry, (MultiLineString, GeometryCollection)):
            lines: list[LineString] = []
            for part in geometry.geoms:
                lines.extend(self._extract_lines(part))
            return lines
        return []

    @staticmethod
    def _transform_coordinate(coordinate: tuple[float, float], transformer: Transformer) -> Coordinate:
        """Преобразует одну метрическую координату в ``[lon, lat]``."""
        longitude, latitude = transformer.transform(*coordinate)
        return longitude, latitude

    def _round_coordinate(self, coordinate: Coordinate) -> Coordinate:
        """Округляет WGS84-координаты до заданной точности."""
        return tuple(round(value, self.coordinate_precision) for value in coordinate)  # type: ignore[return-value]


def process_polygon(
    coordinates: Sequence[Sequence[float]], track_spacing_m: float
) -> list[dict[str, Any]]:
    """Удобная функциональная обертка над :class:`FlightPlannerGeometry`."""
    return FlightPlannerGeometry().process(coordinates, track_spacing_m)


if __name__ == "__main__":
    mock_polygon = [
        [37.892015, 55.670110],
        [37.915050, 55.670110],
        [37.915050, 55.678000],
        [37.892015, 55.678000],
        [37.892015, 55.670110],
    ]
    planner = FlightPlannerGeometry()
    mock_result = planner.process(mock_polygon, track_spacing_m=50)
    print(json.dumps(mock_result, ensure_ascii=False, indent=2))
