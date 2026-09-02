"""Tests de src.exporter spécifiques à la gestion des saisons : dossiers
d'historique par année, statut "hors saison" de today.json, et bilan de
fin de saison. Le smoke-test général de validité des JSON exportés vit
dans tests/test_statistics.py (aux côtés des tests de statistiques dont
l'export dépend).
"""
import json

import pytest

from src import config, database, exporter, season_config
from src.models import now_iso


@pytest.fixture(autouse=True)
def _isolate_seasons_config(tmp_path, monkeypatch):
    # Isole ces tests du vrai data/seasons.json (dont le contenu réel
    # changera une fois des dates de saison renseignées) : sans ça, la
    # synchronisation automatique dans export_today()/collect() pourrait
    # écraser les dates posées directement en base par ces tests.
    monkeypatch.setattr(config, "SEASONS_CONFIG_PATH", tmp_path / "seasons-unused.json")
    season_config.clear_cache()
    yield
    season_config.clear_cache()


@pytest.fixture()
def conn(tmp_path):
    connection = database.get_connection(tmp_path / "test.db")
    database.init_db(connection)
    yield connection
    connection.close()


def _add_day(conn, date_str, *, status="ok"):
    season_id = database.get_or_create_season(conn, int(date_str[:4]))
    date_id, _ = database.create_date_version(
        conn,
        date_str=date_str,
        season_id=season_id,
        source_url="https://example.test",
        source_file=None,
        source_hash=f"hash-{date_str}",
        retrieved_at=now_iso(),
        program_published_at=None,
        status=status,
    )
    spectacle_id = database.get_or_create_spectacle(
        conn, name="Les Vikings", slug="les-vikings", category="spectacle"
    )
    database.insert_representation(
        conn, date_id=date_id, spectacle_id=spectacle_id, start_time="11:30", end_time=None,
        is_continuous=False, status=config.REPR_STATUS_SCHEDULED, source_text="11:30 Les Vikings",
    )
    return date_id


def test_write_json_skips_rewrite_when_only_timestamp_differs(tmp_path):
    """Évite un faux changement Git (et donc un commit automatique inutile)
    à chaque export quand rien de réel n'a changé."""
    path = tmp_path / "out.json"
    exporter._write_json(path, {"updated_at": "2026-01-01T00:00:00", "value": 42})
    exporter._write_json(path, {"updated_at": "2026-01-01T00:00:01", "value": 42})

    content = json.loads(path.read_text(encoding="utf-8"))
    assert content["updated_at"] == "2026-01-01T00:00:00"  # fichier non réécrit


def test_write_json_rewrites_when_real_content_changes(tmp_path):
    path = tmp_path / "out.json"
    exporter._write_json(path, {"updated_at": "t1", "value": 42})
    exporter._write_json(path, {"updated_at": "t2", "value": 43})

    content = json.loads(path.read_text(encoding="utf-8"))
    assert content == {"updated_at": "t2", "value": 43}


def test_export_history_writes_into_year_subfolder(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    _add_day(conn, "2026-08-26")

    count = exporter.export_history(conn)

    assert count == 1
    assert (tmp_path / "history" / "2026" / "2026-08-26.json").exists()
    assert not (tmp_path / "history" / "2026-08-26.json").exists()


def test_export_today_reports_before_season(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TODAY_JSON", tmp_path / "today.json")
    database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")

    payload = exporter.export_today(conn, reference_date="2026-02-01")

    assert payload["status"] == config.DATE_STATUS_OUT_OF_SEASON
    assert payload["season_window"] == {"start": "2026-04-11", "end": "2026-11-08"}
    assert payload["next_opening"] == "2026-04-11"
    assert payload["spectacles"] == []


def test_export_today_passes_through_closed_day_status(conn, tmp_path, monkeypatch):
    """Une fermeture ponctuelle EN saison (voir DATE_STATUS_CLOSED_DAY,
    constatée par Collector.collect via schedule_json_parser) doit
    ressortir telle quelle dans today.json — pas réinterprétée comme
    "hors saison" (qui repose sur une plage de dates configurée, absente
    ici) ni comme une erreur."""
    monkeypatch.setattr(config, "TODAY_JSON", tmp_path / "today.json")
    season_id = database.get_or_create_season(conn, 2026)
    database.create_date_version(
        conn, date_str="2026-08-28", season_id=season_id, source_url="https://example.test",
        source_file=None, source_hash="hash-closed", retrieved_at=now_iso(),
        program_published_at=None, status=config.DATE_STATUS_CLOSED_DAY,
        warnings=["Le Puy du Fou est fermé le 2026-08-28."],
    )

    payload = exporter.export_today(conn, reference_date="2026-08-28")

    assert payload["status"] == config.DATE_STATUS_CLOSED_DAY
    assert payload["spectacles"] == []
    assert payload["representation_count"] == 0
    assert payload["warnings"] == ["Le Puy du Fou est fermé le 2026-08-28."]


def test_export_today_reports_after_season_with_next_opening(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TODAY_JSON", tmp_path / "today.json")
    database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")
    database.set_season_dates(conn, 2027, start_date="2027-04-10", end_date=None)
    _add_day(conn, "2026-08-26")

    payload = exporter.export_today(conn, reference_date="2026-12-01")

    assert payload["status"] == config.DATE_STATUS_OUT_OF_SEASON
    assert payload["next_opening"] == "2027-04-10"
    # Repli sur les dernières données fiables connues malgré le statut hors saison.
    assert payload["date"] == "2026-08-26"
    assert payload["spectacles"]


def test_export_today_after_season_without_known_next_opening(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TODAY_JSON", tmp_path / "today.json")
    database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")

    payload = exporter.export_today(conn, reference_date="2026-12-01")

    assert payload["status"] == config.DATE_STATUS_OUT_OF_SEASON
    assert payload["next_opening"] is None


def test_out_of_season_info_handles_season_spanning_new_year(conn):
    """Cas réel : une saison peut chevaucher le nouvel an (ex: 'Noël au Puy
    du Fou' jusqu'en janvier). Une date de janvier doit être reconnue comme
    dans la saison de l'année précédente (recherche par PLAGE de dates,
    pas par année calendaire de reference_date)."""
    database.set_season_dates(conn, 2026, start_date="2026-04-04", end_date="2027-01-03")

    # Dans la saison (qui se termine en janvier 2027).
    in_season, _, _ = exporter._out_of_season_info(conn, "2027-01-02")
    assert in_season is False

    # Réellement hors saison, après la fin réelle (2027-01-03).
    out, window, next_opening = exporter._out_of_season_info(conn, "2027-01-10")
    assert out is True
    assert window == {"start": "2026-04-04", "end": "2027-01-03"}
    assert next_opening is None


def test_export_today_unaffected_when_season_dates_unknown(conn, tmp_path, monkeypatch):
    """Aucune régression : sans dates de saison renseignées, le comportement
    par défaut (erreur "aucune donnée") reste inchangé."""
    monkeypatch.setattr(config, "TODAY_JSON", tmp_path / "today.json")

    payload = exporter.export_today(conn, reference_date="2026-12-01")

    assert payload["status"] == config.DATE_STATUS_ERROR
    assert payload["season_window"] is None


def test_export_season_recap_contents(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")
    _add_day(conn, "2026-08-25")
    _add_day(conn, "2026-08-26")

    payload = exporter.export_season_recap(conn, 2026)

    assert payload["year"] == 2026
    assert payload["start_date"] == "2026-04-11"
    assert payload["end_date"] == "2026-11-08"
    assert payload["days_collected"] == 2
    assert payload["total_representations"] == 2
    assert payload["representations_by_category"] == {"spectacle": 2}

    path = tmp_path / "history" / "2026" / "recap.json"
    assert path.exists()
    assert json.loads(path.read_text(encoding="utf-8"))["year"] == 2026


def test_export_season_recap_unknown_year_returns_none(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    assert exporter.export_season_recap(conn, 1999) is None


def test_maybe_export_season_recaps_finished_is_final_in_progress_is_not(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    database.set_season_dates(conn, 2025, start_date="2025-04-01", end_date="2025-11-01")  # terminée
    database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")  # en cours
    _add_day(conn, "2025-08-01")
    _add_day(conn, "2026-08-26")

    generated = exporter.maybe_export_season_recaps(conn, today="2026-08-27")

    assert sorted(generated) == [2025, 2026]
    recap_2025 = json.loads((tmp_path / "history" / "2025" / "recap.json").read_text(encoding="utf-8"))
    recap_2026 = json.loads((tmp_path / "history" / "2026" / "recap.json").read_text(encoding="utf-8"))
    assert recap_2025["final"] is True and recap_2025["as_of_date"] == "2025-11-01"
    assert recap_2026["final"] is False and recap_2026["as_of_date"] == "2026-08-27"


def test_maybe_export_season_recaps_does_not_overwrite_a_final_recap(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    database.set_season_dates(conn, 2025, start_date="2025-04-01", end_date="2025-11-01")
    _add_day(conn, "2025-08-01")

    first = exporter.maybe_export_season_recaps(conn, today="2026-01-01")
    assert first == [2025]

    path = tmp_path / "history" / "2025" / "recap.json"
    original_content = path.read_text(encoding="utf-8")

    # Une nouvelle représentation est ajoutée après coup (ex: correction) ;
    # le recap final déjà généré ne doit PAS être silencieusement mis à jour.
    _add_day(conn, "2025-08-02")
    second = exporter.maybe_export_season_recaps(conn, today="2026-01-02")

    assert second == []
    assert path.read_text(encoding="utf-8") == original_content


def test_maybe_export_season_recaps_updates_in_progress_recap_once_per_month(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")
    _add_day(conn, "2026-08-01")

    first = exporter.maybe_export_season_recaps(conn, today="2026-08-15")
    assert first == [2026]

    # Même mois : pas de régénération, même avec de nouvelles données.
    _add_day(conn, "2026-08-16")
    second = exporter.maybe_export_season_recaps(conn, today="2026-08-20")
    assert second == []

    # Nouveau mois calendaire : régénération, avec un as_of_date à jour.
    third = exporter.maybe_export_season_recaps(conn, today="2026-09-01")
    assert third == [2026]
    recap = json.loads((tmp_path / "history" / "2026" / "recap.json").read_text(encoding="utf-8"))
    assert recap["final"] is False
    assert recap["as_of_date"] == "2026-09-01"
