"""Поиск порядка и направлений прохода галсов.

Задача: пройти каждый галс ровно один раз, выбрав для каждого направление,
и минимизировать суммарную стоимость переходов (см. ``cost.py``). Это
вариант задачи коммивояжёра на «кластерах» из двух узлов — два направления
одного галса, из которых берётся ровно один. Точное решение на сотнях галсов
за секунду недостижимо, поэтому здесь эвристика в три слоя:

1. **Стартовые решения.** «Змейка» (порядок как у геометрии, каждый второй
   галс перевёрнут) и жадный «ближайший сосед» из нескольких стартов.
2. **Локальный поиск** до локального минимума:

   * 2-opt с переворотом: участок маршрута проходится в обратном порядке,
     каждый галс в нём — в обратную сторону. Частный случай длины 1 —
     просто переворот одного галса. Благодаря симметрии стоимости (см.
     ``cost.py``) внутренние переходы участка не меняются, и выигрыш
     считается по двум граничным переходам за O(1);
   * or-opt: блок из 1–3 подряд идущих посещений переносится в другое место
     маршрута, как есть или развёрнутым.

3. **Итеративный локальный поиск** — пока есть время: лучшее решение
   случайно «встряхивается» (double-bridge), снова спускается локальным
   поиском, и результат принимается, если стал лучше.

Всё детерминировано при фиксированном ``seed``.
"""

from __future__ import annotations

import random
import time
from typing import Optional

from .cost import CostMatrix
from .model import track_node

_EPS = 1e-9


def snake(n_tracks: int) -> list[int]:
    """Базовое решение: порядок галсов как есть, каждый второй перевёрнут."""
    return [track_node(i, i % 2 == 1) for i in range(n_tracks)]


def nearest_neighbour(costs: CostMatrix, first: Optional[int] = None) -> list[int]:
    """Жадный маршрут: из текущей точки — в самое дешёвое непройденное посещение.

    Args:
        first: посещение, с которого начать. Если ``None``, стартуем из точки
            взлёта (без неё — с самого дешёвого посещения, то есть с нулевой
            стоимостью, фактически с галса 0).
    """
    n = costs.n_tracks
    remaining = set(range(n))
    route: list[int] = []
    current = costs.depot_node
    if first is not None:
        route.append(first)
        remaining.discard(first >> 1)
        current = first
    transition = costs.transition
    while remaining:
        best_node = -1
        best_cost = float("inf")
        for track in sorted(remaining):
            for node in (2 * track, 2 * track + 1):
                cost = transition(current, node)
                if cost < best_cost - _EPS:
                    best_cost, best_node = cost, node
        route.append(best_node)
        remaining.discard(best_node >> 1)
        current = best_node
    return route


def local_search(
    route: list[int], costs: CostMatrix, deadline: Optional[float] = None
) -> list[int]:
    """Спуск 2-opt/or-opt до локального минимума (или до ``deadline``)."""
    t = costs.transition
    depot = costs.depot_node
    n = len(route)
    if n < 1:
        return list(route)
    p = [depot, *route, depot]

    improved = True
    while improved:
        improved = False

        # 2-opt с переворотом галсов; при i == j — переворот одного галса.
        for i in range(1, n + 1):
            if deadline is not None and time.monotonic() > deadline:
                return p[1:-1]
            before = p[i - 1]
            first = p[i]
            edge_in = t(before, first)
            for j in range(i, n + 1):
                last = p[j]
                after = p[j + 1]
                delta = t(before, last ^ 1) + t(first ^ 1, after) - edge_in - t(last, after)
                if delta < -_EPS:
                    p[i : j + 1] = [node ^ 1 for node in reversed(p[i : j + 1])]
                    improved = True
                    first = p[i]
                    edge_in = t(before, first)

        # or-opt: перенос блока из 1..3 посещений, как есть или развёрнутым.
        for block in (1, 2, 3):
            if block > n:
                break
            i = 1
            while i + block - 1 <= n:
                if deadline is not None and time.monotonic() > deadline:
                    return p[1:-1]
                j = i + block - 1
                prev, first, last, nxt = p[i - 1], p[i], p[j], p[j + 1]
                gain = t(prev, first) + t(last, nxt) - t(prev, nxt)
                best_delta = -_EPS
                best_move: Optional[tuple[int, bool]] = None
                if gain > _EPS:
                    for q in range(0, n + 1):
                        if i - 1 <= q <= j:
                            continue
                        left, right = p[q], p[q + 1]
                        base = t(left, right)
                        forward = t(left, first) + t(last, right) - base - gain
                        if forward < best_delta:
                            best_delta, best_move = forward, (q, False)
                        backward = t(left, last ^ 1) + t(first ^ 1, right) - base - gain
                        if backward < best_delta:
                            best_delta, best_move = backward, (q, True)
                if best_move is None:
                    i += 1
                    continue
                q, reverse = best_move
                segment = p[i : j + 1]
                if reverse:
                    segment = [node ^ 1 for node in reversed(segment)]
                rest = p[:i] + p[j + 1 :]
                insert_at = q + 1 if q < i else q - block + 1
                p = rest[:insert_at] + segment + rest[insert_at:]
                improved = True
                # позиции сдвинулись — продолжаем с того же i
    return p[1:-1]


def _double_bridge(route: list[int], rng: random.Random) -> list[int]:
    """Встряска: A B C D → A C B D. Сохраняет направления галсов."""
    n = len(route)
    cuts = sorted(rng.sample(range(1, n), 3))
    a, b, c = cuts
    return route[:a] + route[b:c] + route[a:b] + route[c:]


def optimize_order(
    costs: CostMatrix, time_limit_s: float = 1.0, seed: int = 0, max_stall: int = 200
) -> list[int]:
    """Лучший найденный порядок и направления прохода всех галсов.

    Результат никогда не хуже «змейки»: она всегда среди стартовых решений.
    Поиск останавливается по ``time_limit_s`` или после ``max_stall``
    встрясок подряд без улучшения — на выпуклых участках это доли секунды.
    """
    start = time.monotonic()
    deadline = start + max(0.0, time_limit_s)
    n = costs.n_tracks
    rng = random.Random(seed)

    starts: list[list[int]] = [snake(n), nearest_neighbour(costs)]
    if costs.problem.depot is None:
        # Без точки взлёта концы маршрута свободны: пробуем стартовать с краёв.
        for node in (0, 1, 2 * n - 2, 2 * n - 1):
            starts.append(nearest_neighbour(costs, first=node))

    best: Optional[list[int]] = None
    best_cost = float("inf")
    for candidate in starts:
        improved = local_search(candidate, costs, deadline)
        cost = costs.total(improved)
        if cost < best_cost - _EPS:
            best, best_cost = improved, cost
        if time.monotonic() > deadline:
            break
    assert best is not None

    if n >= 8:
        stall = 0
        while stall < max_stall and time.monotonic() < deadline:
            candidate = local_search(_double_bridge(best, rng), costs, deadline)
            cost = costs.total(candidate)
            if cost < best_cost - _EPS:
                best, best_cost, stall = candidate, cost, 0
            else:
                stall += 1
    return best
