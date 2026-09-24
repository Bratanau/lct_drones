"""Пересобирает фикстуры оптимизатора из настоящей геометрии.

Запуск из корня репозитория (нужны shapely и pyproj)::

    python test/fixtures/make_fixtures.py

Каждый файл — ровно выход ``FlightPlannerGeometry.process``, то есть
то, что оптимизатор получает на вход в поле ``tracks``.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.geometry.geometry_processor import FlightPlannerGeometry  # noqa: E402

HERE = Path(__file__).resolve().parent

# Все контуры — [lon, lat], замкнутые.
CASES = {
    # Прямоугольник из test_geometry_processor.py: выпуклый, змейка оптимальна.
    "rectangle": ([
        [37.892015, 55.670110], [37.915050, 55.670110],
        [37.915050, 55.678000], [37.892015, 55.678000], [37.892015, 55.670110],
    ], 50),
    # «П»: вырез сверху режет верхние галсы на два куска — змейка ломается.
    "u_shape": ([
        [37.890, 55.670], [37.920, 55.670], [37.920, 55.680], [37.910, 55.680],
        [37.910, 55.673], [37.900, 55.673], [37.900, 55.680], [37.890, 55.680],
        [37.890, 55.670],
    ], 50),
    # Длинная узкая полоса под углом.
    "diagonal_strip": ([
        [37.900, 55.660], [37.905, 55.660], [37.945, 55.685], [37.940, 55.685],
        [37.900, 55.660],
    ], 40),
    # Большое поле — на нём проверяется разбиение на вылеты.
    "large_field": ([
        [37.850, 55.640], [37.890, 55.640], [37.890, 55.660], [37.850, 55.660],
        [37.850, 55.640],
    ], 60),
}


def _pretty(data) -> str:
    """JSON в том же виде, что даёт prettier: пары координат в одну строку."""
    text = json.dumps(data, ensure_ascii=False, indent=2)
    text = re.sub(
        r"\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]", r"[\1, \2]", text
    )
    return text + "\n"


def main() -> None:
    planner = FlightPlannerGeometry()
    for name, (polygon, spacing) in CASES.items():
        tracks = planner.process(polygon, spacing)
        path = HERE / f"{name}.json"
        path.write_text(_pretty(tracks), encoding="utf-8")
        print(f"{path.name}: {len(tracks)} галсов, шаг {spacing} м")


if __name__ == "__main__":
    main()
