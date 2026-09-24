"""Разбиение маршрута на вылеты по запасу батареи.

Подход «сначала маршрут, потом вылеты» (route-first, cluster-second): общий
порядок галсов строит ``search.py``, а здесь он оптимально режется на куски.
Каждый кусок — отдельный вылет: взлёт → галсы куска → посадка.

Разрез ищется динамическим программированием (алгоритм Split, Beasley 1983,
Prins 2004): ``best[j]`` — минимальная стоимость покрытия первых ``j``
посещений целыми вылетами. Для заданного порядка это точный оптимум, в
отличие от жадного «набиваем, пока влезает».

В отличие от ``_split_flights`` в ``geometry/service.py``, в лимит вылета
входит всё, что реально расходует батарею: перелёт к участку, галсы,
переходы между ними, развороты и возврат в точку взлёта.
"""

from __future__ import annotations

import math
from typing import Optional

from .cost import CostMatrix
from .model import OptimizerError

_TOLERANCE_M = 1e-6


def split_into_flights(
    route: list[int],
    costs: CostMatrix,
    max_flight_m: Optional[float],
    flight_overhead_m: float = 0.0,
) -> list[list[int]]:
    """Режет маршрут на вылеты, не превышающие ``max_flight_m``.

    Args:
        route: порядок посещений, каждый галс ровно один раз.
        max_flight_m: лимит стоимости одного вылета, метры. ``None`` — один вылет.
        flight_overhead_m: условная цена ещё одного вылета (смена батареи),
            метры. При ``0`` минимизируется только суммарный налёт.

    Raises:
        OptimizerError: если какой-то галс не помещается в вылет даже один —
            с перелётом туда и обратно.
    """
    if not route:
        return []
    if max_flight_m is None:
        return [list(route)]

    if costs.problem.depot is None:
        return _split_open_path(route, costs, max_flight_m)

    t = costs.transition
    depot = costs.depot_node
    n = len(route)
    best = [0.0] + [math.inf] * n
    previous = [-1] * (n + 1)

    for i in range(n):
        if best[i] == math.inf:
            continue
        outbound = t(depot, route[i])
        inner = 0.0  # стоимость внутри вылета без плеча возврата
        for j in range(i, n):
            node = route[j]
            if j > i:
                inner += t(route[j - 1], node)
            inner += costs.coverage(node)
            if outbound + inner > max_flight_m + _TOLERANCE_M:
                break  # дальше только дороже: плечо возврата не отрицательно
            flight = outbound + inner + t(node, depot)
            if flight > max_flight_m + _TOLERANCE_M:
                continue  # отсюда домой не хватает, но следующий галс может быть ближе
            candidate = best[i] + flight + flight_overhead_m
            if candidate < best[j + 1]:
                best[j + 1] = candidate
                previous[j + 1] = i

    if best[n] == math.inf:
        raise OptimizerError(_explain_infeasible(route, costs, max_flight_m))

    flights: list[list[int]] = []
    end = n
    while end > 0:
        begin = previous[end]
        flights.append(list(route[begin:end]))
        end = begin
    flights.reverse()
    return flights


def _split_open_path(route: list[int], costs: CostMatrix, max_flight_m: float) -> list[list[int]]:
    """Разбиение без точки взлёта.

    Без неё суммарная стоимость пути от места разреза не зависит, и
    динамика выродилась бы в «каждый галс — отдельный вылет». Поэтому цель
    здесь другая — минимум вылетов, и для непрерывных кусков её точно даёт
    жадное заполнение: набираем галсы, пока вылет помещается в лимит.
    """
    t = costs.transition
    flights: list[list[int]] = []
    current: list[int] = []
    load = 0.0
    for node in route:
        step = costs.coverage(node) + (t(current[-1], node) if current else 0.0)
        if current and load + step > max_flight_m + _TOLERANCE_M:
            flights.append(current)
            current, load = [], 0.0
            step = costs.coverage(node)
        if step > max_flight_m + _TOLERANCE_M:
            raise OptimizerError(_explain_infeasible(route, costs, max_flight_m))
        current.append(node)
        load += step
    if current:
        flights.append(current)
    return flights


def _explain_infeasible(route: list[int], costs: CostMatrix, max_flight_m: float) -> str:
    """Ищет галс, который не влезает в вылет сам по себе, для понятной ошибки."""
    for node in route:
        alone = min(costs.total([node]), costs.total([node ^ 1]))
        if alone > max_flight_m + _TOLERANCE_M:
            track = costs.problem.tracks[node >> 1]
            return (
                f"Галс {track.id} не помещается в один вылет: нужно {alone:.0f} м "
                f"с перелётом от точки взлёта и обратно, а лимит {max_flight_m:.0f} м."
            )
    return "Маршрут не удаётся разбить на вылеты в пределах лимита дистанции."
