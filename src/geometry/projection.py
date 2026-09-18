"""Проекция геометрии между WGS84 и динамической UTM-зоной."""

from __future__ import annotations

import math
from dataclasses import dataclass

from pyproj import CRS, Transformer
from shapely.geometry import Polygon
from shapely.ops import transform

from .models import Coordinate, GeometryProcessorError


@dataclass(frozen=True)
class Projection:
    """Описание выбранной UTM-проекции и ее трансформеров."""

    epsg: int
    forward: Transformer
    inverse: Transformer


def select_utm_projection(polygon: Polygon) -> Projection:
    """Выбирает северную или южную UTM-зону по центроиду полигона."""
    centroid = polygon.centroid
    longitude, latitude = centroid.x, centroid.y
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


def project_polygon(polygon: Polygon, projection: Projection) -> Polygon:
    """Переводит WGS84-полигон в метрическую UTM-систему."""
    projected = transform(projection.forward.transform, polygon)
    if not isinstance(projected, Polygon):
        raise GeometryProcessorError("После репроекции геометрия перестала быть Polygon.")
    return projected


def transform_coordinate(coordinate: Coordinate, transformer: Transformer) -> Coordinate:
    """Преобразует одну координату, сохраняя порядок ``[x, y]``."""
    x, y = transformer.transform(*coordinate)
    return x, y


def round_coordinate(coordinate: Coordinate, precision: int) -> Coordinate:
    """Округляет координату до заданного количества знаков."""
    return tuple(round(value, precision) for value in coordinate)  # type: ignore[return-value]
