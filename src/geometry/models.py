"""Общие типы, Pydantic-модели и исключения геометрического ядра."""

from __future__ import annotations

from typing import TypeAlias

from pydantic import BaseModel, Field, field_validator

Coordinate: TypeAlias = tuple[float, float]


class GeometryProcessorError(ValueError):
    """Базовая ошибка обработки геометрии."""


class InvalidPolygonError(GeometryProcessorError):
    """Полигон не соответствует требованиям планировщика."""


class PolygonRequest(BaseModel):
    """Валидированный запрос на построение галсов."""

    coordinates: list[Coordinate] = Field(
        ..., min_length=3, description="Координаты внешнего кольца в формате [lon, lat]."
    )
    track_spacing_m: float = Field(..., gt=0, description="Шаг между галсами в метрах.")

    @field_validator("coordinates")
    @classmethod
    def validate_coordinates(cls, coordinates: list[Coordinate]) -> list[Coordinate]:
        """Проверяет диапазоны WGS84 и удаляет дублирующую замыкающую точку."""
        normalized = [(float(longitude), float(latitude)) for longitude, latitude in coordinates]
        if normalized[0] == normalized[-1]:
            normalized.pop()
        if len(normalized) < 3:
            raise ValueError("Полигон должен содержать минимум три уникальные точки.")
        if any(
            not -180 <= longitude <= 180 or not -90 <= latitude <= 90
            for longitude, latitude in normalized
        ):
            raise ValueError(
                "Координаты должны находиться в диапазонах lon [-180, 180], lat [-90, 90]."
            )
        if len(set(normalized)) != len(normalized):
            raise ValueError("Полигон не должен содержать повторяющиеся вершины.")
        return normalized
