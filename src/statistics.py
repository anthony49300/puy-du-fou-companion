"""Calculs statistiques sur les programmes historisés.

Toutes les fonctions prennent une connexion SQLite déjà ouverte
(`src.database.connect(...)`) et travaillent uniquement sur les versions
actives (`is_active = 1`) des dates, sauf mention contraire.
"""
from __future__ import annotations

import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from src import config, database


def _duration_minutes(start: str, end: Optional[str]) -> int:
    if end:
        h1, m1 = map(int, start.split(":"))
        h2, m2 = map(int, end.split(":"))
        minutes = (h2 * 60 + m2) - (h1 * 60 + m1)
        if minutes <= 0:
            minutes += 24 * 60  # passage de minuit
        return minutes
    return config.DEFAULT_SHOW_DURATION_MINUTES


def _to_minutes(hhmm: str) -> int:
    h, m = map(int, hhmm.split(":"))
    return h * 60 + m


# ---------------------------------------------------------------------------
# Statistiques globales
# ---------------------------------------------------------------------------

def compute_global_stats(conn: sqlite3.Connection, season_year: Optional[int] = None) -> dict:
    reps = database.get_all_active_representations(conn, season_year)

    spectacle_slugs = {r["spectacle_slug"] for r in reps}
    per_day: dict[str, int] = defaultdict(int)
    per_spectacle: dict[str, int] = defaultdict(int)
    per_spectacle_name: dict[str, str] = {}
    continuous_count = 0
    nocturnal_count = 0

    for r in reps:
        per_day[r["date"]] += 1
        per_spectacle[r["spectacle_slug"]] += 1
        per_spectacle_name[r["spectacle_slug"]] = r["spectacle_name"]
        if r["is_continuous"]:
            continuous_count += 1
        if _is_nocturnal(r):
            nocturnal_count += 1

    total_representations = len(reps)
    days = list(per_day.keys())
    avg_per_day = (total_representations / len(days)) if days else 0.0

    min_per_day = None
    max_per_day = None
    if per_day:
        min_date = min(per_day, key=lambda d: per_day[d])
        max_date = max(per_day, key=lambda d: per_day[d])
        min_per_day = {"date": min_date, "count": per_day[min_date]}
        max_per_day = {"date": max_date, "count": per_day[max_date]}

    ranked = sorted(per_spectacle.items(), key=lambda kv: kv[1], reverse=True)
    most_represented = [
        {"slug": slug, "name": per_spectacle_name[slug], "count": count} for slug, count in ranked[:5]
    ]
    least_represented = [
        {"slug": slug, "name": per_spectacle_name[slug], "count": count} for slug, count in ranked[-5:][::-1]
    ]

    return {
        "total_spectacles": len(spectacle_slugs),
        "total_representations": total_representations,
        "avg_per_day": round(avg_per_day, 2),
        "min_per_day": min_per_day,
        "max_per_day": max_per_day,
        "most_represented": most_represented,
        "least_represented": least_represented,
        "continuous_count": continuous_count,
        "nocturnal_count": nocturnal_count,
    }


def _is_nocturnal(row: sqlite3.Row) -> bool:
    if row["spectacle_category"] == "spectacle_nocturne":
        return True
    if row["start_time"]:
        hour = int(row["start_time"].split(":")[0])
        return hour >= config.NOCTURNAL_HOUR_THRESHOLD
    return False


def compute_stats_by_season(conn: sqlite3.Connection) -> list[dict]:
    seasons = database.list_seasons(conn)
    result = []
    for season in seasons:
        reps = database.get_all_active_representations(conn, season["year"])
        days = {r["date"] for r in reps}
        spectacles = {r["spectacle_slug"] for r in reps}
        result.append(
            {
                "year": season["year"],
                "total_representations": len(reps),
                "total_spectacles": len(spectacles),
                "days_collected": len(days),
            }
        )
    return result


# ---------------------------------------------------------------------------
# Statistiques par spectacle
# ---------------------------------------------------------------------------

def compute_spectacle_stats(conn: sqlite3.Connection, slug: str) -> Optional[dict]:
    spectacle = database.get_spectacle_by_slug(conn, slug)
    if not spectacle:
        return None

    reps = database.get_representations_for_spectacle(conn, spectacle["id"])
    # Un jour de fermeture ponctuelle du parc (closed_day) ne compte pas
    # comme un jour où CE spectacle serait "absent" : ce jour-là, AUCUN
    # spectacle n'a lieu, ce n'est pas spécifique à celui-ci. Il ne doit
    # donc pas gonfler le dénominateur days_present + days_absent, ni
    # apparaître dans l'historique journalier de ce spectacle.
    all_active_dates = [
        d for d in database.list_active_dates(conn)
        if d["status"] not in (config.DATE_STATUS_CLOSED_DAY, config.DATE_STATUS_OUT_OF_SEASON)
    ]
    total_days = len(all_active_dates)

    per_day_count: dict[str, int] = defaultdict(int)
    for r in reps:
        per_day_count[r["date"]] += 1

    days_present = len(per_day_count)
    days_absent = max(total_days - days_present, 0)
    avg_per_day = (len(reps) / days_present) if days_present else 0.0

    history = [{"date": d["date"], "count": per_day_count.get(d["date"], 0)} for d in all_active_dates]

    today_str = datetime.now().date().isoformat()
    today_count = per_day_count.get(today_str, 0)

    return {
        "slug": slug,
        "name": spectacle["name"],
        "category": spectacle["category"],
        "active": bool(spectacle["active"]),
        "stats": {
            "today_count": today_count,
            "avg_per_day": round(avg_per_day, 2),
            "days_present": days_present,
            "days_absent": days_absent,
            "total_representations": len(reps),
        },
        "history": history,
    }


# ---------------------------------------------------------------------------
# Statistiques avancées
# ---------------------------------------------------------------------------

def busiest_and_lightest_day(conn: sqlite3.Connection) -> dict:
    reps = database.get_all_active_representations(conn)
    per_day: dict[str, int] = defaultdict(int)
    for r in reps:
        per_day[r["date"]] += 1
    if not per_day:
        return {"busiest": None, "lightest": None}
    busiest_date = max(per_day, key=lambda d: per_day[d])
    lightest_date = min(per_day, key=lambda d: per_day[d])
    return {
        "busiest": {"date": busiest_date, "count": per_day[busiest_date]},
        "lightest": {"date": lightest_date, "count": per_day[lightest_date]},
    }


def co_programmed_spectacles(conn: sqlite3.Connection, slug: str, top_n: int = 5) -> list[dict]:
    """Spectacles qui apparaissent le plus souvent le même jour que `slug`."""
    reps = database.get_all_active_representations(conn)
    dates_with_slug = {r["date"] for r in reps if r["spectacle_slug"] == slug}
    if not dates_with_slug:
        return []
    co_counter: Counter[str] = Counter()
    names: dict[str, str] = {}
    for r in reps:
        if r["date"] in dates_with_slug and r["spectacle_slug"] != slug:
            co_counter[r["spectacle_slug"]] += 1
            names[r["spectacle_slug"]] = r["spectacle_name"]
    ranked = co_counter.most_common(top_n)
    return [{"slug": s, "name": names[s], "days_together": c} for s, c in ranked]


def rarely_programmed(conn: sqlite3.Connection, max_days_present: int = 5) -> list[dict]:
    reps = database.get_all_active_representations(conn)
    per_spectacle_days: dict[str, set] = defaultdict(set)
    names: dict[str, str] = {}
    for r in reps:
        per_spectacle_days[r["spectacle_slug"]].add(r["date"])
        names[r["spectacle_slug"]] = r["spectacle_name"]
    result = [
        {"slug": slug, "name": names[slug], "days_present": len(days)}
        for slug, days in per_spectacle_days.items()
        if len(days) <= max_days_present
    ]
    return sorted(result, key=lambda x: x["days_present"])


def hourly_distribution(conn: sqlite3.Connection) -> list[dict]:
    reps = database.get_all_active_representations(conn)
    counter: Counter[str] = Counter()
    for r in reps:
        if r["start_time"]:
            hour_label = f"{r['start_time'].split(':')[0]}:00"
            counter[hour_label] += 1
    return [{"hour": h, "count": c} for h, c in sorted(counter.items())]


def spectacles_per_day(conn: sqlite3.Connection) -> list[dict]:
    """Nombre de spectacles DIFFÉRENTS disponibles chaque jour (pas le nb de représentations)."""
    reps = database.get_all_active_representations(conn)
    per_day: dict[str, set] = defaultdict(set)
    for r in reps:
        per_day[r["date"]].add(r["spectacle_slug"])
    return [{"date": d, "count": len(s)} for d, s in sorted(per_day.items())]


def seasonal_evolution(conn: sqlite3.Connection, season_year: Optional[int] = None) -> list[dict]:
    reps = database.get_all_active_representations(conn, season_year)
    per_day: dict[str, int] = defaultdict(int)
    for r in reps:
        per_day[r["date"]] += 1
    return [{"date": d, "count": c} for d, c in sorted(per_day.items())]


def compare_dates(conn: sqlite3.Connection, date1: str, date2: str) -> dict:
    reps1 = database.get_representations_for_date_str(conn, date1)
    reps2 = database.get_representations_for_date_str(conn, date2)

    slugs1 = {r["spectacle_slug"] for r in reps1}
    slugs2 = {r["spectacle_slug"] for r in reps2}

    return {
        "date1": {
            "date": date1,
            "spectacle_count": len(slugs1),
            "representation_count": len(reps1),
            # Spectacles présents à date2 mais absents de date1 (donc "manquants ici").
            "missing_here_present_other": sorted(slugs2 - slugs1),
            "schedule": [
                {"start": r["start_time"], "name": r["spectacle_name"]} for r in reps1
            ],
        },
        "date2": {
            "date": date2,
            "spectacle_count": len(slugs2),
            "representation_count": len(reps2),
            # Spectacles présents à date1 mais absents de date2.
            "missing_here_present_other": sorted(slugs1 - slugs2),
            "schedule": [
                {"start": r["start_time"], "name": r["spectacle_name"]} for r in reps2
            ],
        },
    }


def compare_spectacles(conn: sqlite3.Connection, slug1: str, slug2: str) -> dict:
    stats1 = compute_spectacle_stats(conn, slug1)
    stats2 = compute_spectacle_stats(conn, slug2)
    return {"spectacle1": stats1, "spectacle2": stats2}


def compare_seasons(conn: sqlite3.Connection, year1: int, year2: int) -> dict:
    by_season = {s["year"]: s for s in compute_stats_by_season(conn)}
    return {
        "season1": by_season.get(year1),
        "season2": by_season.get(year2),
    }


# ---------------------------------------------------------------------------
# Conflits horaires / plan de visite optimal
# ---------------------------------------------------------------------------

@dataclass
class ScheduledShow:
    slug: str
    name: str
    start: str  # "HH:MM"
    end: str  # "HH:MM", dérivée si nécessaire par DEFAULT_SHOW_DURATION_MINUTES


def find_schedule_conflicts(shows: list[ScheduledShow]) -> list[tuple[ScheduledShow, ScheduledShow]]:
    """Retourne les paires de représentations qui se superposent dans le temps."""
    intervals = [(s, _to_minutes(s.start), _to_minutes(s.end)) for s in shows]
    conflicts = []
    for i in range(len(intervals)):
        for j in range(i + 1, len(intervals)):
            s1, start1, end1 = intervals[i]
            s2, start2, end2 = intervals[j]
            if start1 < end2 and start2 < end1:
                conflicts.append((s1, s2))
    return conflicts


def max_shows_schedulable(shows: list[ScheduledShow]) -> list[ScheduledShow]:
    """Nombre maximal de représentations visionnables sans superposition.

    Algorithme classique de sélection d'activités ("activity selection") :
    trier par heure de fin croissante, choisir gloutonnement chaque
    représentation dont le début est postérieur ou égal à la fin de la
    dernière sélectionnée. Optimal pour maximiser le NOMBRE d'activités
    compatibles (toutes les représentations ont un poids égal de 1).
    """
    sorted_shows = sorted(shows, key=lambda s: _to_minutes(s.end))
    selected: list[ScheduledShow] = []
    last_end = -1
    for show in sorted_shows:
        start = _to_minutes(show.start)
        end = _to_minutes(show.end)
        if start >= last_end:
            selected.append(show)
            last_end = end
    # On restitue l'ordre chronologique pour la présentation du parcours.
    return sorted(selected, key=lambda s: _to_minutes(s.start))


def build_scheduled_shows_from_date(conn: sqlite3.Connection, date_str: str) -> list[ScheduledShow]:
    reps = database.get_representations_for_date_str(conn, date_str)
    shows = []
    for r in reps:
        if not r["start_time"] or r["status"] != config.REPR_STATUS_SCHEDULED:
            continue
        start = r["start_time"]
        end = r["end_time"] or _minutes_to_hhmm(_to_minutes(start) + _duration_minutes(start, r["end_time"]))
        shows.append(ScheduledShow(slug=r["spectacle_slug"], name=r["spectacle_name"], start=start, end=end))
    return shows


def _minutes_to_hhmm(total_minutes: int) -> str:
    total_minutes %= 24 * 60
    return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"
