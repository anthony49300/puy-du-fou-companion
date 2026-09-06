"""Tests de src.main (CLI), limités ici à cmd_collect_daily : la logique de
"ne recollecter que ce qui n'est pas déjà connu" est la seule partie de la
CLI avec une branche conditionnelle qui mérite un test dédié (le reste de
main.py est un fin habillage d'affichage autour de fonctions déjà testées
ailleurs : Collector, exporter, statistics).
"""
import json
import types
from datetime import timedelta

import pytest

from src import config, database, main
from src.collector import Collector as RealCollector
from src.collector import SourceAdapter
from src.models import now_iso, today_paris


class _RecordingAdapter(SourceAdapter):
    """N'effectue aucun vrai réseau : enregistre juste quelles dates ont été
    demandées, pour vérifier le comportement de cmd_collect_daily sans
    dépendre du site officiel."""

    source_url = "https://example.test/fake"
    calls = []

    def fetch(self, target_date):
        _RecordingAdapter.calls.append(target_date)
        raise RuntimeError("réseau volontairement en échec : seul l'appel importe pour ce test")


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    _RecordingAdapter.calls = []
    yield


@pytest.fixture()
def fake_collector(monkeypatch):
    """cmd_collect construit Collector()/PuyDuFouSourceAdapter() lui-même
    (pas d'injection de dépendance côté CLI) : on remplace src.main.Collector
    par une factory qui utilise toujours _RecordingAdapter, quel que soit
    l'adapter (today/tomorrow/après-demain) normalement choisi par cmd_collect."""
    def _factory(adapter=None):
        return RealCollector(adapter=_RecordingAdapter())

    monkeypatch.setattr(main, "Collector", _factory)
    return _RecordingAdapter


def _seed_date(conn, date_str, *, status=config.DATE_STATUS_OK):
    season_id = database.get_or_create_season(conn, int(date_str[:4]))
    date_id, _ = database.create_date_version(
        conn, date_str=date_str, season_id=season_id, source_url="https://example.test",
        source_file=None, source_hash=f"h-{date_str}", retrieved_at=now_iso(),
        program_published_at=None, status=status,
    )
    return date_id


TODAY = today_paris()  # même horloge que le code testé (voir src.models.today_paris)
TOMORROW = TODAY + timedelta(days=1)
DAY_AFTER_TOMORROW = TODAY + timedelta(days=2)


def test_collect_daily_skips_today_when_already_known(fake_collector):
    with database.connect() as conn:
        _seed_date(conn, TODAY.isoformat())

    main.cmd_collect_daily(None)

    # "Aujourd'hui" est sauté car déjà connu ; "demain" et "après-demain"
    # sont inconnus (cas normal en régime stable naissant).
    assert fake_collector.calls == [TOMORROW, DAY_AFTER_TOMORROW]


def test_collect_daily_catches_up_today_when_unknown(fake_collector):
    main.cmd_collect_daily(None)

    # Trois tentatives : le rattrapage d'aujourd'hui, puis demain, puis
    # après-demain (rien n'est encore connu).
    assert fake_collector.calls == [TODAY, TOMORROW, DAY_AFTER_TOMORROW]


def test_collect_daily_no_network_call_when_all_three_already_known(fake_collector):
    """Cas normal en pratique (run de filet de sécurité le matin, alors que
    les runs précédents ont déjà tout collecté) : aucun appel réseau, donc
    aucune consommation inutile du proxy résidentiel."""
    with database.connect() as conn:
        _seed_date(conn, TODAY.isoformat())
        _seed_date(conn, TOMORROW.isoformat())
        _seed_date(conn, DAY_AFTER_TOMORROW.isoformat())

    rc = main.cmd_collect_daily(None)

    assert fake_collector.calls == []
    assert rc == 0


def test_collect_daily_skips_tomorrow_when_already_known(fake_collector):
    with database.connect() as conn:
        _seed_date(conn, TOMORROW.isoformat())

    main.cmd_collect_daily(None)

    # "Demain" est sauté ; "aujourd'hui" (rattrapage) et "après-demain"
    # restent à collecter.
    assert fake_collector.calls == [TODAY, DAY_AFTER_TOMORROW]


def test_collect_daily_only_fetches_day_after_tomorrow_in_steady_state(fake_collector):
    """Régime stable : aujourd'hui et demain ont déjà été collectés par les
    runs précédents (chaque jour est connu un jour à l'avance), seul le
    nouveau jour de la fenêtre ("après-demain") nécessite une vraie
    collecte chaque matin."""
    with database.connect() as conn:
        _seed_date(conn, TODAY.isoformat())
        _seed_date(conn, TOMORROW.isoformat())

    rc = main.cmd_collect_daily(None)

    assert fake_collector.calls == [DAY_AFTER_TOMORROW]
    assert rc == 1  # _RecordingAdapter échoue toujours volontairement


def test_collect_daily_skips_day_after_tomorrow_when_already_known(fake_collector):
    with database.connect() as conn:
        _seed_date(conn, DAY_AFTER_TOMORROW.isoformat())

    main.cmd_collect_daily(None)

    # "Après-demain" est sauté ; "aujourd'hui" et "demain" restent à collecter.
    assert fake_collector.calls == [TODAY, TOMORROW]


def test_collect_daily_retries_a_day_still_stuck_on_partial(fake_collector):
    # Régression : un jour "partial" (rien publié pour l'instant côté site,
    # 0 représentation) ne doit PAS compter comme "déjà connu" — sinon il
    # reste bloqué sur ce statut provisoire pour toujours, même une fois le
    # vrai programme publié (voir _is_resolved).
    with database.connect() as conn:
        _seed_date(conn, TOMORROW.isoformat(), status=config.DATE_STATUS_PARTIAL)

    main.cmd_collect_daily(None)

    assert fake_collector.calls == [TODAY, TOMORROW, DAY_AFTER_TOMORROW]


def test_collect_daily_retries_a_day_stuck_on_error(fake_collector):
    with database.connect() as conn:
        _seed_date(conn, TODAY.isoformat(), status=config.DATE_STATUS_ERROR)

    main.cmd_collect_daily(None)

    assert fake_collector.calls == [TODAY, TOMORROW, DAY_AFTER_TOMORROW]


def test_collect_daily_still_skips_a_day_resolved_as_closed(fake_collector):
    # Un jour "closed_day" EST un résultat définitif (fermeture confirmée) :
    # il doit rester sauté, contrairement à "partial"/"error".
    with database.connect() as conn:
        _seed_date(conn, TOMORROW.isoformat(), status=config.DATE_STATUS_CLOSED_DAY)

    main.cmd_collect_daily(None)

    assert fake_collector.calls == [TODAY, DAY_AFTER_TOMORROW]


YESTERDAY = TODAY - timedelta(days=1)


def test_promote_unresolved_past_days_marks_a_never_published_past_date_as_closed(fake_collector):
    with database.connect() as conn:
        _seed_date(conn, YESTERDAY.isoformat(), status=config.DATE_STATUS_PARTIAL)

    main.cmd_collect_daily(None)

    with database.connect() as conn:
        row = database.get_active_date(conn, YESTERDAY.isoformat())
    assert row["status"] == config.DATE_STATUS_CLOSED_DAY


def test_promote_unresolved_past_days_never_touches_a_future_or_present_date(fake_collector):
    # "partial" pour aujourd'hui/demain/après-demain doit rester tel quel
    # (encore dans la fenêtre de collecte, sera retenté au run suivant) —
    # seul le PASSÉ ne changera plus jamais.
    with database.connect() as conn:
        _seed_date(conn, TODAY.isoformat(), status=config.DATE_STATUS_PARTIAL)

    main.cmd_collect_daily(None)

    with database.connect() as conn:
        row = database.get_active_date(conn, TODAY.isoformat())
    assert row["status"] == config.DATE_STATUS_PARTIAL


def test_promote_unresolved_past_days_never_overwrites_real_representations(fake_collector):
    # Un statut "partial" peut aussi signifier "quelques représentations
    # trouvées, mais avec un avertissement" (ex: spectacle non reconnu) —
    # il ne faut surtout pas écraser ce cas en "fermé".
    with database.connect() as conn:
        date_id = _seed_date(conn, YESTERDAY.isoformat(), status=config.DATE_STATUS_PARTIAL)
        spectacle_id = database.get_or_create_spectacle(conn, name="Les Vikings", slug="les-vikings", category="spectacle")
        database.insert_representation(
            conn, date_id=date_id, spectacle_id=spectacle_id, start_time="11:30", end_time=None,
            is_continuous=False, status=config.REPR_STATUS_SCHEDULED, source_text="11:30 Les Vikings",
        )

    main.cmd_collect_daily(None)

    with database.connect() as conn:
        row = database.get_active_date(conn, YESTERDAY.isoformat())
    assert row["status"] == config.DATE_STATUS_PARTIAL  # inchangé


def test_season_recap_command_does_not_freeze_an_in_progress_season_as_final(tmp_path, monkeypatch):
    # Régression : une régénération manuelle ne doit pas figer "final" une
    # saison encore en cours (sinon plus jamais retouchée ensuite par la
    # mise à jour mensuelle automatique — voir maybe_export_season_recaps).
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    with database.connect() as conn:
        database.set_season_dates(conn, TODAY.year, start_date=(TODAY - timedelta(days=30)).isoformat(), end_date=(TODAY + timedelta(days=30)).isoformat())

    rc = main.cmd_season_recap(types.SimpleNamespace(year=TODAY.year))

    assert rc == 0
    payload = json.loads((tmp_path / "history" / str(TODAY.year) / "recap.json").read_text(encoding="utf-8"))
    assert payload["final"] is False
    assert payload["as_of_date"] == TODAY.isoformat()


def test_season_recap_command_marks_a_finished_season_as_final(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    with database.connect() as conn:
        database.set_season_dates(conn, TODAY.year, start_date=(TODAY - timedelta(days=60)).isoformat(), end_date=(TODAY - timedelta(days=1)).isoformat())

    rc = main.cmd_season_recap(types.SimpleNamespace(year=TODAY.year))

    assert rc == 0
    payload = json.loads((tmp_path / "history" / str(TODAY.year) / "recap.json").read_text(encoding="utf-8"))
    assert payload["final"] is True


def test_season_recap_command_unknown_year_returns_error(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")
    rc = main.cmd_season_recap(types.SimpleNamespace(year=1999))
    assert rc == 1
