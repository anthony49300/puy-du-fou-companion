"""Tests du module src.normalizer (slugs, alias, résolution canonique)."""

import json

from src import config, normalizer


def setup_function(_):
    # Le fichier known_spectacles.json réel du dépôt est utilisé (chargé une
    # fois et mis en cache) : on vide le cache entre les tests par précaution
    # si un test venait à le modifier.
    normalizer.clear_cache()


def test_slugify_basic():
    assert normalizer.slugify("Les Vikings") == "les-vikings"


def test_slugify_strips_accents_and_punctuation():
    assert normalizer.slugify("Le Mime et l'Étoile") == "le-mime-et-l-etoile"


def test_case_variants_resolve_to_same_spectacle():
    variants = ["Les Vikings", "Les vikings", "LES VIKINGS", "Vikings"]
    resolved = [normalizer.resolve_spectacle(v) for v in variants]
    slugs = {r.slug for r in resolved}
    names = {r.name for r in resolved}
    assert slugs == {"les-vikings"}
    assert names == {"Les Vikings"}


def test_resolve_known_spectacle_returns_configured_category():
    info = normalizer.resolve_spectacle("les vikings")
    assert info.category == "spectacle"
    assert info.known is True


def test_resolve_unknown_spectacle_is_kept_with_default_category():
    info = normalizer.resolve_spectacle("Un Nouveau Spectacle Jamais Vu")
    assert info.known is False
    assert info.category == "autre"
    assert info.slug == "un-nouveau-spectacle-jamais-vu"
    # Le nom n'est jamais supprimé/vidé même si inconnu de la configuration.
    assert info.name


def test_resolve_is_insensitive_to_extra_whitespace():
    info1 = normalizer.resolve_spectacle("Les   Vikings")
    info2 = normalizer.resolve_spectacle("Les Vikings")
    assert info1.slug == info2.slug


def test_normalize_search_text_used_for_fuzzy_search():
    # "Vikings" doit permettre de retrouver "Les Vikings" côté frontend ;
    # ici on vérifie juste la normalisation qui rend cela possible.
    assert normalizer.normalize_search_text("Vikings") in normalizer.normalize_search_text("Les Vikings")
    assert normalizer.normalize_search_text("ÉTOILE") == "etoile"


def test_get_active_periods_empty_for_a_permanent_spectacle():
    assert normalizer.get_active_periods("les-vikings") == []


def test_get_active_periods_reads_configured_ranges(tmp_path, monkeypatch):
    path = tmp_path / "known.json"
    path.write_text(json.dumps({
        "la-toussaint-fantastique": {
            "name": "La Toussaint Fantastique",
            "category": "spectacle",
            "aliases": [],
            "active_periods": [{"from": "2026-10-17", "to": "2026-11-02"}],
        }
    }), encoding="utf-8")
    monkeypatch.setattr(config, "KNOWN_SPECTACLES_PATH", path)
    normalizer.clear_cache()

    assert normalizer.get_active_periods("la-toussaint-fantastique") == [("2026-10-17", "2026-11-02")]
