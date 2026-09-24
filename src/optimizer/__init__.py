"""Оптимизатор маршрута: порядок и направления галсов, разбиение на вылеты.

Зависит только от стандартной библиотеки. Точка входа для интеграции —
:func:`optimize` (словарь → словарь) или ``python -m src.optimizer``
(JSON через stdin/stdout, как у ``src.geometry.service``).
"""

from .model import OptimizerError
from .service import optimize

__all__ = ["OptimizerError", "optimize"]
