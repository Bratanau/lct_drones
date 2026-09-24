"""``python -m src.optimizer``: один JSON из stdin → один JSON в stdout.

Ошибки — в том же формате, что у ``src.geometry.service``:
``{"errors": [...]}`` и код выхода 1.
"""

from __future__ import annotations

import json
import sys

from .service import optimize


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(optimize(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as error:  # noqa: BLE001 - граница subprocess должна вернуть JSON-ошибку.
        print(json.dumps({"errors": [str(error)]}, ensure_ascii=False))
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
