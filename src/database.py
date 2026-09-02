"""Accès à la base SQLite : schéma, connexion, opérations CRUD.

Principe d'historisation : la table `dates` ne contient jamais de mise à
jour destructive. Quand le programme officiel d'une date déjà collectée
change (hash de contenu différent), une NOUVELLE ligne `dates` est insérée
avec `version` incrémenté et `is_active=1`, tandis que l'ancienne ligne
passe à `is_active=0`. Les représentations restent attachées à la version
(`date_id`) sous laquelle elles ont été extraites : rien n'est jamais
supprimé, ce qui permet de retrouver l'historique complet des versions.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator, Optional

from src import config
from src.models import now_iso

SCHEMA = """
CREATE TABLE IF NOT EXISTS seasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT
);

CREATE TABLE IF NOT EXISTS dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    season_id INTEGER NOT NULL REFERENCES seasons(id),
    source_url TEXT,
    source_file TEXT,
    source_hash TEXT,
    content_hash TEXT,
    retrieved_at TEXT NOT NULL,
    program_published_at TEXT,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    warnings TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dates_date ON dates(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dates_date_version ON dates(date, version);

CREATE TABLE IF NOT EXISTS spectacles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS representations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_id INTEGER NOT NULL REFERENCES dates(id),
    spectacle_id INTEGER NOT NULL REFERENCES spectacles(id),
    start_time TEXT,
    end_time TEXT,
    is_continuous INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    source_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_repr_date ON representations(date_id);
CREATE INDEX IF NOT EXISTS idx_repr_spectacle ON representations(spectacle_id);

CREATE TABLE IF NOT EXISTS collection_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT ''
);
"""


def get_connection(db_path: Optional[Path] = None) -> sqlite3.Connection:
    """Ouvre une connexion SQLite avec row_factory par dict-like access."""
    path = Path(db_path) if db_path else config.DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Crée les tables si elles n'existent pas. Idempotent."""
    conn.executescript(SCHEMA)
    _migrate_missing_columns(conn)
    conn.commit()


def _migrate_missing_columns(conn: sqlite3.Connection) -> None:
    """Ajoute les colonnes introduites après la création initiale d'une base
    existante (léger mécanisme de migration additive, sans dépendance
    externe). N'agit que si la colonne est absente.
    """
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(dates)").fetchall()}
    if "content_hash" not in existing:
        conn.execute("ALTER TABLE dates ADD COLUMN content_hash TEXT")

    existing_seasons = {row["name"] for row in conn.execute("PRAGMA table_info(seasons)").fetchall()}
    if "start_date" not in existing_seasons:
        conn.execute("ALTER TABLE seasons ADD COLUMN start_date TEXT")
    if "end_date" not in existing_seasons:
        conn.execute("ALTER TABLE seasons ADD COLUMN end_date TEXT")


@contextmanager
def connect(db_path: Optional[Path] = None) -> Iterator[sqlite3.Connection]:
    """Context manager pratique : ouvre, initialise le schéma, commit/close."""
    conn = get_connection(db_path)
    try:
        init_db(conn)
        yield conn
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Seasons
# ---------------------------------------------------------------------------

def get_or_create_season(conn: sqlite3.Connection, year: int, name: Optional[str] = None) -> int:
    row = conn.execute("SELECT id FROM seasons WHERE year = ?", (year,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute(
        "INSERT INTO seasons (year, name) VALUES (?, ?)",
        (year, name or f"Saison {year}"),
    )
    return cur.lastrowid


def list_seasons(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM seasons ORDER BY year").fetchall()


def get_season_by_year(conn: sqlite3.Connection, year: int) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM seasons WHERE year = ?", (year,)).fetchone()


def get_season_for_date(conn: sqlite3.Connection, date_str: str) -> Optional[sqlite3.Row]:
    """Retourne la saison (parmi celles dont les dates sont connues) dont
    `[start_date, end_date]` contient `date_str`. Contrairement à
    `get_season_by_year`, ne suppose PAS que la date et la saison
    partagent la même année calendaire : une saison peut chevaucher le
    nouvel an (ex: "Noël au Puy du Fou" jusqu'en janvier), auquel cas une
    date de janvier appartient à la saison de l'année précédente.
    """
    return conn.execute(
        "SELECT * FROM seasons WHERE start_date IS NOT NULL AND end_date IS NOT NULL "
        "AND start_date <= ? AND end_date >= ? LIMIT 1",
        (date_str, date_str),
    ).fetchone()


def set_season_dates(
    conn: sqlite3.Connection, year: int, *, start_date: Optional[str], end_date: Optional[str]
) -> int:
    """Renseigne (ou efface, si None) les dates d'ouverture/fermeture d'une
    saison. Crée la saison si elle n'existe pas encore (ex: dates connues
    avant toute collecte). Retourne l'id de la saison.
    """
    season_id = get_or_create_season(conn, year)
    conn.execute(
        "UPDATE seasons SET start_date = ?, end_date = ? WHERE id = ?",
        (start_date, end_date, season_id),
    )
    return season_id


# ---------------------------------------------------------------------------
# Dates (historisation par version)
# ---------------------------------------------------------------------------

def get_active_date(conn: sqlite3.Connection, date_str: str) -> Optional[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM dates WHERE date = ? AND is_active = 1", (date_str,)
    ).fetchone()


def get_latest_hash(conn: sqlite3.Connection, date_str: str) -> Optional[str]:
    """Hash du CONTENU structuré (représentations) de la dernière version
    active, utilisé pour décider si une nouvelle version doit être créée.
    Ne pas confondre avec `source_hash` (hash des octets bruts du PDF, qui
    peut varier même quand le contenu du programme est inchangé — voir
    `content_hash` dans le schéma et collector.py)."""
    row = get_active_date(conn, date_str)
    return row["content_hash"] if row else None


def create_date_version(
    conn: sqlite3.Connection,
    *,
    date_str: str,
    season_id: int,
    source_url: str,
    source_file: Optional[str],
    source_hash: Optional[str],
    content_hash: Optional[str] = None,
    retrieved_at: str,
    program_published_at: Optional[str],
    status: str,
    warnings: Iterable[str] = (),
) -> tuple[int, int]:
    """Insère une nouvelle version active pour `date_str` et désactive
    l'ancienne version active s'il en existe une.

    Retourne (date_id, version).
    """
    previous = get_active_date(conn, date_str)
    new_version = (previous["version"] + 1) if previous else 1
    if previous:
        conn.execute("UPDATE dates SET is_active = 0 WHERE id = ?", (previous["id"],))

    cur = conn.execute(
        """
        INSERT INTO dates (
            date, season_id, source_url, source_file, source_hash, content_hash,
            retrieved_at, program_published_at, status, version, is_active,
            warnings, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        """,
        (
            date_str,
            season_id,
            source_url,
            source_file,
            source_hash,
            content_hash,
            retrieved_at,
            program_published_at,
            status,
            new_version,
            json.dumps(list(warnings), ensure_ascii=False),
            now_iso(),
        ),
    )
    return cur.lastrowid, new_version


def get_date_versions(conn: sqlite3.Connection, date_str: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM dates WHERE date = ? ORDER BY version", (date_str,)
    ).fetchall()


def list_active_dates(
    conn: sqlite3.Connection, season_year: Optional[int] = None
) -> list[sqlite3.Row]:
    if season_year is None:
        return conn.execute(
            "SELECT d.* FROM dates d WHERE d.is_active = 1 ORDER BY d.date"
        ).fetchall()
    return conn.execute(
        """
        SELECT d.* FROM dates d
        JOIN seasons s ON s.id = d.season_id
        WHERE d.is_active = 1 AND s.year = ?
        ORDER BY d.date
        """,
        (season_year,),
    ).fetchall()


# ---------------------------------------------------------------------------
# Spectacles
# ---------------------------------------------------------------------------

def get_or_create_spectacle(
    conn: sqlite3.Connection, *, name: str, slug: str, category: str
) -> int:
    row = conn.execute(
        "SELECT id, name, category FROM spectacles WHERE slug = ?", (slug,)
    ).fetchone()
    if row:
        # data/known_spectacles.json est la SEULE liste faisant autorité pour
        # le nom/la catégorie (voir src/config.py) : si elle a été corrigée
        # après la première collecte de ce spectacle, la ligne existante doit
        # suivre plutôt que de rester figée sur sa toute première valeur.
        if row["name"] != name or row["category"] != category:
            conn.execute(
                "UPDATE spectacles SET name = ?, category = ? WHERE id = ?",
                (name, category, row["id"]),
            )
        return row["id"]
    cur = conn.execute(
        "INSERT INTO spectacles (name, slug, category, active) VALUES (?, ?, ?, 1)",
        (name, slug, category),
    )
    return cur.lastrowid


def list_spectacles(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM spectacles ORDER BY name").fetchall()


def get_spectacle_by_slug(conn: sqlite3.Connection, slug: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM spectacles WHERE slug = ?", (slug,)).fetchone()


# ---------------------------------------------------------------------------
# Representations
# ---------------------------------------------------------------------------

def insert_representation(
    conn: sqlite3.Connection,
    *,
    date_id: int,
    spectacle_id: int,
    start_time: Optional[str],
    end_time: Optional[str],
    is_continuous: bool,
    status: str,
    source_text: str,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO representations (
            date_id, spectacle_id, start_time, end_time, is_continuous, status, source_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (date_id, spectacle_id, start_time, end_time, int(is_continuous), status, source_text),
    )
    return cur.lastrowid


def get_representations_for_date_id(conn: sqlite3.Connection, date_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT r.*, s.name AS spectacle_name, s.slug AS spectacle_slug, s.category AS spectacle_category
        FROM representations r
        JOIN spectacles s ON s.id = r.spectacle_id
        WHERE r.date_id = ?
        ORDER BY (r.start_time IS NULL), r.start_time
        """,
        (date_id,),
    ).fetchall()


def get_representations_for_date_str(conn: sqlite3.Connection, date_str: str) -> list[sqlite3.Row]:
    active = get_active_date(conn, date_str)
    if not active:
        return []
    return get_representations_for_date_id(conn, active["id"])


def get_representations_for_spectacle(conn: sqlite3.Connection, spectacle_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT r.*, d.date AS date
        FROM representations r
        JOIN dates d ON d.id = r.date_id
        WHERE r.spectacle_id = ? AND d.is_active = 1
        ORDER BY d.date
        """,
        (spectacle_id,),
    ).fetchall()


def get_all_active_representations(conn: sqlite3.Connection, season_year: Optional[int] = None) -> list[sqlite3.Row]:
    query = """
        SELECT r.*, d.date AS date, d.status AS date_status, s.name AS spectacle_name,
               s.slug AS spectacle_slug, s.category AS spectacle_category, se.year AS season_year
        FROM representations r
        JOIN dates d ON d.id = r.date_id
        JOIN spectacles s ON s.id = r.spectacle_id
        JOIN seasons se ON se.id = d.season_id
        WHERE d.is_active = 1
    """
    params: tuple = ()
    if season_year is not None:
        query += " AND se.year = ?"
        params = (season_year,)
    query += " ORDER BY d.date, (r.start_time IS NULL), r.start_time"
    return conn.execute(query, params).fetchall()


# ---------------------------------------------------------------------------
# Collection logs
# ---------------------------------------------------------------------------

def log_collection_start(conn: sqlite3.Connection, source_url: str) -> int:
    cur = conn.execute(
        "INSERT INTO collection_logs (started_at, status, message, source_url) VALUES (?, ?, ?, ?)",
        (now_iso(), config.LOG_STATUS_RUNNING, "", source_url),
    )
    conn.commit()
    return cur.lastrowid


def log_collection_finish(conn: sqlite3.Connection, log_id: int, *, status: str, message: str) -> None:
    conn.execute(
        "UPDATE collection_logs SET finished_at = ?, status = ?, message = ? WHERE id = ?",
        (now_iso(), status, message, log_id),
    )
    conn.commit()


def list_collection_logs(conn: sqlite3.Connection, limit: int = 50) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM collection_logs ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
