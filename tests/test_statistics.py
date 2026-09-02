"""Tests de src.statistics (statistiques globales/avancées) et smoke-test
de src.exporter (validité des JSON générés pour le frontend)."""

import json

import pytest

from src import config, database, exporter, season_config, statistics
from src.models import now_iso


@pytest.fixture(autouse=True)
def _isolate_seasons_config(tmp_path, monkeypatch):
    # Isole ces tests du vrai data/seasons.json (dont le contenu réel
    # change une fois des dates de saison renseignées) : sans ça, les
    # tests d'export ici deviennent instables au grès du contenu réel du
    # fichier (voir tests/test_exporter.py pour la même précaution).
    monkeypatch.setattr(config, "SEASONS_CONFIG_PATH", tmp_path / "seasons-unused.json")
    season_config.clear_cache()
    yield
    season_config.clear_cache()


@pytest.fixture()
def conn(tmp_path):
    db_path = tmp_path / "test.db"
    connection = database.get_connection(db_path)
    database.init_db(connection)
    yield connection
    connection.close()


def _add_day(conn, date_str, entries, *, status="ok"):
    """entries: list of (name, slug, category, start, end, is_continuous, rep_status)"""
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
    for name, slug, category, start, end, is_continuous, rep_status in entries:
        spectacle_id = database.get_or_create_spectacle(conn, name=name, slug=slug, category=category)
        database.insert_representation(
            conn, date_id=date_id, spectacle_id=spectacle_id, start_time=start, end_time=end,
            is_continuous=is_continuous, status=rep_status, source_text=f"{start} {name}",
        )
    return date_id


@pytest.fixture()
def sample_conn(conn):
    _add_day(conn, "2026-08-25", [
        ("Les Vikings", "les-vikings", "spectacle", "11:30", None, False, config.REPR_STATUS_SCHEDULED),
        ("Le Dernier Panache", "le-dernier-panache", "spectacle", "10:00", "10:30", False, config.REPR_STATUS_SCHEDULED),
        ("Les Orgues de Feu", "les-orgues-de-feu", "spectacle_nocturne", "22:30", None, False, config.REPR_STATUS_SCHEDULED),
    ])
    _add_day(conn, "2026-08-26", [
        ("Les Vikings", "les-vikings", "spectacle", "11:30", None, False, config.REPR_STATUS_SCHEDULED),
        ("Les Vikings", "les-vikings", "spectacle", "16:00", None, False, config.REPR_STATUS_SCHEDULED),
        ("Le Secret de la Lance", "le-secret-de-la-lance", "spectacle", "14:00", None, False, config.REPR_STATUS_SCHEDULED),
        ("Les Orgues de Feu", "les-orgues-de-feu", "spectacle_nocturne", "22:30", None, False, config.REPR_STATUS_SCHEDULED),
    ])
    return conn


def test_compute_global_stats_totals(sample_conn):
    stats = statistics.compute_global_stats(sample_conn)
    assert stats["total_spectacles"] == 4
    assert stats["total_representations"] == 7
    assert stats["nocturnal_count"] == 2  # les-orgues-de-feu x2 (catégorie nocturne)


def test_compute_global_stats_min_max_per_day(sample_conn):
    stats = statistics.compute_global_stats(sample_conn)
    assert stats["min_per_day"] == {"date": "2026-08-25", "count": 3}
    assert stats["max_per_day"] == {"date": "2026-08-26", "count": 4}


def test_compute_global_stats_most_represented(sample_conn):
    stats = statistics.compute_global_stats(sample_conn)
    top = stats["most_represented"][0]
    assert top["slug"] == "les-vikings"
    assert top["count"] == 3


def test_compute_spectacle_stats_history_covers_all_active_dates(sample_conn):
    stats = statistics.compute_spectacle_stats(sample_conn, "les-vikings")
    assert stats is not None
    assert stats["stats"]["total_representations"] == 3
    assert stats["stats"]["days_present"] == 2
    assert len(stats["history"]) == 2  # une entrée par date active


def test_compute_spectacle_stats_unknown_slug_returns_none(sample_conn):
    assert statistics.compute_spectacle_stats(sample_conn, "spectacle-inexistant") is None


def test_hourly_distribution(sample_conn):
    dist = statistics.hourly_distribution(sample_conn)
    hours = {d["hour"]: d["count"] for d in dist}
    assert hours["11:00"] == 2  # 11h30 x2 jours
    assert hours["22:00"] == 2  # les orgues de feu x2 jours


def test_rarely_programmed(sample_conn):
    rare = statistics.rarely_programmed(sample_conn, max_days_present=1)
    slugs = {r["slug"] for r in rare}
    assert "le-dernier-panache" in slugs
    assert "les-vikings" not in slugs  # présent 2 jours


def test_co_programmed_spectacles(sample_conn):
    co = statistics.co_programmed_spectacles(sample_conn, "les-vikings")
    slugs = {c["slug"] for c in co}
    assert "les-orgues-de-feu" in slugs  # programmé les mêmes jours que Les Vikings


def test_compare_dates_absent_vs_other(sample_conn):
    comparison = statistics.compare_dates(sample_conn, "2026-08-25", "2026-08-26")
    # "date1.missing_here_present_other" = présent le 26 (date2) mais absent le 25 (date1).
    # "Le Dernier Panache" est présent le 25 mais absent le 26 : il doit donc
    # apparaître dans la liste symétrique, celle de date2.
    assert "le-secret-de-la-lance" in comparison["date1"]["missing_here_present_other"]
    assert "le-dernier-panache" in comparison["date2"]["missing_here_present_other"]


def test_find_schedule_conflicts_detects_overlap():
    shows = [
        statistics.ScheduledShow(slug="a", name="A", start="10:00", end="10:30"),
        statistics.ScheduledShow(slug="b", name="B", start="10:15", end="10:45"),
        statistics.ScheduledShow(slug="c", name="C", start="11:00", end="11:30"),
    ]
    conflicts = statistics.find_schedule_conflicts(shows)
    conflicting_slugs = {(c[0].slug, c[1].slug) for c in conflicts}
    assert ("a", "b") in conflicting_slugs
    assert not any("c" in pair for pair in conflicting_slugs)


def test_max_shows_schedulable_picks_non_overlapping_maximum():
    shows = [
        statistics.ScheduledShow(slug="a", name="A", start="10:00", end="10:30"),
        statistics.ScheduledShow(slug="b", name="B", start="10:15", end="10:45"),
        statistics.ScheduledShow(slug="c", name="C", start="10:30", end="11:00"),
    ]
    selected = statistics.max_shows_schedulable(shows)
    # a (10:00-10:30) puis c (10:30-11:00) : 2 spectacles compatibles, mieux que b seul.
    assert [s.slug for s in selected] == ["a", "c"]


# ---------------------------------------------------------------------------
# Smoke-test de l'export JSON (validité + cohérence avec le contrat frontend)
# ---------------------------------------------------------------------------

def test_export_all_produces_valid_json(sample_conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TODAY_JSON", tmp_path / "today.json")
    monkeypatch.setattr(config, "SPECTACLES_JSON", tmp_path / "spectacles.json")
    monkeypatch.setattr(config, "DATES_JSON", tmp_path / "dates.json")
    monkeypatch.setattr(config, "STATS_JSON", tmp_path / "stats.json")
    monkeypatch.setattr(config, "HISTORY_JSON_DIR", tmp_path / "history")

    summary = exporter.export_all(sample_conn, reference_date="2026-08-26")
    assert summary["dates_count"] == 2
    assert summary["history_files"] == 2

    today = json.loads((tmp_path / "today.json").read_text(encoding="utf-8"))
    assert today["date"] == "2026-08-26"
    assert today["status"] in config.DATE_STATUSES
    assert isinstance(today["spectacles"], list)
    assert today["nocturne"] is not None

    spectacles = json.loads((tmp_path / "spectacles.json").read_text(encoding="utf-8"))
    assert set(config.CATEGORIES.keys()) == set(spectacles["categories"])

    dates = json.loads((tmp_path / "dates.json").read_text(encoding="utf-8"))
    assert len(dates["dates"]) == 2

    stats = json.loads((tmp_path / "stats.json").read_text(encoding="utf-8"))
    assert "global" in stats and "charts" in stats and "by_season" in stats


def test_export_today_falls_back_to_latest_when_reference_missing(sample_conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TODAY_JSON", tmp_path / "today.json")
    payload = exporter.export_today(sample_conn, reference_date="2099-01-01")
    assert payload["status"] == config.DATE_STATUS_STALE
    assert payload["date"] == "2026-08-26"  # dernière date active connue
    assert payload["spectacles"]  # jamais vide alors que des données existent
