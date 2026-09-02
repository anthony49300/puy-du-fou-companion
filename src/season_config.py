"""Configuration des dates de saison, éditable directement dans
`data/seasons.json` sans passer par une commande Python.

Même principe que `data/known_spectacles.json` / `src/normalizer.py` pour
les spectacles : le fichier fait autorité, la base de données (table
`seasons`, colonnes `start_date`/`end_date`) n'en garde qu'une copie
resynchronisée à chaque collecte/export via `sync_to_database`. La
commande CLI `set-season-dates` (src/main.py) reste disponible en
alternative, mais si le fichier définit des dates pour une année, elles
prennent le pas dessus au prochain appel de `sync_to_database` (même
logique que la synchronisation nom/catégorie des spectacles dans
`database.get_or_create_spectacle`).
"""
from __future__ import annotations

import json
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Optional

from src import config


@lru_cache(maxsize=1)
def _load_seasons_config(path: Optional[str] = None) -> dict:
    seasons_path = Path(path) if path else config.SEASONS_CONFIG_PATH
    if not seasons_path.exists():
        return {}
    with open(seasons_path, encoding="utf-8") as f:
        data = json.load(f)
    data.pop("_comment", None)
    return data


def clear_cache() -> None:
    """Utile pour les tests qui modifient data/seasons.json à la volée."""
    _load_seasons_config.cache_clear()


def configured_years() -> list[int]:
    """Années présentes dans data/seasons.json (indépendamment du fait que
    leurs dates soient renseignées ou encore à null)."""
    return sorted(int(y) for y in _load_seasons_config().keys())


def get_configured_dates(year: int) -> tuple[Optional[str], Optional[str]]:
    """Retourne (start_date, end_date) tels que renseignés dans
    data/seasons.json pour cette année. (None, None) si l'année est absente
    du fichier ou si ses dates n'y sont pas encore renseignées (null)."""
    entry = _load_seasons_config().get(str(year))
    if not entry:
        return None, None
    return entry.get("start_date"), entry.get("end_date")


def sync_to_database(conn: sqlite3.Connection, year: int) -> None:
    """Applique à la base les dates de data/seasons.json pour une année
    donnée, si ce fichier en définit (start_date et/ou end_date non nulles)
    pour cette année. Si le fichier ne renseigne qu'une des deux dates,
    l'autre est préservée telle qu'elle est déjà en base (ex: définie via
    la commande `set-season-dates`) plutôt qu'effacée. Si le fichier ne dit
    rien du tout pour cette année, ne touche à rien.
    """
    from src import database  # import local : évite un cycle database <-> season_config

    start_date, end_date = get_configured_dates(year)
    if start_date is None and end_date is None:
        return

    existing = database.get_season_by_year(conn, year)
    if start_date is None and existing:
        start_date = existing["start_date"]
    if end_date is None and existing:
        end_date = existing["end_date"]
    database.set_season_dates(conn, year, start_date=start_date, end_date=end_date)


def sync_all_to_database(conn: sqlite3.Connection) -> None:
    """Synchronise toutes les années présentes dans data/seasons.json.

    À préférer à `sync_to_database(conn, année)` pour toute recherche par
    PLAGE de dates plutôt que par année calendaire (voir
    `database.get_season_for_date`) : une saison peut chevaucher le nouvel
    an, auquel cas la seule année de la date recherchée ne suffit pas à
    retrouver la bonne saison si elle n'a encore jamais été synchronisée.
    """
    for year in configured_years():
        sync_to_database(conn, year)
