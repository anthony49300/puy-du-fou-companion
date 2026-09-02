"""Structures de données partagées entre les modules.

Ce ne sont pas des modèles ORM : `database.py` reste responsable du SQL.
Ces dataclasses servent uniquement à faire circuler des données typées et
documentées entre le collector, le parser, le normalizer, les statistiques
et l'exporteur, sans se passer des dictionnaires "au petit bonheur".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date as date_cls
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from src import config


@dataclass
class Season:
    id: Optional[int]
    year: int
    name: str
    start_date: Optional[str] = None  # ISO "YYYY-MM-DD", None si pas encore connue
    end_date: Optional[str] = None


@dataclass
class DateEntry:
    """Une version du programme pour une date donnée.

    Une même date (ex: 2026-08-26) peut avoir plusieurs lignes en base si le
    programme officiel a été corrigé après une première collecte : seule la
    ligne avec `is_active=True` (la plus récente valide) est utilisée pour
    les exports, mais les anciennes versions restent en base pour
    l'historique.
    """

    id: Optional[int]
    date: str  # ISO "YYYY-MM-DD"
    season_id: int
    source_url: str
    source_file: Optional[str]
    source_hash: Optional[str]  # hash des octets bruts du PDF (audit)
    retrieved_at: str
    program_published_at: Optional[str]
    status: str
    content_hash: Optional[str] = None  # hash du contenu structuré (détection de changement réel)
    version: int = 1
    is_active: bool = True
    warnings: str = "[]"  # JSON-encoded list[str]
    created_at: Optional[str] = None


@dataclass
class Spectacle:
    id: Optional[int]
    name: str
    slug: str
    category: str
    description: str = ""
    active: bool = True


@dataclass
class Representation:
    id: Optional[int]
    date_id: int
    spectacle_id: int
    start_time: Optional[str]  # "HH:MM" ou None si horaire non déterminé
    end_time: Optional[str]
    is_continuous: bool
    status: str
    source_text: str


@dataclass
class CollectionLog:
    id: Optional[int]
    started_at: str
    finished_at: Optional[str]
    status: str
    message: str
    source_url: str


@dataclass
class ParsedRepresentation:
    """Sortie brute du parser, avant résolution en base de données."""

    name_raw: str
    start_time: Optional[str]
    end_time: Optional[str]
    is_continuous: bool
    status: str
    source_text: str
    line_no: int = -1


@dataclass
class ParseResult:
    date_found: Optional[str]
    representations: list[ParsedRepresentation] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    strategy_used: str = "text"
    # True quand la source indique explicitement que le parc est fermé ce
    # jour-là (par opposition à "aucune représentation détectée", qui peut
    # aussi signaler une anomalie de parsing). Seul schedule_json_parser le
    # positionne pour l'instant (voir sa docstring) ; toujours False côté
    # pdf_parser, qui n'a pas de moyen fiable de distinguer les deux cas.
    park_closed: bool = False


def now_iso() -> str:
    """Horodatage ISO 8601 avec secondes, sans dépendre du fuseau système."""
    return datetime.now().isoformat(timespec="seconds")


def today_paris() -> date_cls:
    """Date du jour en heure de Paris — PAS `date.today()` (naïve, fuseau du
    serveur qui exécute la collecte : UTC sur les runners GitHub Actions).
    Sans ça, "aujourd'hui" décale d'1-2h par rapport aux visiteurs français
    en tout début/fin de journée (ex: minuit passé à Paris mais toujours la
    veille en UTC)."""
    return datetime.now(ZoneInfo(config.TIMEZONE_NAME)).date()
