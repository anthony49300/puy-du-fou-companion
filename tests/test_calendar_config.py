"""Tests de src.calendar_config : lecture de data/calendar.json et
cohérence interne du VRAI fichier (exécuté à chaque pytest, voir
tests/test_config_consistency.py pour le même principe appliqué aux
3 autres fichiers de config qui se recoupent)."""
import datetime
import json

from src import calendar_config, config


def test_missing_file_returns_empty_but_valid_structure(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CALENDAR_CONFIG_PATH", tmp_path / "absent.json")
    calendar_config.clear_cache()
    data = calendar_config.load()
    assert data == {"source": None, "school_holidays": [], "public_holidays": []}
    calendar_config.clear_cache()


def test_load_strips_the_comment_field(tmp_path, monkeypatch):
    path = tmp_path / "calendar.json"
    path.write_text(json.dumps({
        "_comment": "ignored",
        "source": "Test",
        "school_holidays": [{"name": "Test", "start": "2026-01-01", "end": "2026-01-05"}],
        "public_holidays": ["2026-01-01"],
    }), encoding="utf-8")
    monkeypatch.setattr(config, "CALENDAR_CONFIG_PATH", path)
    calendar_config.clear_cache()
    data = calendar_config.load()
    assert "_comment" not in data
    assert data["source"] == "Test"
    calendar_config.clear_cache()


def test_real_calendar_json_school_holidays_are_internally_consistent():
    # Pas de monkeypatch ici : vérifie le VRAI data/calendar.json, pour
    # attraper une faute de frappe de date avant qu'elle ne fausse
    # silencieusement la classification semaine/week-end/vacances.
    calendar_config.clear_cache()
    data = calendar_config.load()
    holidays = data["school_holidays"]
    assert holidays, "data/calendar.json devrait lister au moins une période de vacances"

    parsed = []
    for h in holidays:
        start = datetime.date.fromisoformat(h["start"])
        end = datetime.date.fromisoformat(h["end"])
        assert start <= end, f"{h['name']} : start ({h['start']}) postérieur à end ({h['end']})"
        parsed.append((start, end, h["name"]))

    parsed.sort(key=lambda t: t[0])
    for (start_a, end_a, name_a), (start_b, end_b, name_b) in zip(parsed, parsed[1:]):
        assert end_a < start_b, f"{name_a} ({end_a}) chevauche {name_b} ({start_b})"


def test_real_calendar_json_public_holidays_are_valid_and_unique():
    calendar_config.clear_cache()
    data = calendar_config.load()
    public = data["public_holidays"]
    assert public, "data/calendar.json devrait lister au moins un jour férié"
    assert len(public) == len(set(public)), "jour férié en double"
    for d in public:
        datetime.date.fromisoformat(d)  # lève si le format est invalide
