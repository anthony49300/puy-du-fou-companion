"""Tests du module src.season_config (data/seasons.json éditable à la main,
synchronisé en base — même principe que known_spectacles.json)."""
import json

import pytest

from src import config, database, season_config


@pytest.fixture(autouse=True)
def _clear_cache():
    season_config.clear_cache()
    yield
    season_config.clear_cache()


@pytest.fixture()
def conn(tmp_path):
    connection = database.get_connection(tmp_path / "test.db")
    database.init_db(connection)
    yield connection
    connection.close()


def _write_config(tmp_path, monkeypatch, data):
    path = tmp_path / "seasons.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "SEASONS_CONFIG_PATH", path)
    season_config.clear_cache()
    return path


def test_get_configured_dates_missing_file_returns_none_none(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SEASONS_CONFIG_PATH", tmp_path / "does-not-exist.json")
    assert season_config.get_configured_dates(2026) == (None, None)


def test_get_configured_dates_reads_file(tmp_path, monkeypatch):
    _write_config(tmp_path, monkeypatch, {"2026": {"start_date": "2026-04-11", "end_date": "2026-11-08"}})
    assert season_config.get_configured_dates(2026) == ("2026-04-11", "2026-11-08")


def test_get_configured_dates_year_absent_returns_none_none(tmp_path, monkeypatch):
    _write_config(tmp_path, monkeypatch, {"2026": {"start_date": "2026-04-11", "end_date": "2026-11-08"}})
    assert season_config.get_configured_dates(2027) == (None, None)


def test_configured_years(tmp_path, monkeypatch):
    _write_config(
        tmp_path, monkeypatch,
        {"2026": {"start_date": "2026-04-11", "end_date": None}, "2027": {"start_date": None, "end_date": None}},
    )
    assert season_config.configured_years() == [2026, 2027]


def test_sync_to_database_creates_season_with_dates(conn, tmp_path, monkeypatch):
    _write_config(tmp_path, monkeypatch, {"2026": {"start_date": "2026-04-11", "end_date": "2026-11-08"}})
    season_config.sync_to_database(conn, 2026)
    row = database.get_season_by_year(conn, 2026)
    assert row["start_date"] == "2026-04-11"
    assert row["end_date"] == "2026-11-08"


def test_sync_to_database_noop_when_year_not_in_file(conn, tmp_path, monkeypatch):
    _write_config(tmp_path, monkeypatch, {"2026": {"start_date": "2026-04-11", "end_date": "2026-11-08"}})
    season_config.sync_to_database(conn, 2099)
    assert database.get_season_by_year(conn, 2099) is None


def test_sync_to_database_preserves_existing_field_when_file_only_sets_one(conn, tmp_path, monkeypatch):
    """Si le fichier ne renseigne que start_date, une end_date déjà en base
    (ex: définie via `set-season-dates`) ne doit pas être effacée."""
    database.set_season_dates(conn, 2026, start_date=None, end_date="2026-11-08")
    _write_config(tmp_path, monkeypatch, {"2026": {"start_date": "2026-04-11", "end_date": None}})

    season_config.sync_to_database(conn, 2026)

    row = database.get_season_by_year(conn, 2026)
    assert row["start_date"] == "2026-04-11"
    assert row["end_date"] == "2026-11-08"  # préservée, pas effacée


def test_sync_to_database_file_overrides_previous_cli_value(conn, tmp_path, monkeypatch):
    """Le fichier fait autorité : s'il définit une valeur, elle prend le pas
    sur ce qui a été précédemment défini via la commande CLI."""
    database.set_season_dates(conn, 2026, start_date="2026-01-01", end_date="2026-12-31")
    _write_config(tmp_path, monkeypatch, {"2026": {"start_date": "2026-04-11", "end_date": "2026-11-08"}})

    season_config.sync_to_database(conn, 2026)

    row = database.get_season_by_year(conn, 2026)
    assert row["start_date"] == "2026-04-11"
    assert row["end_date"] == "2026-11-08"
