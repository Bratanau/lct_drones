"""Сборка плана полётов: порядок → вылеты → доводка каждого вылета."""

from __future__ import annotations

from dataclasses import dataclass

from .cost import Breakdown, CostMatrix
from .search import local_search, optimize_order, snake
from .split import split_into_flights


@dataclass(frozen=True)
class Plan:
    """Результат: вылеты по порядку, в каждом — посещения по порядку."""

    flights: tuple[tuple[int, ...], ...]
    breakdown: Breakdown
    flight_breakdowns: tuple[Breakdown, ...]


def evaluate(flights: list[list[int]], costs: CostMatrix) -> Plan:
    """Считает стоимость готового плана.

    С точкой взлёта каждый вылет — замкнутый рейс от неё и обратно. Без неё
    вылеты считаются кусками одного открытого пути, и переходы между ними
    входят в общий итог, но не в дистанцию отдельных вылетов.
    """
    per_flight = tuple(costs.breakdown(flight) for flight in flights)
    if costs.problem.depot is not None:
        total = sum(per_flight, Breakdown())
    else:
        total = costs.breakdown([node for flight in flights for node in flight])
    return Plan(tuple(tuple(f) for f in flights), total, per_flight)


def _orient_for_single_flights(route: list[int], costs: CostMatrix) -> list[int]:
    """Переворачивает галс, если только в обратную сторону он влезает в вылет."""
    limit = costs.problem.max_flight_m
    if limit is None:
        return route
    fixed = []
    for node in route:
        if costs.total([node]) > limit and costs.total([node ^ 1]) <= limit:
            node ^= 1
        fixed.append(node)
    return fixed


def build_plan(
    costs: CostMatrix,
    time_limit_s: float = 1.0,
    seed: int = 0,
    flight_overhead_m: float = 0.0,
) -> Plan:
    """Оптимизированный план полётов."""
    problem = costs.problem
    route = optimize_order(costs, time_limit_s=time_limit_s, seed=seed)
    route = _orient_for_single_flights(route, costs)
    flights = split_into_flights(route, costs, problem.max_flight_m, flight_overhead_m)
    # Каждый вылет — самостоятельный рейс: доводим его отдельно. Локальный
    # поиск только уменьшает стоимость, поэтому лимит вылета не нарушится.
    if len(flights) > 1:
        flights = [local_search(flight, costs) for flight in flights]
    return evaluate(flights, costs)


def build_baseline(costs: CostMatrix) -> Plan:
    """Точка отсчёта: «змейка» без оптимизации, те же правила разбиения."""
    problem = costs.problem
    route = _orient_for_single_flights(snake(len(problem.tracks)), costs)
    flights = split_into_flights(route, costs, problem.max_flight_m)
    return evaluate(flights, costs)
