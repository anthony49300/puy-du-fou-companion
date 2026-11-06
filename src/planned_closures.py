"""Creux planifiés à l'intérieur d'une saison, éditables directement dans
`data/planned_closures.json` — même principe que `src/season_config.py`
pour `data/seasons.json` : le fichier fait autorité, pas de commande
Python nécessaire pour le modifier.

Utilisé par `Collector.collect()` pour distinguer une vraie privatisation
(représentations trouvées alors que le parc n'est normalement pas ouvert au
public à cette période) d'un jour ouvert normal.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Optional

from src import config


@lru_cache(maxsize=1)
def _load_config(path: Optional[str] = None) -> dict:
    closures_path = Path(path) if path else config.PLANNED_CLOSURES_PATH
    if not closures_path.exists():
        return {}
    with open(closures_path, encoding="utf-8") as f:
        data = json.load(f)
    data.pop("_comment", None)
    return data


def clear_cache() -> None:
    """Utile pour les tests qui modifient data/planned_closures.json à la volée."""
    _load_config.cache_clear()


def is_in_planned_gap(date_str: str) -> bool:
    """True si `date_str` (YYYY-MM-DD) tombe dans un creux planifié d'une
    saison, quelle que soit l'année clé dans data/planned_closures.json
    (une plage peut chevaucher le nouvel an, comme pour data/seasons.json)."""
    for ranges in _load_config().values():
        for r in ranges:
            if r["from"] <= date_str <= r["to"]:
                return True
    return False


def all_gaps() -> dict[str, list[tuple[str, str]]]:
    """{année (clé du fichier): [(from, to), ...]} pour toutes les plages
    configurées — utilisé par src/config_consistency.py pour vérifier le
    fichier dans son ensemble plutôt qu'une seule date à la fois."""
    return {
        year: [(r["from"], r["to"]) for r in ranges]
        for year, ranges in _load_config().items()
    }
