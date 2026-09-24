"""Модель стоимости маршрута — «измеритель».

Стоимость маршрута в метрах складывается из трёх частей:

* **покрытие** — сумма длин галсов. От порядка и направлений не зависит,
  но входит в итог, чтобы число было честной длиной полёта;
* **перелёты** — прямые отрезки от конца одного посещения до начала
  следующего, плюс плечи от точки взлёта и обратно, если она задана;
* **штраф за повороты** — ``turn_penalty_m`` метров за каждые 180° поворота.

Почему штраф пропорционален углу, а не фиксирован на каждый переход, как в
``geometry/service.py``: фиксированная добавка одинакова для любого порядка
галсов, то есть оптимизатор её просто не видит. Угловая модель различает
случаи, которые реально различаются для дрона:

* классический разворот «змейкой» (90° + 90°) стоит ровно ``turn_penalty_m``
  — ровно столько же, сколько в старой модели, числа сопоставимы;
* продолжение в ту же сторону по соседнему куску той же линии (вогнутый
  участок, галс разрезан вырезом) стоит 0;
* заход на галс «против шерсти», с разворотом почти на 360°, стоит вдвое
  больше обычного.

Свойство, на котором держится быстрый 2-opt: стоимость перехода не меняется,
если отрезок маршрута пройти в обратном порядке с переворотом каждого галса.
Длина перехода та же, а углы поворота — это углы между теми же векторами с
обратным знаком, то есть те же самые. Проверяется в тестах.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence

from .model import OptimizerError, Point, Problem

_EPS_LENGTH = 1e-6


@dataclass(frozen=True)
class CostModel:
    """Параметры стоимости.

    Attributes:
        turn_penalty_m: сколько метров стоит поворот на 180°. Прокси для
            времени и энергии на торможение, разворот и разгон.
    """

    turn_penalty_m: float = 20.0

    def __post_init__(self) -> None:
        if not math.isfinite(self.turn_penalty_m) or self.turn_penalty_m < 0:
            raise OptimizerError("Штраф за поворот должен быть неотрицательным числом.")


@dataclass(frozen=True)
class Breakdown:
    """Разложение стоимости маршрута, всё в метрах."""

    coverage: float = 0.0
    transit: float = 0.0
    turn: float = 0.0

    @property
    def distance(self) -> float:
        """Реально пролетаемое расстояние: покрытие + перелёты."""
        return self.coverage + self.transit

    @property
    def total(self) -> float:
        """Целевая функция: расстояние + штраф за повороты."""
        return self.coverage + self.transit + self.turn

    def __add__(self, other: "Breakdown") -> "Breakdown":
        return Breakdown(
            self.coverage + other.coverage,
            self.transit + other.transit,
            self.turn + other.turn,
        )


def _unit(dx: float, dy: float) -> Optional[Point]:
    norm = math.hypot(dx, dy)
    if norm < _EPS_LENGTH:
        return None
    return dx / norm, dy / norm


def _angle(u: Optional[Point], v: Optional[Point]) -> float:
    """Неориентированный угол между направлениями, радианы в ``[0, π]``."""
    if u is None or v is None:
        return 0.0
    cross = u[0] * v[1] - u[1] * v[0]
    dot = u[0] * v[0] + u[1] * v[1]
    return abs(math.atan2(cross, dot))


class CostMatrix:
    """Предпосчитанные стоимости всех переходов между посещениями.

    Узлы: ``0 .. 2n-1`` — посещения галсов (см. ``model.py``),
    ``2n`` — точка взлёта (``depot_node``). Если точка взлёта не задана,
    все переходы из неё и в неё бесплатны — маршрут открытый.
    """

    def __init__(self, problem: Problem, model: CostModel = CostModel()) -> None:
        self.problem = problem
        self.model = model
        n = len(problem.tracks)
        self.n_tracks = n
        self.depot_node = 2 * n
        size = 2 * n + 1
        self._size = size

        entry: list[Point] = []
        exit_: list[Point] = []
        heading: list[Optional[Point]] = []
        coverage: list[float] = []
        for track in problem.tracks:
            forward = _unit(track.b[0] - track.a[0], track.b[1] - track.a[1])
            backward = None if forward is None else (-forward[0], -forward[1])
            entry += [track.a, track.b]
            exit_ += [track.b, track.a]
            heading += [forward, backward]
            coverage += [track.length, track.length]
        self._entry = entry
        self._exit = exit_
        self._heading = heading
        self._coverage = coverage

        dist = [0.0] * (size * size)
        turn = [0.0] * (size * size)
        penalty_per_rad = model.turn_penalty_m / math.pi
        depot = problem.depot
        for u in range(size):
            u_is_depot = u == self.depot_node
            if u_is_depot and depot is None:
                continue
            u_point = depot if u_is_depot else exit_[u]
            u_heading = None if u_is_depot else heading[u]
            row = u * size
            for v in range(size):
                if v == self.depot_node:
                    if depot is None or u_is_depot:
                        continue
                    v_point, v_heading = depot, None
                else:
                    if (v >> 1) == (u >> 1) and not u_is_depot:
                        continue  # переход галса сам в себя не встречается
                    v_point, v_heading = entry[v], heading[v]
                dx = v_point[0] - u_point[0]
                dy = v_point[1] - u_point[1]
                leg = _unit(dx, dy)
                if leg is None:
                    angle = _angle(u_heading, v_heading)
                    length = 0.0
                else:
                    angle = _angle(u_heading, leg) + _angle(leg, v_heading)
                    length = math.hypot(dx, dy)
                dist[row + v] = length
                turn[row + v] = angle * penalty_per_rad
        self._dist = dist
        self._turn = turn
        self._cost = [d + t for d, t in zip(dist, turn)]

    # --- быстрый доступ для поиска -------------------------------------

    def transition(self, u: int, v: int) -> float:
        """Стоимость перехода от конца посещения ``u`` к началу ``v``."""
        return self._cost[u * self._size + v]

    def coverage(self, node: int) -> float:
        """Длина галса, которому принадлежит посещение."""
        return self._coverage[node]

    def entry(self, node: int) -> Point:
        """Точка, где посещение начинается."""
        return self._entry[node]

    def exit(self, node: int) -> Point:
        """Точка, где посещение заканчивается."""
        return self._exit[node]

    # --- измеритель ------------------------------------------------------

    def breakdown(self, route: Sequence[int]) -> Breakdown:
        """Стоимость одного вылета: взлёт → посещения по порядку → посадка.

        Без точки взлёта — открытый путь по тем же посещениям.
        """
        if not route:
            return Breakdown()
        size = self._size
        d = self.depot_node
        coverage = sum(self._coverage[node] for node in route)
        path = [d, *route, d]
        transit = 0.0
        turn = 0.0
        for u, v in zip(path, path[1:]):
            transit += self._dist[u * size + v]
            turn += self._turn[u * size + v]
        return Breakdown(coverage, transit, turn)

    def total(self, route: Sequence[int]) -> float:
        """Целевая функция одного вылета, метры."""
        return self.breakdown(route).total
