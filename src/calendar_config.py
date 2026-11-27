"""Calendrier scolaire (zone B) + jours fériés, éditable directement dans
`data/calendar.json` — même principe que `src/season_config.py` pour
`data/seasons.json` : le fichier fait autorité, pas de commande Python
nécessaire pour le modifier.

Utilisé pour classifier un jour (semaine/week-end, vacances scolaires,
jour férié) dans la distribution horaire par spectacle et le programme
probable (voir `src/exporter.py:export_schedule_index` et
`site/js/schedule-stats.js`).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Optional

from src import config


@lru_cache(maxsize=1)
def _load(path: Optional[str] = None) -> dict:
    calendar_path = Path(path) if path else config.CALENDAR_CONFIG_PATH
    if not calendar_path.exists():
        return {"source": None, "school_holidays": [], "public_holidays": []}
    with open(calendar_path, encoding="utf-8") as f:
        data = json.load(f)
    data.pop("_comment", None)
    data.setdefault("source", None)
    data.setdefault("school_holidays", [])
    data.setdefault("public_holidays", [])
    return data


def clear_cache() -> None:
    """Utile pour les tests qui modifient data/calendar.json à la volée."""
    _load.cache_clear()


def load() -> dict:
    """{"source": str|None, "school_holidays": [{"name","start","end"}, ...],
    "public_holidays": ["YYYY-MM-DD", ...]} — vide (mais valide) si le
    fichier est absent, pour que les appelants (export, filtres côté
    frontend) dégradent gracieusement plutôt que d'échouer."""
    return _load()
