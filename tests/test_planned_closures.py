"""Tests du module src.planned_closures (data/planned_closures.json éditable
à la main, même principe que data/seasons.json / src/season_config.py)."""
import json

import pytest

from src import config, planned_closures


@pytest.fixture(autouse=True)
def _clear_cache():
    planned_closures.clear_cache()
    yield
    planned_closures.clear_cache()


def _write_config(tmp_path, monkeypatch, data):
    path = tmp_path / "planned-closures.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "PLANNED_CLOSURES_PATH", path)
    planned_closures.clear_cache()
    return path


def test_is_in_planned_gap_missing_file_returns_false(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PLANNED_CLOSURES_PATH", tmp_path / "does-not-exist.json")
    assert planned_closures.is_in_planned_gap("2026-11-07") is False


def test_is_in_planned_gap_date_inside_range(tmp_path, monkeypatch):
    _write_config(tmp_path, monkeypatch, {"2026": [{"from": "2026-11-02", "to": "2026-12-17"}]})
    assert planned_closures.is_in_planned_gap("2026-11-07") is True
    assert planned_closures.is_in_planned_gap("2026-11-02") is True  # borne incluse
    assert planned_closures.is_in_planned_gap("2026-12-17") is True  # borne incluse


def test_is_in_planned_gap_date_outside_range(tmp_path, monkeypatch):
    _write_config(tmp_path, monkeypatch, {"2026": [{"from": "2026-11-02", "to": "2026-12-17"}]})
    assert planned_closures.is_in_planned_gap("2026-11-01") is False
    assert planned_closures.is_in_planned_gap("2026-12-18") is False


def test_is_in_planned_gap_checks_every_year_key(tmp_path, monkeypatch):
    # La clé n'a pas besoin de correspondre à l'année calendaire de la
    # plage (même principe que data/seasons.json) : toutes les plages de
    # toutes les années sont vérifiées, pas seulement celle qui "matche"
    # l'année de la date cherchée.
    _write_config(tmp_path, monkeypatch, {"2025": [{"from": "2025-11-01", "to": "2025-12-15"}]})
    assert planned_closures.is_in_planned_gap("2025-11-20") is True


def test_is_in_planned_gap_multiple_ranges_same_year(tmp_path, monkeypatch):
    _write_config(
        tmp_path, monkeypatch,
        {"2026": [{"from": "2026-11-02", "to": "2026-11-05"}, {"from": "2026-11-10", "to": "2026-12-17"}]},
    )
    assert planned_closures.is_in_planned_gap("2026-11-03") is True
    assert planned_closures.is_in_planned_gap("2026-11-20") is True
    assert planned_closures.is_in_planned_gap("2026-11-07") is False  # entre les deux plages
