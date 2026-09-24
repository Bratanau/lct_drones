"""Внутреннее представление задачи для оптимизатора.

Оптимизатор не знает ни про JSON, ни про WGS84, ни про shapely. Он работает
с галсами на локальной плоскости в метрах: ось ``x`` смотрит на восток,
ось ``y`` — на север. Перевод из градусов и обратно живёт в
:class:`LocalProjection`, и больше нигде.

Ключевая идея модели: галс — ненаправленный отрезок. Дрон может пройти его
от ``a`` к ``b`` или от ``b`` к ``a``, покрытие одинаковое. Поэтому единица
решения — не галс, а **посещение**: галс плюс направление прохода.

Посещения кодируются целыми числами, чтобы поиск работал с массивами:

* ``2 * i``     — галс ``i`` пройден от ``a`` к ``b``;
* ``2 * i + 1`` — галс ``i`` пройден от ``b`` к ``a``.

Перевернуть посещение — значит сделать ``node ^ 1``. Маршрут — это список
таких чисел, в котором каждый галс встречается ровно один раз.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence

Point = tuple[float, float]


class OptimizerError(ValueError):
    """Некорректные входные данные оптимизатора."""


@dataclass(frozen=True)
class Track:
    """Один галс на локальной плоскости.

    Attributes:
        id: идентификатор галса из геометрии (``task_id``), нужен только для
            того, чтобы вернуть результат обратно.
        a: один конец галса, метры.
        b: другой конец галса, метры.
        length: длина галса в метрах. Берётся из геометрии (она считала её
            в UTM) и проверяется на согласие с расстоянием между ``a`` и ``b``.
    """

    id: str
    a: Point
    b: Point
    length: float


def track_node(track_index: int, reversed_: bool) -> int:
    """Код посещения галса ``track_index`` в заданном направлении."""
    return 2 * track_index + (1 if reversed_ else 0)


def node_track(node: int) -> int:
    """Индекс галса, которому принадлежит посещение."""
    return node >> 1


def node_reversed(node: int) -> bool:
    """True, если галс проходится от ``b`` к ``a``."""
    return bool(node & 1)


def flip(node: int) -> int:
    """То же посещение в обратном направлении."""
    return node ^ 1


@dataclass(frozen=True)
class LocalProjection:
    """Равнопромежуточная проекция вокруг опорной точки.

    Для участков размером в единицы и десятки километров погрешность
    длины — доли процента, этого достаточно для сравнения маршрутов.
    Метров в градусе широты и долготы считаются по стандартным рядам для
    эллипсоида WGS84, а не по шару, поэтому градус долготы на широте
    Москвы корректно получается примерно вдвое короче градуса широты.
    """

    lon0: float
    lat0: float

    @property
    def _m_per_deg_lat(self) -> float:
        phi = math.radians(self.lat0)
        return 111_132.954 - 559.822 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)

    @property
    def _m_per_deg_lon(self) -> float:
        phi = math.radians(self.lat0)
        return 111_412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi)

    def to_xy(self, lon: float, lat: float) -> Point:
        """Градусы ``(lon, lat)`` → метры ``(x, y)``."""
        return (
            (lon - self.lon0) * self._m_per_deg_lon,
            (lat - self.lat0) * self._m_per_deg_lat,
        )

    def to_lonlat(self, x: float, y: float) -> tuple[float, float]:
        """Метры ``(x, y)`` → градусы ``(lon, lat)``."""
        return (
            self.lon0 + x / self._m_per_deg_lon,
            self.lat0 + y / self._m_per_deg_lat,
        )

    @classmethod
    def around(cls, points_lonlat: Sequence[Sequence[float]]) -> "LocalProjection":
        """Проекция с центром в середине габаритов набора точек."""
        if not points_lonlat:
            raise OptimizerError("Нет точек для выбора центра проекции.")
        lons = [float(p[0]) for p in points_lonlat]
        lats = [float(p[1]) for p in points_lonlat]
        return cls((min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2)


@dataclass(frozen=True)
class Problem:
    """Полная постановка для оптимизатора.

    Attributes:
        tracks: галсы, которые нужно пройти, каждый ровно один раз.
        depot: точка взлёта и посадки в метрах или ``None``. Без неё маршрут
            считается открытым: начало и конец не привязаны ни к чему,
            а перелёты между вылетами не учитываются.
        max_flight_m: сколько метров можно пролететь за один вылет, с учётом
            перелёта к участку и обратно. ``None`` — без ограничения,
            то есть один вылет.
    """

    tracks: tuple[Track, ...]
    depot: Optional[Point] = None
    max_flight_m: Optional[float] = None

    def __post_init__(self) -> None:
        if not self.tracks:
            raise OptimizerError("Нет ни одного галса.")
        if self.max_flight_m is not None and self.max_flight_m <= 0:
            raise OptimizerError("Предельная дистанция вылета должна быть положительной.")
        ids = [track.id for track in self.tracks]
        if len(set(ids)) != len(ids):
            raise OptimizerError("Идентификаторы галсов должны быть уникальными.")
