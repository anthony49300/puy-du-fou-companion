#!/usr/bin/env python3
"""Script utilitaire : régénère tous les fichiers JSON pour le frontend.

Écrit data/json/{today,spectacles,dates,stats}.json ainsi que
data/json/history/{date}.json pour chaque date active en base.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.main import build_parser  # noqa: E402


def main() -> int:
    parser = build_parser()
    args = parser.parse_args(["export"] + sys.argv[1:])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
