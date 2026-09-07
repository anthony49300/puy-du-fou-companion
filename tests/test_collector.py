"""Tests du module src.collector (orchestration collecte -> base).

Utilise un SourceAdapter factice (pas de vrai réseau) pour rester rapide et
déterministe.
"""
from datetime import date, timedelta

import pytest

from src import config, database, season_config
from src.collector import Collector, FetchResult, SourceAdapter
from tests.fixtures import SAMPLE_SCHEDULE_HTML, build_schedule_html


@pytest.fixture(autouse=True)
def _isolate_seasons_config(tmp_path, monkeypatch):
    # Isole ces tests du vrai data/seasons.json (dont le contenu réel
    # changera une fois des dates de saison renseignées) : sans ça, la
    # synchronisation automatique dans Collector.collect() pourrait
    # écraser les dates posées directement en base par ces tests.
    monkeypatch.setattr(config, "SEASONS_CONFIG_PATH", tmp_path / "seasons-unused.json")
    season_config.clear_cache()
    yield
    season_config.clear_cache()


class _FailIfCalledAdapter(SourceAdapter):
    """Adapter qui échoue le test si `fetch` est appelé : utilisé pour
    prouver qu'un cas (ex: hors saison) court-circuite bien la récupération
    réseau plutôt que de simplement échouer après coup."""

    source_url = "https://example.test/should-not-be-called"

    def fetch(self, target_date):
        pytest.fail("fetch() n'aurait pas dû être appelé (devrait être court-circuité).")


@pytest.fixture()
def db_path(tmp_path):
    return tmp_path / "test.db"


def test_collect_skips_network_when_outside_known_season(db_path):
    with database.connect(db_path) as conn:
        database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")

    outcome = Collector(adapter=_FailIfCalledAdapter(), db_path=db_path).collect(date(2026, 12, 25))

    assert outcome.status == config.DATE_STATUS_OUT_OF_SEASON
    assert outcome.date_str == "2026-12-25"
    assert "hors saison" in outcome.message.lower() or "2026-04-11" in outcome.message


def test_collect_attempts_network_when_inside_known_season(db_path):
    class _FakeAdapter(SourceAdapter):
        source_url = "https://example.test/fake"
        called = False

        def fetch(self, target_date):
            _FakeAdapter.called = True
            raise RuntimeError("réseau volontairement en échec pour ce test")

    with database.connect(db_path) as conn:
        database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")

    Collector(adapter=_FakeAdapter(), db_path=db_path).collect(date(2026, 8, 27))

    assert _FakeAdapter.called is True


def test_collect_attempts_network_when_season_dates_unknown(db_path):
    """Aucune date de saison renseignée -> comportement inchangé (on tente
    quand même la collecte, pas de régression pour les saisons sans dates
    configurées)."""
    class _FakeAdapter(SourceAdapter):
        source_url = "https://example.test/fake"
        called = False

        def fetch(self, target_date):
            _FakeAdapter.called = True
            raise RuntimeError("réseau volontairement en échec pour ce test")

    Collector(adapter=_FakeAdapter(), db_path=db_path).collect(date(2026, 12, 25))

    assert _FakeAdapter.called is True


def test_collect_out_of_season_does_not_create_date_row(db_path):
    with database.connect(db_path) as conn:
        database.set_season_dates(conn, 2026, start_date="2026-04-11", end_date="2026-11-08")

    Collector(adapter=_FailIfCalledAdapter(), db_path=db_path).collect(date(2026, 12, 25))

    with database.connect(db_path) as conn:
        assert database.get_active_date(conn, "2026-12-25") is None


def test_collect_handles_season_spanning_new_year(db_path):
    """Cas réel : une saison peut chevaucher le nouvel an (ex: 'Noël au Puy
    du Fou' jusqu'en janvier). Une date de janvier doit être reconnue comme
    appartenant à la saison de l'année précédente (recherche par PLAGE de
    dates, pas par année calendaire de la date cible)."""
    with database.connect(db_path) as conn:
        database.set_season_dates(conn, 2026, start_date="2026-04-04", end_date="2027-01-03")

    class _FakeAdapter(SourceAdapter):
        source_url = "https://example.test/fake"
        called = False

        def fetch(self, target_date):
            _FakeAdapter.called = True
            raise RuntimeError("réseau volontairement en échec pour ce test")

    # 2027-01-02 est dans la saison 2026 (se termine le 2027-01-03) :
    # la collecte doit être tentée normalement, pas court-circuitée.
    Collector(adapter=_FakeAdapter(), db_path=db_path).collect(date(2027, 1, 2))
    assert _FakeAdapter.called is True

    # 2027-01-10 est réellement hors saison : doit être court-circuité.
    outcome = Collector(adapter=_FailIfCalledAdapter(), db_path=db_path).collect(date(2027, 1, 10))
    assert outcome.status == config.DATE_STATUS_OUT_OF_SEASON


def test_collect_html_source_writes_representations_from_embedded_json(db_path):
    """Intégration bout-en-bout de la source par défaut (page "programme du
    jour" -> schedule_json_parser -> base), sans passer par pdf_parser."""

    class _HtmlAdapter(SourceAdapter):
        source_url = "https://example.test/programme-du-jour"

        def fetch(self, target_date):
            return FetchResult(
                content=SAMPLE_SCHEDULE_HTML.encode("utf-8"),
                content_type="html",
                source_url=self.source_url,
            )

    outcome = Collector(adapter=_HtmlAdapter(), db_path=db_path).collect(date(2026, 8, 26))

    assert outcome.status == config.DATE_STATUS_OK
    assert outcome.date_str == "2026-08-26"
    assert outcome.representation_count == 4
    with database.connect(db_path) as conn:
        active = database.get_active_date(conn, "2026-08-26")
        assert active is not None
        reps = database.get_representations_for_date_id(conn, active["id"])
        assert len(reps) == 4


def test_collect_records_closed_day_instead_of_error(db_path):
    """Un jour fermé (dans dates_open mais sans aucune représentation, voir
    schedule_json_parser) doit être enregistré avec le statut dédié
    DATE_STATUS_CLOSED_DAY, PAS traité comme une erreur/anomalie."""

    class _HtmlAdapter(SourceAdapter):
        source_url = "https://example.test/programme-du-jour"

        def fetch(self, target_date):
            return FetchResult(
                content=SAMPLE_SCHEDULE_HTML.encode("utf-8"),
                content_type="html",
                source_url=self.source_url,
            )

    outcome = Collector(adapter=_HtmlAdapter(), db_path=db_path).collect(date(2026, 8, 28))

    assert outcome.status == config.DATE_STATUS_CLOSED_DAY
    assert outcome.date_str == "2026-08-28"
    assert outcome.representation_count == 0
    with database.connect(db_path) as conn:
        active = database.get_active_date(conn, "2026-08-28")
        assert active is not None
        assert active["status"] == config.DATE_STATUS_CLOSED_DAY


def test_collect_records_closed_day_when_dates_open_entirely_empty_for_today(db_path):
    """Constaté en pratique (fermeture du 07/09/2026) : le widget peut ne
    lister ABSOLUMENT aucune date ouverte plutôt que de lister le jour avec
    des événements vides. Collector.collect() doit transmettre "c'est bien
    la date du jour" à schedule_json_parser pour que ce cas soit interprété
    comme une fermeture (voir is_today)."""
    empty_html = build_schedule_html({"dates_open": [], "events": {}, "sections": {}})

    class _HtmlAdapter(SourceAdapter):
        source_url = "https://example.test/programme-du-jour"

        def fetch(self, target_date):
            return FetchResult(content=empty_html.encode("utf-8"), content_type="html", source_url=self.source_url)

    outcome = Collector(adapter=_HtmlAdapter(), db_path=db_path).collect()  # target_date=None -> aujourd'hui

    assert outcome.status == config.DATE_STATUS_CLOSED_DAY


def test_collect_transitions_from_partial_to_closed_day_despite_identical_zero_rep_hash(db_path):
    """Régression : "0 représentation, pas encore publié" (partial) et "0
    représentation, confirmé fermé" (closed_day) ont le MÊME hash de
    contenu (calculé sur les représentations, toujours vides dans les deux
    cas) — un changement de STATUT seul doit quand même être enregistré,
    sinon la transition partial -> closed_day ne serait jamais persistée
    une fois le parc réellement confirmé fermé."""
    not_open_yet_html = build_schedule_html({"dates_open": ["2099-01-01"], "events": {}, "sections": {}})
    confirmed_closed_html = build_schedule_html({"dates_open": [], "events": {}, "sections": {}})

    class _HtmlAdapter(SourceAdapter):
        source_url = "https://example.test/programme-du-jour"

        def __init__(self):
            self.calls = 0

        def fetch(self, target_date):
            self.calls += 1
            html = not_open_yet_html if self.calls == 1 else confirmed_closed_html
            return FetchResult(content=html.encode("utf-8"), content_type="html", source_url=self.source_url)

    collector = Collector(adapter=_HtmlAdapter(), db_path=db_path)

    first = collector.collect()  # aujourd'hui, pas encore publié
    assert first.status == config.DATE_STATUS_PARTIAL

    second = collector.collect()  # aujourd'hui, cette fois confirmé fermé
    assert second.status == config.DATE_STATUS_CLOSED_DAY

    with database.connect(db_path) as conn:
        active = database.get_active_date(conn, first.date_str)
        assert active["status"] == config.DATE_STATUS_CLOSED_DAY


def test_collect_dates_open_entirely_empty_for_a_future_date_is_not_closed(db_path):
    """La même page vide, mais demandée pour une date future explicite (pas
    "aujourd'hui") : ne doit PAS être interprétée comme une fermeture,
    seulement comme "pas encore publié" (partial)."""
    empty_html = build_schedule_html({"dates_open": [], "events": {}, "sections": {}})

    class _HtmlAdapter(SourceAdapter):
        source_url = "https://example.test/programme-du-jour"

        def fetch(self, target_date):
            return FetchResult(content=empty_html.encode("utf-8"), content_type="html", source_url=self.source_url)

    future_date = date.today() + timedelta(days=5)
    outcome = Collector(adapter=_HtmlAdapter(), db_path=db_path).collect(future_date)

    assert outcome.status == config.DATE_STATUS_PARTIAL
