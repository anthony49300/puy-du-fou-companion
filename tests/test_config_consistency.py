from src import config, config_consistency, normalizer, planned_closures, season_config


def test_check_all_against_real_data_files_is_clean():
    """Garde-fou qui tourne à chaque lancement de la suite de tests : si une
    future modification de data/seasons.json, data/known_spectacles.json ou
    data/planned_closures.json introduit une incohérence ENTRE ces fichiers,
    ce test échoue immédiatement plutôt que de fausser silencieusement les
    statistiques (voir les 3 bugs rencontrés cette session sur leurs
    interactions)."""
    season_config.clear_cache()
    normalizer.clear_cache()
    planned_closures.clear_cache()
    assert config_consistency.check_all() == []


def _with_seasons(monkeypatch, tmp_path, seasons):
    import json

    path = tmp_path / "seasons.json"
    path.write_text(json.dumps(seasons), encoding="utf-8")
    monkeypatch.setattr(config, "SEASONS_CONFIG_PATH", path)
    season_config.clear_cache()


def _with_known_spectacles(monkeypatch, tmp_path, spectacles):
    import json

    path = tmp_path / "known_spectacles.json"
    path.write_text(json.dumps(spectacles), encoding="utf-8")
    monkeypatch.setattr(config, "KNOWN_SPECTACLES_PATH", path)
    normalizer.clear_cache()


def _with_planned_closures(monkeypatch, tmp_path, closures):
    import json

    path = tmp_path / "planned_closures.json"
    path.write_text(json.dumps(closures), encoding="utf-8")
    monkeypatch.setattr(config, "PLANNED_CLOSURES_PATH", path)
    planned_closures.clear_cache()


def test_check_season_ranges_detects_an_inverted_season(monkeypatch, tmp_path):
    _with_seasons(monkeypatch, tmp_path, {"2026": {"start_date": "2026-11-01", "end_date": "2026-04-04"}})
    problems = config_consistency.check_season_ranges()
    assert len(problems) == 1
    assert "2026" in problems[0]


def test_check_active_periods_detects_an_inverted_period(monkeypatch, tmp_path):
    _with_seasons(monkeypatch, tmp_path, {})
    _with_known_spectacles(monkeypatch, tmp_path, {
        "les-vikings": {
            "name": "Les Vikings",
            "category": "spectacle",
            "aliases": ["Les Vikings"],
            "active_periods": [{"from": "2026-11-01", "to": "2026-04-04"}],
        }
    })
    problems = config_consistency.check_active_periods()
    assert len(problems) == 1
    assert "les-vikings" in problems[0]


def test_check_active_periods_detects_a_period_outside_any_known_season(monkeypatch, tmp_path):
    _with_seasons(monkeypatch, tmp_path, {"2026": {"start_date": "2026-04-04", "end_date": "2026-11-01"}})
    _with_known_spectacles(monkeypatch, tmp_path, {
        "le-carillon-de-noel": {
            "name": "Le Carillon de Noël",
            "category": "spectacle",
            "aliases": ["Le Carillon de Noël"],
            "active_periods": [{"from": "2026-12-18", "to": "2027-01-03"}],
        }
    })
    problems = config_consistency.check_active_periods()
    assert len(problems) == 1
    assert "le-carillon-de-noel" in problems[0]


def test_check_active_periods_detects_overlapping_periods(monkeypatch, tmp_path):
    _with_seasons(monkeypatch, tmp_path, {})
    _with_known_spectacles(monkeypatch, tmp_path, {
        "les-vikings": {
            "name": "Les Vikings",
            "category": "spectacle",
            "aliases": ["Les Vikings"],
            "active_periods": [
                {"from": "2026-04-04", "to": "2026-08-01"},
                {"from": "2026-07-01", "to": "2026-11-01"},
            ],
        }
    })
    problems = config_consistency.check_active_periods()
    assert len(problems) == 1
    assert "se chevauchent" in problems[0]


def test_check_planned_closures_detects_a_gap_outside_any_known_season(monkeypatch, tmp_path):
    _with_seasons(monkeypatch, tmp_path, {"2026": {"start_date": "2026-04-04", "end_date": "2026-11-01"}})
    _with_planned_closures(monkeypatch, tmp_path, {"2026": [{"from": "2026-11-02", "to": "2026-12-17"}]})
    problems = config_consistency.check_planned_closures()
    assert len(problems) == 1
    assert "2026" in problems[0]


def test_check_all_is_clean_when_everything_fits(monkeypatch, tmp_path):
    _with_seasons(monkeypatch, tmp_path, {"2026": {"start_date": "2026-04-04", "end_date": "2027-01-03"}})
    _with_known_spectacles(monkeypatch, tmp_path, {
        "les-vikings": {
            "name": "Les Vikings",
            "category": "spectacle",
            "aliases": ["Les Vikings"],
            "active_periods": [{"from": "2026-04-04", "to": "2026-11-01"}],
        }
    })
    _with_planned_closures(monkeypatch, tmp_path, {"2026": [{"from": "2026-11-02", "to": "2026-12-17"}]})
    assert config_consistency.check_all() == []
