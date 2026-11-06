"""Vérifie la cohérence ENTRE les trois fichiers de config manuels qui se
recoupent : `data/seasons.json` (dates d'ouverture/fermeture), `data/
known_spectacles.json` (`active_periods`, les plages où un spectacle
éphémère est réellement programmé) et `data/planned_closures.json` (les
creux planifiés à l'intérieur d'une saison). Aucun des trois modules
(`season_config`, `normalizer`, `planned_closures`) ne connaît les deux
autres — chacun valide son propre fichier isolément au mieux — alors que
plusieurs bugs réels de la saison 2026 venaient justement d'une
incohérence ENTRE eux (une période définie pour une seule année qui videait
l'historique des autres, des dates de reprise de Noël qui ne
correspondaient plus entre les deux fichiers...).

Usage : `check_all()` retourne la liste des problèmes trouvés (vide si
tout va bien). Utilisé par `tests/test_config_consistency.py`, qui
l'exécute contre les VRAIS fichiers `data/` à chaque lancement de la suite
de tests — donc aussi à chaque collecte automatique (voir
.github/workflows/update-programme.yml) — pour attraper une erreur de
saisie avant qu'elle ne fausse silencieusement les statistiques.
"""
from __future__ import annotations

from src import normalizer, planned_closures, season_config


def _season_windows() -> list[tuple[str, str]]:
    """Plages (start_date, end_date) de toutes les saisons dont les DEUX
    dates sont renseignées dans data/seasons.json (une saison encore à
    None ne contraint rien, comme ailleurs dans le projet)."""
    windows = []
    for year in season_config.configured_years():
        start, end = season_config.get_configured_dates(year)
        if start and end:
            windows.append((start, end))
    return windows


def _within_any_season(start: str, end: str, windows: list[tuple[str, str]]) -> bool:
    return any(w_start <= start and end <= w_end for w_start, w_end in windows)


def _check_overlaps(periods: list[tuple[str, str]], label: str) -> list[str]:
    problems = []
    ordered = sorted(periods)
    for (s1, e1), (s2, e2) in zip(ordered, ordered[1:]):
        if s2 <= e1:
            problems.append(f"{label} : deux plages se chevauchent ({s1} → {e1} et {s2} → {e2}).")
    return problems


def check_season_ranges() -> list[str]:
    """data/seasons.json : chaque saison doit avoir start_date <= end_date
    quand les deux sont connues (sinon toute date tomberait "hors saison",
    silencieusement)."""
    problems = []
    for year in season_config.configured_years():
        start, end = season_config.get_configured_dates(year)
        if start and end and start > end:
            problems.append(
                f"seasons.json : la saison {year} a une start_date ({start}) postérieure à sa end_date ({end})."
            )
    return problems


def check_active_periods() -> list[str]:
    """data/known_spectacles.json (active_periods) : chaque plage doit être
    cohérente en elle-même (from <= to), tomber dans une saison CONNUE
    (sinon c'est probablement une année mal tapée — voir data/seasons.json),
    et ne pas se chevaucher avec une autre plage du même spectacle."""
    problems = []
    windows = _season_windows()
    for slug, periods in normalizer.all_active_periods().items():
        for start, end in periods:
            if start > end:
                problems.append(
                    f"known_spectacles.json : {slug} a une active_period inversée ({start} → {end})."
                )
                continue
            if windows and not _within_any_season(start, end, windows):
                problems.append(
                    f"known_spectacles.json : {slug} a une active_period ({start} → {end}) qui ne tombe "
                    "dans aucune saison connue (vérifiez data/seasons.json)."
                )
        problems += [
            f"known_spectacles.json : {slug} — {p}" for p in _check_overlaps(periods, "active_periods")
        ]
    return problems


def check_planned_closures() -> list[str]:
    """data/planned_closures.json : mêmes vérifications que ci-dessus (plage
    cohérente, dans une saison connue, pas de chevauchement) — un creux
    hors de toute saison n'a pas de sens (cette date serait de toute façon
    déjà "hors saison" sans qu'on ait besoin de le préciser)."""
    problems = []
    windows = _season_windows()
    for year_key, ranges in planned_closures.all_gaps().items():
        for start, end in ranges:
            if start > end:
                problems.append(
                    f"planned_closures.json : la plage {year_key} ({start} → {end}) est inversée."
                )
                continue
            if windows and not _within_any_season(start, end, windows):
                problems.append(
                    f"planned_closures.json : la plage {year_key} ({start} → {end}) ne tombe dans aucune "
                    "saison connue (vérifiez data/seasons.json)."
                )
        problems += [
            f"planned_closures.json : année {year_key} — {p}" for p in _check_overlaps(ranges, "planned_closures")
        ]
    return problems


def check_all() -> list[str]:
    """Tous les contrôles — liste vide si tout est cohérent."""
    return check_season_ranges() + check_active_periods() + check_planned_closures()
