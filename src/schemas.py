"""Pydantic contracts shared by Python planning workers."""

from __future__ import annotations

from typing import Literal, TypeAlias

from pydantic import BaseModel, Field, field_validator

Coordinate: TypeAlias = list[float]
SurveySegment: TypeAlias = list[Coordinate]


class PlatformModel(BaseModel):
    maxSpeedMS: float = Field(gt=0)
    flightMinutes: float = Field(gt=0)
    reservePercent: float = Field(default=15, ge=0, le=80)


class FleetUnitModel(BaseModel):
    id: str
    name: str
    homeLat: float = Field(ge=-90, le=90)
    homeLng: float = Field(ge=-180, le=180)
    payloads: list[str] = Field(default_factory=list)
    platform: PlatformModel


class AllocationPlanModel(BaseModel):
    mode: Literal["survey", "lidar", "inspection", "corridor"] = "survey"
    allocationAlgorithm: Literal["contiguous", "nearest_home", "cvrp"] = "contiguous"
    segments: list[SurveySegment] = Field(min_length=1)

    @field_validator("segments")
    @classmethod
    def validate_segments(cls, segments: list[SurveySegment]) -> list[SurveySegment]:
        for segment in segments:
            if len(segment) != 2 or any(len(point) != 2 for point in segment):
                raise ValueError("Каждый галс должен состоять из двух координат [lat, lng].")
            for latitude, longitude in segment:
                if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                    raise ValueError("Координаты галса выходят за диапазоны WGS84.")
        return segments


class AllocationRequestModel(BaseModel):
    plan: AllocationPlanModel
    units: list[FleetUnitModel] = Field(min_length=1)


class MavlinkMissionRequest(BaseModel):
    connection: str = "udp:127.0.0.1:14550"
    segments: list[SurveySegment] = Field(min_length=1)
    home: Coordinate = Field(min_length=2, max_length=2)
    altitudeM: float = Field(default=120, gt=0)
    transitAltitudeM: float = Field(default=50, gt=0)
    timeoutSeconds: float = Field(default=10, gt=0, le=60)
    autoMode: int = Field(default=3, ge=0)
    cameraTriggerDistanceM: float = Field(default=1, ge=0)
