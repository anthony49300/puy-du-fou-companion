#!/usr/bin/env python3
"""Script utilitaire : collecte le programme du jour.

Fin exécutable indépendamment (ex: appelé directement par la GitHub Action),
sans devoir invoquer `python -m src.main`. Renvoie un code de sortie non nul
en cas d'échec de la collecte, pour permettre à la CI de le détecter.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.main import cmd_collect, build_parser  # noqa: E402


def main() -> int:
    parser = build_parser()
    args = parser.parse_args(["collect"] + sys.argv[1:])
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
