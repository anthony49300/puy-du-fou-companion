#!/usr/bin/env python3
"""Script utilitaire : recalcule et affiche les statistiques globales.

Utile en local ou en CI pour vérifier rapidement l'état de la base sans
passer par l'export JSON complet.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.main import build_parser  # noqa: E402


def main() -> int:
    parser = build_parser()
    args = parser.parse_args(["stats"] + sys.argv[1:])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
