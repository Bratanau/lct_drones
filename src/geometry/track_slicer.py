"""Нарезка метрического полигона на параллельные галсы."""

from __future__ import annotations

from shapely.geometry import GeometryCollection, LineString, MultiLineString, Polygon, base


class TrackSlicer:
    """Создает sweep-line пересечения внутри уже подготовленного полигона."""

    def __init__(self, min_segment_length_m: float = 0.01) -> None:
        if min_segment_length_m < 0:
            raise ValueError("min_segment_length_m не может быть отрицательным.")
        self.min_segment_length_m = min_segment_length_m

    def slice(self, polygon: Polygon, spacing_m: float) -> list[LineString]:
        """Нарезает полигон горизонтальными линиями с заданным шагом."""
        if spacing_m <= 0:
            raise ValueError("spacing_m должен быть больше нуля.")

        min_x, min_y, max_x, max_y = polygon.bounds
        extension = max(max_x - min_x, max_y - min_y) + spacing_m
        tracks: list[LineString] = []
        current_y = min_y + spacing_m / 2

        while current_y < max_y:
            sweep_line = LineString(
                [
                    (min_x - extension, current_y),
                    (max_x + extension, current_y),
                ]
            )
            tracks.extend(self._extract_lines(polygon.intersection(sweep_line)))
            current_y += spacing_m

        return sorted(
            tracks,
            key=lambda track: (round(track.centroid.y, 6), track.centroid.x),
        )

    def _extract_lines(self, geometry: base.BaseGeometry) -> list[LineString]:
        """Рекурсивно распаковывает LineString из Shapely-результата."""
        if isinstance(geometry, LineString):
            if geometry.length <= self.min_segment_length_m:
                return []
            start, end = geometry.coords[0], geometry.coords[-1]
            if start[0] <= end[0]:
                return [geometry]
            return [LineString(list(geometry.coords)[::-1])]
        if isinstance(geometry, (MultiLineString, GeometryCollection)):
            lines: list[LineString] = []
            for part in geometry.geoms:
                lines.extend(self._extract_lines(part))
            return sorted(lines, key=lambda line: (line.centroid.x, line.length))
        return []
