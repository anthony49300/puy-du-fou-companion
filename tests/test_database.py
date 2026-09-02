"""Tests du module src.database (schéma, CRUD, historisation par version)."""

import sqlite3

import pytest

from src import database
from src.models import now_iso


@pytest.fixture()
def conn(tmp_path):
    db_path = tmp_path / "test.db"
    connection = database.get_connection(db_path)
    database.init_db(connection)
    yield connection
    connection.close()


def test_init_db_creates_all_tables(conn):
    tables = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    assert {"seasons", "dates", "spectacles", "representations", "collection_logs"} <= tables


def test_init_db_is_idempotent(conn):
    database.init_db(conn)  # ne doit pas lever d'erreur si rappelé
    database.init_db(conn)


def test_get_or_create_season_returns_same_id(conn):
    id1 = database.get_or_create_season(conn, 2026)
    id2 = database.get_or_create_season(conn, 2026)
    assert id1 == id2


def test_set_season_dates_creates_season_if_missing(conn):
    season_id = database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")
    row = database.get_season_by_year(conn, 2026)
    assert row["id"] == season_id
    assert row["start_date"] == "2026-04-11"
    assert row["end_date"] == "2026-11-08"


def test_set_season_dates_updates_existing_season(conn):
    database.get_or_create_season(conn, 2026)
    database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")
    database.set_season_dates(conn, 2026, start_date="2026-04-12", end_date=None)
    row = database.get_season_by_year(conn, 2026)
    assert row["start_date"] == "2026-04-12"
    assert row["end_date"] is None


def test_get_season_by_year_returns_none_when_absent(conn):
    assert database.get_season_by_year(conn, 1999) is None


def test_get_season_for_date_finds_season_spanning_new_year(conn):
    """Une saison peut chevaucher le nouvel an (ex: 'Noël au Puy du Fou'
    jusqu'en janvier) : une date de janvier doit être retrouvée même si
    elle n'a pas la même année calendaire que la clé 'year' de la saison."""
    database.set_season_dates(conn, 2026, start_date="2026-04-04", end_date="2027-01-03")

    row = database.get_season_for_date(conn, "2027-01-02")
    assert row is not None
    assert row["year"] == 2026

    assert database.get_season_for_date(conn, "2027-01-10") is None
    assert database.get_season_for_date(conn, "2026-01-01") is None


def test_get_season_for_date_ignores_seasons_missing_a_date(conn):
    database.set_season_dates(conn, 2027, start_date="2027-04-10", end_date=None)
    assert database.get_season_for_date(conn, "2027-06-01") is None


def test_get_or_create_spectacle_unique_by_slug(conn):
    id1 = database.get_or_create_spectacle(conn, name="Les Vikings", slug="les-vikings", category="spectacle")
    id2 = database.get_or_create_spectacle(conn, name="Les Vikings", slug="les-vikings", category="spectacle")
    assert id1 == id2
    assert len(database.list_spectacles(conn)) == 1


def test_get_or_create_spectacle_syncs_name_and_category_on_change(conn):
    """data/known_spectacles.json est la seule liste faisant autorité (voir
    src/config.py) : une correction de nom/catégorie doit se répercuter sur
    la ligne existante plutôt que de rester figée sur la toute première
    valeur vue lors de la création."""
    id1 = database.get_or_create_spectacle(conn, name="Le Bal des Oiseaux", slug="le-bal", category="spectacle")
    id2 = database.get_or_create_spectacle(conn, name="Le Bal des Oiseaux Fantômes", slug="le-bal", category="spectacle")
    assert id1 == id2
    row = database.get_spectacle_by_slug(conn, "le-bal")
    assert row["name"] == "Le Bal des Oiseaux Fantômes"
    assert row["category"] == "spectacle"
    assert len(database.list_spectacles(conn)) == 1


def _make_date_version(conn, date_str, source_hash, warnings=()):
    season_id = database.get_or_create_season(conn, int(date_str[:4]))
    return database.create_date_version(
        conn,
        date_str=date_str,
        season_id=season_id,
        source_url="https://example.test/programme",
        source_file=None,
        source_hash=source_hash,
        retrieved_at=now_iso(),
        program_published_at=None,
        status="ok",
        warnings=warnings,
    )


def test_create_date_version_first_version_is_active(conn):
    date_id, version = _make_date_version(conn, "2026-08-26", "hash1")
    assert version == 1
    active = database.get_active_date(conn, "2026-08-26")
    assert active["id"] == date_id
    assert active["is_active"] == 1


def test_create_date_version_deactivates_previous_version(conn):
    first_id, _ = _make_date_version(conn, "2026-08-26", "hash1")
    second_id, version2 = _make_date_version(conn, "2026-08-26", "hash2")

    assert version2 == 2
    first_row = conn.execute("SELECT * FROM dates WHERE id = ?", (first_id,)).fetchone()
    second_row = conn.execute("SELECT * FROM dates WHERE id = ?", (second_id,)).fetchone()
    assert first_row["is_active"] == 0
    assert second_row["is_active"] == 1

    # L'historique complet des versions reste consultable.
    versions = database.get_date_versions(conn, "2026-08-26")
    assert [v["version"] for v in versions] == [1, 2]


def test_date_version_unique_constraint(conn):
    _make_date_version(conn, "2026-08-26", "hash1")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO dates (date, season_id, retrieved_at, status, version, created_at) "
            "VALUES (?, 1, ?, 'ok', 1, ?)",
            ("2026-08-26", now_iso(), now_iso()),
        )


def test_insert_and_retrieve_representations_sorted_by_start_time(conn):
    date_id, _ = _make_date_version(conn, "2026-08-26", "hash1")
    spectacle_id = database.get_or_create_spectacle(conn, name="Les Vikings", slug="les-vikings", category="spectacle")

    database.insert_representation(
        conn, date_id=date_id, spectacle_id=spectacle_id, start_time="16:00", end_time=None,
        is_continuous=False, status="scheduled", source_text="16h00 Les Vikings",
    )
    database.insert_representation(
        conn, date_id=date_id, spectacle_id=spectacle_id, start_time="11:30", end_time=None,
        is_continuous=False, status="scheduled", source_text="11h30 Les Vikings",
    )
    database.insert_representation(
        conn, date_id=date_id, spectacle_id=spectacle_id, start_time=None, end_time=None,
        is_continuous=False, status="unknown", source_text="Les Vikings (horaire illisible)",
    )

    reps = database.get_representations_for_date_id(conn, date_id)
    assert [r["start_time"] for r in reps] == ["11:30", "16:00", None]


def test_get_representations_for_spectacle_only_active_dates(conn):
    spectacle_id = database.get_or_create_spectacle(conn, name="Les Vikings", slug="les-vikings", category="spectacle")

    date_id_v1, _ = _make_date_version(conn, "2026-08-26", "hash1")
    database.insert_representation(
        conn, date_id=date_id_v1, spectacle_id=spectacle_id, start_time="11:30", end_time=None,
        is_continuous=False, status="scheduled", source_text="v1",
    )
    # Nouvelle version : la version 1 devient inactive, ses représentations
    # ne doivent plus apparaître dans les requêtes "actives".
    date_id_v2, _ = _make_date_version(conn, "2026-08-26", "hash2")
    database.insert_representation(
        conn, date_id=date_id_v2, spectacle_id=spectacle_id, start_time="12:00", end_time=None,
        is_continuous=False, status="scheduled", source_text="v2",
    )

    reps = database.get_representations_for_spectacle(conn, spectacle_id)
    assert len(reps) == 1
    assert reps[0]["start_time"] == "12:00"


def test_collection_logs_lifecycle(conn):
    log_id = database.log_collection_start(conn, "https://example.test")
    conn.commit()
    database.log_collection_finish(conn, log_id, status="success", message="ok")
    logs = database.list_collection_logs(conn)
    assert logs[0]["status"] == "success"
    assert logs[0]["finished_at"] is not None
