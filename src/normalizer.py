"""Normalisation des noms de spectacles.

Objectif : "Les Vikings", "Les vikings" et "LES VIKINGS" doivent toujours
résoudre vers le même spectacle (même slug, même nom canonique, même
catégorie), à partir du fichier de configuration `data/known_spectacles.json`
(voir ce fichier pour la structure et pour ajouter de nouveaux alias sans
toucher au code Python).

Un spectacle rencontré dans un programme officiel mais absent de la
configuration n'est PAS rejeté : il est conservé avec la catégorie par
défaut ("autre") et un slug généré automatiquement, afin de ne jamais
perdre de données réelles issues de la source officielle.
"""
from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple, Optional

from src import config


class SpectacleInfo(NamedTuple):
    name: str
    slug: str
    category: str
    known: bool  # True si trouvé dans known_spectacles.json


def strip_accents(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def slugify(text: str) -> str:
    """Transforme un nom en slug ASCII minuscule séparé par des tirets.

    "Les Vikings" -> "les-vikings"
    "Le Mime et l'Étoile" -> "le-mime-et-l-etoile"
    """
    text = strip_accents(text).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def normalize_search_text(text: str) -> str:
    """Normalisation utilisée pour la recherche insensible aux accents/casse."""
    return strip_accents(text).lower().strip()


@lru_cache(maxsize=1)
def _load_known_spectacles(path: Optional[str] = None) -> dict:
    known_path = Path(path) if path else config.KNOWN_SPECTACLES_PATH
    if not known_path.exists():
        return {}
    with open(known_path, encoding="utf-8") as f:
        data = json.load(f)
    data.pop("_comment", None)
    return data


@lru_cache(maxsize=1)
def _build_alias_index() -> dict[str, str]:
    """Construit un index {alias_normalisé: slug_canonique}."""
    known = _load_known_spectacles()
    index: dict[str, str] = {}
    for slug, info in known.items():
        aliases = list(info.get("aliases", [])) + [info.get("name", "")]
        for alias in aliases:
            if alias:
                index[normalize_search_text(alias)] = slug
    return index


def clear_cache() -> None:
    """Utile pour les tests qui modifient known_spectacles.json à la volée."""
    _load_known_spectacles.cache_clear()
    _build_alias_index.cache_clear()


def resolve_spectacle(raw_name: str) -> SpectacleInfo:
    """Résout un nom brut extrait du PDF vers un SpectacleInfo canonique."""
    cleaned = re.sub(r"\s+", " ", raw_name).strip()
    key = normalize_search_text(cleaned)

    alias_index = _build_alias_index()
    known = _load_known_spectacles()

    slug = alias_index.get(key)
    if slug and slug in known:
        info = known[slug]
        return SpectacleInfo(
            name=info["name"],
            slug=slug,
            category=info.get("category", config.DEFAULT_CATEGORY),
            known=True,
        )

    # Spectacle inconnu de la configuration : on le conserve quand même,
    # avec un nom nettoyé (casse "Title Case" légère) et un slug généré.
    fallback_name = _title_case_fr(cleaned)
    return SpectacleInfo(
        name=fallback_name,
        slug=slugify(fallback_name),
        category=config.DEFAULT_CATEGORY,
        known=False,
    )


def _title_case_fr(text: str) -> str:
    """Met en majuscule la première lettre de chaque mot significatif,
    sans toucher aux petits mots (de, la, le, et, du, des, l', ...), pour
    éviter de casser des noms déjà correctement formatés tout en corrigeant
    les noms tout en majuscules ou tout en minuscules.
    """
    small_words = {"de", "la", "le", "et", "du", "des", "les", "l", "un", "une", "à", "au", "aux"}
    words = text.split(" ")
    result = []
    for i, word in enumerate(words):
        core = word
        apostrophe_prefix = ""
        if "'" in word:
            prefix, _, rest = word.partition("'")
            if prefix.lower() in small_words:
                apostrophe_prefix = prefix.lower() + "'"
                core = rest
        lower = core.lower()
        if i > 0 and lower in small_words:
            result.append(apostrophe_prefix + lower)
        else:
            result.append(apostrophe_prefix + (lower[:1].upper() + lower[1:] if lower else lower))
    return " ".join(result)
