"""Génération des fichiers JSON consommés par le frontend statique.

Fichiers produits dans data/json/ :
    today.json        -> programme du jour (ou de la dernière date collectée)
    spectacles.json    -> liste des spectacles + historique par spectacle
    dates.json          -> résumé de toutes les dates collectées (calendrier)
    stats.json           -> statistiques globales, par saison, et données de graphiques
    history/{date}.json -> détail complet du programme pour CHAQUE date active
                             (même format que today.json), pour la page Historique.

Tous les fichiers sont écrits en UTF-8, indentés, avec ensure_ascii=False
pour rester lisibles (accents) et faciles à diffuser (diff Git propre).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date as date_cls
from pathlib import Path
from typing import Optional

from src import config, database, season_config, statistics
from src.models import now_iso


# Clés d'horodatage écrites par les fonctions export_* ci-dessous : elles
# changent à CHAQUE appel même quand le contenu réel est identique, ce qui
# ferait sinon apparaître un diff Git (et donc un commit automatique)
# à chaque exécution du workflow, même sans le moindre changement réel.
_VOLATILE_KEYS = {"updated_at", "generated_at"}


def _strip_volatile(value):
    if isinstance(value, dict):
        return {k: _strip_volatile(v) for k, v in value.items() if k not in _VOLATILE_KEYS}
    if isinstance(value, list):
        return [_strip_volatile(v) for v in value]
    return value


def _write_json(path: Path, data: dict) -> None:
    """Écrit `data` en JSON, sauf si le fichier existant a déjà exactement
    le même contenu (horodatages `updated_at`/`generated_at` ignorés dans
    la comparaison) : dans ce cas on ne touche pas au fichier, pour ne pas
    générer de faux changement Git à chaque export alors que rien de réel
    n'a changé.
    """
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = None
        if existing is not None and _strip_volatile(existing) == _strip_volatile(data):
            return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _build_date_payload(conn: sqlite3.Connection, date_row: sqlite3.Row) -> dict:
    """Construit le payload complet (format today.json) pour une version de date donnée."""
    reps = database.get_representations_for_date_id(conn, date_row["id"])
    season = conn.execute("SELECT * FROM seasons WHERE id = ?", (date_row["season_id"],)).fetchone()

    by_spectacle: dict[str, dict] = {}
    for r in reps:
        slug = r["spectacle_slug"]
        entry = by_spectacle.setdefault(
            slug,
            {"name": r["spectacle_name"], "slug": slug, "category": r["spectacle_category"], "representations": []},
        )
        entry["representations"].append(
            {
                "start": r["start_time"],
                "end": r["end_time"],
                "is_continuous": bool(r["is_continuous"]),
                "status": r["status"],
                "source_text": r["source_text"],
            }
        )

    for entry in by_spectacle.values():
        entry["representations"].sort(key=lambda r: (r["start"] is None, r["start"] or ""))

    spectacles_list = sorted(by_spectacle.values(), key=lambda s: s["name"])

    nocturne = _find_nocturne_highlight(reps)

    warnings = json.loads(date_row["warnings"] or "[]")

    return {
        "date": date_row["date"],
        "season": (
            {
                "year": season["year"],
                "name": season["name"],
                "start_date": season["start_date"],
                "end_date": season["end_date"],
            }
            if season
            else None
        ),
        "updated_at": now_iso(),
        "status": date_row["status"],
        "warnings": warnings,
        "source": {
            "url": date_row["source_url"],
            "retrieved_at": date_row["retrieved_at"],
            "program_published_at": date_row["program_published_at"],
        },
        "spectacle_count": len(spectacles_list),
        "representation_count": len(reps),
        "nocturne": nocturne,
        "spectacles": spectacles_list,
    }


def _find_nocturne_highlight(reps: list[sqlite3.Row]) -> Optional[dict]:
    """Détermine le spectacle nocturne à mettre en avant (le premier de la
    journée). Pas de "prochain spectacle"/"prochain grand spectacle" ici :
    la catégorie "grand spectacle" n'existe pas côté site officiel, et la
    mise en avant générique du prochain spectacle n'apportait pas grand
    chose (voir historique du projet) — seul le repère "spectacle nocturne
    du jour" est conservé.
    """
    scheduled = [r for r in reps if r["status"] == config.REPR_STATUS_SCHEDULED and r["start_time"]]
    scheduled_sorted = sorted(scheduled, key=lambda r: r["start_time"])

    nocturnes = [
        r for r in scheduled_sorted
        if r["spectacle_category"] == "spectacle_nocturne"
        or (r["start_time"] and int(r["start_time"].split(":")[0]) >= config.NOCTURNAL_HOUR_THRESHOLD)
    ]
    return _to_highlight(nocturnes[0]) if nocturnes else None


def _to_highlight(row: sqlite3.Row) -> dict:
    return {"name": row["spectacle_name"], "slug": row["spectacle_slug"], "start": row["start_time"]}


def _out_of_season_info(conn: sqlite3.Connection, reference_date: str) -> tuple[bool, Optional[dict], Optional[str]]:
    """Détermine si `reference_date` tombe hors de la période d'ouverture de
    TOUTE saison connue. Ne peut rien affirmer (False, None, None) si aucune
    saison n'a encore de dates renseignées (voir data/seasons.json).

    Recherche par PLAGE de dates (`database.get_season_for_date`) plutôt
    que par année calendaire de `reference_date` : une saison peut
    chevaucher le nouvel an (ex: "Noël au Puy du Fou" jusqu'en janvier),
    auquel cas une date de janvier appartient à la saison de l'année
    précédente, pas à une saison "année+1" qui n'existe pas forcément.
    """
    season_config.sync_all_to_database(conn)
    all_seasons = database.list_seasons(conn)
    known_seasons = [s for s in all_seasons if s["start_date"] or s["end_date"]]
    if not known_seasons:
        return False, None, None

    if database.get_season_for_date(conn, reference_date) is not None:
        return False, None, None

    # Hors de toute saison connue. Fenêtre affichée (nécessite les DEUX
    # dates d'une saison) : la plus récemment terminée avant reference_date,
    # sinon (si reference_date est avant toute saison) la première connue.
    fully_dated = [s for s in known_seasons if s["start_date"] and s["end_date"]]
    past = [s for s in fully_dated if s["end_date"] < reference_date]
    window = None
    if past:
        w = max(past, key=lambda s: s["end_date"])
        window = {"start": w["start_date"], "end": w["end_date"]}
    elif fully_dated:
        w = min(fully_dated, key=lambda s: s["start_date"])
        window = {"start": w["start_date"], "end": w["end_date"]}

    # Prochaine réouverture (ne nécessite que le start_date d'une saison
    # future, même si sa end_date n'est pas encore connue).
    upcoming_starts = sorted(
        s["start_date"] for s in known_seasons if s["start_date"] and s["start_date"] > reference_date
    )
    next_opening = upcoming_starts[0] if upcoming_starts else None
    return True, window, next_opening


def _out_of_season_message(next_opening: Optional[str]) -> str:
    if next_opening:
        return f"Parc fermé pour la saison (réouverture prévue le {next_opening})."
    return "Parc fermé pour la saison (date de réouverture pas encore connue)."


def export_today(conn: sqlite3.Connection, *, reference_date: Optional[str] = None) -> dict:
    """Exporte today.json à partir de la date active la plus pertinente.

    Si `reference_date` est fourni (ex: date du jour système), on cherche la
    version active de cette date ; si elle n'existe pas (collecte pas encore
    faite ou en échec), on retombe sur la dernière date active connue plutôt
    que de publier un JSON vide, conformément à la règle "ne jamais publier
    de données vides si une collecte échoue". Exception : si les dates de
    saison sont connues et que `reference_date` tombe hors de cette période
    (parc fermé), le statut le reflète explicitement (`out_of_season`)
    plutôt que de parler d'erreur ou de données périmées.
    """
    reference_date = reference_date or date_cls.today().isoformat()
    row = database.get_active_date(conn, reference_date)
    stale = False
    out_of_season, season_window, next_opening = _out_of_season_info(conn, reference_date)

    if row is None:
        all_active = database.list_active_dates(conn)
        if not all_active:
            payload = {
                "date": reference_date,
                "season": None,
                "updated_at": now_iso(),
                "status": config.DATE_STATUS_OUT_OF_SEASON if out_of_season else config.DATE_STATUS_ERROR,
                "warnings": (
                    [_out_of_season_message(next_opening)] if out_of_season
                    else ["Aucune donnée collectée pour le moment."]
                ),
                "source": {"url": config.SOURCE_URL, "retrieved_at": None, "program_published_at": None},
                "spectacle_count": 0,
                "representation_count": 0,
                "nocturne": None,
                "season_window": season_window,
                "next_opening": next_opening,
                "spectacles": [],
            }
            _write_json(config.TODAY_JSON, payload)
            return payload
        row = all_active[-1]
        stale = True

    payload = _build_date_payload(conn, row)
    payload["season_window"] = None
    payload["next_opening"] = None
    if stale:
        if out_of_season:
            payload["status"] = config.DATE_STATUS_OUT_OF_SEASON
            payload["season_window"] = season_window
            payload["next_opening"] = next_opening
            payload["warnings"].append(_out_of_season_message(next_opening))
        else:
            payload["status"] = config.DATE_STATUS_STALE
            payload["warnings"].append(
                f"Pas de programme collecté pour {reference_date} : affichage des dernières "
                f"données fiables disponibles ({row['date']})."
            )
    _write_json(config.TODAY_JSON, payload)
    return payload


def export_history(conn: sqlite3.Connection) -> int:
    """Exporte data/json/history/{année}/{date}.json pour chaque date active
    (un sous-dossier par année de saison, pour ne pas accumuler des
    milliers de fichiers en vrac dans un seul dossier). Retourne le nombre
    de fichiers écrits.
    """
    count = 0
    for row in database.list_active_dates(conn):
        payload = _build_date_payload(conn, row)
        season = conn.execute("SELECT year FROM seasons WHERE id = ?", (row["season_id"],)).fetchone()
        year = season["year"] if season else row["date"][:4]
        _write_json(config.HISTORY_JSON_DIR / str(year) / f"{row['date']}.json", payload)
        count += 1
    return count


def export_season_recap(
    conn: sqlite3.Connection, year: int, *, final: bool = True, as_of_date: Optional[str] = None
) -> Optional[dict]:
    """Génère le bilan d'une saison dans data/json/history/{année}/recap.json.

    `final=True` (défaut, utilisé par la commande CLI) fige le bilan de fin
    de saison. `final=False` produit un instantané provisoire "as_of_date"
    (voir `maybe_export_season_recaps`, qui l'appelle automatiquement en
    cours de saison) : les stats ne portent que sur ce qui est collecté à
    cette date, pas sur la saison complète.
    """
    season = database.get_season_by_year(conn, year)
    if season is None:
        return None

    reference_date = as_of_date or season["end_date"] or date_cls.today().isoformat()
    global_stats = statistics.compute_global_stats(conn, year)
    reps = database.get_all_active_representations(conn, year)
    by_category: dict[str, int] = {}
    for r in reps:
        by_category[r["spectacle_category"]] = by_category.get(r["spectacle_category"], 0) + 1

    payload = {
        "year": year,
        "season_name": season["name"],
        "start_date": season["start_date"],
        "end_date": season["end_date"],
        "final": final,
        "as_of_date": reference_date,
        "generated_at": now_iso(),
        "days_collected": len({r["date"] for r in reps}),
        "representations_by_category": by_category,
        **global_stats,
    }
    _write_json(config.HISTORY_JSON_DIR / str(year) / "recap.json", payload)
    return payload


def maybe_export_season_recaps(conn: sqlite3.Connection, *, today: Optional[str] = None) -> list[int]:
    """Bilan de saison automatique : figé une fois la saison terminée (créé
    une seule fois, jamais retouché ensuite), mis à jour au plus une fois
    par mois calendaire tant qu'elle est en cours (instantané "as_of_date",
    voir `export_season_recap`). Retourne les années traitées.
    """
    today = today or date_cls.today().isoformat()
    generated = []
    for season in database.list_seasons(conn):
        if not season["start_date"] or season["start_date"] > today:
            continue  # saison pas encore commencée

        path = config.HISTORY_JSON_DIR / str(season["year"]) / "recap.json"
        existing = None
        if path.exists():
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                existing = None

        finished = bool(season["end_date"]) and season["end_date"] < today
        if finished:
            if existing and existing.get("final"):
                continue
            export_season_recap(conn, season["year"], final=True, as_of_date=season["end_date"])
        else:
            if existing and not existing.get("final") and str(existing.get("as_of_date"))[:7] == today[:7]:
                continue  # déjà mis à jour ce mois-ci
            export_season_recap(conn, season["year"], final=False, as_of_date=today)
        generated.append(season["year"])
    return generated


def export_spectacles(conn: sqlite3.Connection) -> dict:
    spectacles = database.list_spectacles(conn)
    payload_spectacles = []
    for s in spectacles:
        stats = statistics.compute_spectacle_stats(conn, s["slug"])
        if stats:
            payload_spectacles.append(stats)

    payload = {
        "updated_at": now_iso(),
        "categories": list(config.CATEGORIES.keys()),
        "spectacles": payload_spectacles,
    }
    _write_json(config.SPECTACLES_JSON, payload)
    return payload


def export_dates(conn: sqlite3.Connection) -> dict:
    rows = database.list_active_dates(conn)
    dates_payload = []
    for row in rows:
        reps = database.get_representations_for_date_id(conn, row["id"])
        season = conn.execute("SELECT * FROM seasons WHERE id = ?", (row["season_id"],)).fetchone()
        dates_payload.append(
            {
                "date": row["date"],
                "season_year": season["year"] if season else None,
                "status": row["status"],
                "spectacle_count": len({r["spectacle_id"] for r in reps}),
                "representation_count": len(reps),
            }
        )
    payload = {"updated_at": now_iso(), "dates": dates_payload}
    _write_json(config.DATES_JSON, payload)
    return payload


def export_stats(conn: sqlite3.Connection) -> dict:
    global_stats = statistics.compute_global_stats(conn)
    by_season = statistics.compute_stats_by_season(conn)

    reps = database.get_all_active_representations(conn)
    per_spectacle: dict[str, dict] = {}
    for r in reps:
        entry = per_spectacle.setdefault(r["spectacle_slug"], {"name": r["spectacle_name"], "count": 0})
        entry["count"] += 1
    per_spectacle_list = sorted(per_spectacle.values(), key=lambda e: e["count"], reverse=True)

    charts = {
        "representations_per_spectacle": per_spectacle_list,
        "spectacles_per_day": statistics.spectacles_per_day(conn),
        "seasonal_evolution": statistics.seasonal_evolution(conn),
        "hourly_distribution": statistics.hourly_distribution(conn),
        "top_spectacles": per_spectacle_list[:10],
        "bottom_spectacles": per_spectacle_list[-10:][::-1],
    }

    payload = {"updated_at": now_iso(), "global": global_stats, "by_season": by_season, "charts": charts}
    _write_json(config.STATS_JSON, payload)
    return payload


def export_all(conn: sqlite3.Connection, *, reference_date: Optional[str] = None) -> dict:
    """Lance tous les exports et retourne un résumé (utilisé par le CLI / la CI)."""
    today_payload = export_today(conn, reference_date=reference_date)
    spectacles_payload = export_spectacles(conn)
    dates_payload = export_dates(conn)
    stats_payload = export_stats(conn)
    history_count = export_history(conn)
    season_recaps_generated = maybe_export_season_recaps(conn)
    return {
        "today_status": today_payload["status"],
        "spectacle_count": len(spectacles_payload["spectacles"]),
        "dates_count": len(dates_payload["dates"]),
        "history_files": history_count,
        "total_representations": stats_payload["global"]["total_representations"],
        "season_recaps_generated": season_recaps_generated,
    }
