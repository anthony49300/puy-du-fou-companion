"""Interface en ligne de commande.

Exemples :
    python -m src.main collect
    python -m src.main collect --date 2026-08-26
    python -m src.main collect --tomorrow
    python -m src.main collect --dry-run
    python -m src.main collect --source pdf  # repli sur l'ancienne méthode (PDF)
    python -m src.main stats
    python -m src.main stats --season 2026
    python -m src.main export
    python -m src.main all
"""
from __future__ import annotations

import argparse
import sys
from datetime import date as date_cls
from datetime import timedelta

from src import config, database, exporter, season_config, statistics
from src.collector import Collector, PuyDuFouSourceAdapter


def _print_header(title: str) -> None:
    print(f"\n=== {title} ===")


def cmd_collect(args: argparse.Namespace) -> int:
    if args.tomorrow:
        # La page "programme du jour" publie toujours aujourd'hui + demain +
        # après-demain en un seul chargement (voir SCHEDULE_PAGE_URL /
        # schedule_json_parser.py) : une collecte "demain" le soir même
        # couvre donc ce jour sans dépendre d'un déclenchement matinal
        # fiable le lendemain (les cron GitHub Actions peuvent être
        # retardés de plusieurs heures), sans requête réseau différente de
        # celle d'aujourd'hui — seule la date ciblée pour le parsing change.
        target_date = date_cls.today() + timedelta(days=1)
    else:
        target_date = date_cls.fromisoformat(args.date) if args.date else date_cls.today()

    # --source pdf : repli explicite sur l'ancienne méthode (téléchargement
    # + parsing du PDF officiel), conservée intacte et fonctionnelle pour le
    # jour où la source JSON deviendrait indisponible ou peu fiable — voir
    # PuyDuFouSourceAdapter dans src/collector.py. `getattr` par prudence :
    # les appels internes (cmd_collect_daily) construisent leur propre
    # Namespace sans cet attribut, et doivent alors utiliser le défaut JSON.
    use_pdf = getattr(args, "source", "json") == "pdf"
    if use_pdf:
        source_url = config.SOURCE_URL_TOMORROW if args.tomorrow else config.SOURCE_URL
        adapter = PuyDuFouSourceAdapter(source_url=source_url)
    else:
        adapter = None  # défaut : PuyDuFouScheduleSourceAdapter (voir Collector.__init__)
        source_url = config.SCHEDULE_PAGE_URL

    print(f"Collecte du programme pour le {target_date.isoformat()} (source: {source_url})")
    if args.dry_run:
        print("Mode --dry-run : aucune écriture en base ne sera effectuée.\n")

    outcome = Collector(adapter=adapter).collect(target_date, dry_run=args.dry_run)

    print(f"Statut          : {outcome.status}")
    print(f"Date effective   : {outcome.date_str}")
    print(f"Spectacles       : {outcome.spectacle_count}")
    print(f"Représentations  : {outcome.representation_count}")
    print(f"Message          : {outcome.message}")

    if outcome.warnings:
        print(f"\nAvertissements ({len(outcome.warnings)}) :")
        for w in outcome.warnings:
            print(f"  - {w}")

    if outcome.dry_run_preview is not None:
        print("\nAperçu des données extraites (dry-run) :")
        for rep in outcome.dry_run_preview:
            end = f" - {rep['end']}" if rep["end"] else ""
            flags = []
            if rep["is_continuous"]:
                flags.append("CONTINU")
            if rep["status"] != config.REPR_STATUS_SCHEDULED:
                flags.append(rep["status"].upper())
            if not rep["known"]:
                flags.append("SPECTACLE INCONNU DE LA CONFIG")
            flag_str = f"  [{', '.join(flags)}]" if flags else ""
            start = rep["start"] or "??:??"
            print(f"  {start}{end}  {rep['name']} ({rep['category']}){flag_str}")

    return 0 if outcome.status != config.DATE_STATUS_ERROR else 1


def cmd_collect_daily(args: argparse.Namespace) -> int:
    """Point d'entrée quotidien recommandé pour l'automatisation.

    Récupère aujourd'hui, demain et après-demain (chacun seulement s'il
    n'est pas déjà connu) en un seul appel, exécuté une fois par jour le
    matin par le workflow GitHub Actions — la page "programme du jour"
    publie systématiquement ces 3 jours en un seul chargement (voir
    SCHEDULE_PAGE_URL / schedule_json_parser.py) : les couvrir tous les
    trois ne coûte donc jamais plus d'UNE requête réseau au total, même
    quand les trois sont inconnus en même temps (le cache dans
    PuyDuFouScheduleSourceAdapter évite de re-télécharger la même page pour
    chaque date). En régime stable, "aujourd'hui" et "demain" sont déjà
    connus (collectés respectivement avant-hier et hier), seul
    "après-demain" — le nouveau jour de la fenêtre — nécessite une vraie
    collecte chaque matin : chaque jour est ainsi connu avec un jour
    d'avance sur le strict nécessaire, ce qui absorbe un run manqué sans
    trou de données. "Aujourd'hui"/"demain" ne redeviennent utiles à
    recollecter que si un run précédent a été manqué : dans ce cas ils sont
    encore inconnus et servent de rattrapage. Ne fait AUCUN appel réseau si
    les trois jours sont déjà connus, ce qui rend cette commande sûre à
    rappeler (ex: relance manuelle) sans dupliquer le travail.

    Contrepartie assumée : un vrai correctif publié par le site EN COURS DE
    JOURNÉE sur un jour déjà connu ne sera pas rattrapé automatiquement
    avant que ce jour ne redevienne "inconnu" (il ne l'est jamais, sauf run
    manqué) — utilisez `collect --date ...`/`collect --tomorrow`
    manuellement si besoin de forcer une recollecte.
    """
    today = date_cls.today()
    tomorrow = today + timedelta(days=1)
    day_after_tomorrow = today + timedelta(days=2)
    with database.connect() as conn:
        have_today = database.get_active_date(conn, today.isoformat()) is not None
        have_tomorrow = database.get_active_date(conn, tomorrow.isoformat()) is not None
        have_day_after_tomorrow = database.get_active_date(conn, day_after_tomorrow.isoformat()) is not None

    rc = 0
    if have_today:
        print(f"Programme du {today.isoformat()} déjà connu (collecté précédemment) : pas de recollecte.")
    else:
        print(f"Aucun programme connu pour le {today.isoformat()} : collecte de rattrapage.")
        rc = max(rc, cmd_collect(argparse.Namespace(date=None, tomorrow=False, dry_run=False)))

    if have_tomorrow:
        print(f"Programme du {tomorrow.isoformat()} déjà connu (collecté précédemment) : pas de recollecte.")
    else:
        rc = max(rc, cmd_collect(argparse.Namespace(date=None, tomorrow=True, dry_run=False)))

    if have_day_after_tomorrow:
        print(f"Programme du {day_after_tomorrow.isoformat()} déjà connu (collecté précédemment) : pas de recollecte.")
    else:
        rc = max(
            rc,
            cmd_collect(argparse.Namespace(date=day_after_tomorrow.isoformat(), tomorrow=False, dry_run=False)),
        )
    return rc


def cmd_stats(args: argparse.Namespace) -> int:
    with database.connect() as conn:
        season_year = args.season
        stats = statistics.compute_global_stats(conn, season_year)

        _print_header(f"Statistiques globales{f' — saison {season_year}' if season_year else ''}")
        print(f"Total spectacles       : {stats['total_spectacles']}")
        print(f"Total représentations  : {stats['total_representations']}")
        print(f"Moyenne / jour          : {stats['avg_per_day']}")
        print(f"Jour le plus chargé      : {stats['max_per_day']}")
        print(f"Jour le plus calme        : {stats['min_per_day']}")
        print(f"Représentations continues : {stats['continuous_count']}")
        print(f"Représentations nocturnes : {stats['nocturnal_count']}")

        _print_header("Spectacles les plus représentés")
        for s in stats["most_represented"]:
            print(f"  {s['name']:<40} {s['count']}")

        _print_header("Spectacles les moins représentés")
        for s in stats["least_represented"]:
            print(f"  {s['name']:<40} {s['count']}")

        _print_header("Par saison")
        for s in statistics.compute_stats_by_season(conn):
            print(f"  {s['year']}: {s['total_representations']} représentations, "
                  f"{s['total_spectacles']} spectacles, {s['days_collected']} jours collectés")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    with database.connect() as conn:
        summary = exporter.export_all(conn, reference_date=args.date)
    print("Export JSON terminé :")
    for key, value in summary.items():
        print(f"  {key}: {value}")
    return 0


def cmd_set_season_dates(args: argparse.Namespace) -> int:
    for value, flag in ((args.start, "--start"), (args.end, "--end")):
        if value is not None:
            try:
                date_cls.fromisoformat(value)
            except ValueError:
                print(f"Erreur : {flag} doit être au format YYYY-MM-DD (reçu {value!r}).")
                return 1

    with database.connect() as conn:
        existing = database.get_season_by_year(conn, args.year)
        start_date = args.start if args.start is not None else (existing["start_date"] if existing else None)
        end_date = args.end if args.end is not None else (existing["end_date"] if existing else None)
        if start_date and end_date and start_date > end_date:
            print(f"Erreur : --start ({start_date}) est après --end ({end_date}).")
            return 1
        database.set_season_dates(conn, args.year, start_date=start_date, end_date=end_date)

    print(f"Saison {args.year} : ouverture={start_date or '(non renseignée)'}, fermeture={end_date or '(non renseignée)'}")
    return 0


def cmd_season_recap(args: argparse.Namespace) -> int:
    with database.connect() as conn:
        payload = exporter.export_season_recap(conn, args.year)
    if payload is None:
        print(f"Erreur : aucune saison {args.year} enregistrée (voir `python -m src.main seasons`).")
        return 1
    print(f"Bilan de la saison {args.year} régénéré (data/json/history/{args.year}/recap.json) :")
    print(f"  Jours collectés         : {payload['days_collected']}")
    print(f"  Représentations totales : {payload['total_representations']}")
    print(f"  Spectacles distincts    : {payload['total_spectacles']}")
    return 0


def cmd_seasons(args: argparse.Namespace) -> int:
    with database.connect() as conn:
        for year in season_config.configured_years():
            season_config.sync_to_database(conn, year)
        seasons = database.list_seasons(conn)
    if not seasons:
        print("Aucune saison enregistrée pour le moment (créée automatiquement à la première collecte).")
        return 0
    _print_header("Saisons")
    for s in seasons:
        start = s["start_date"] or "?"
        end = s["end_date"] or "?"
        print(f"  {s['year']} ({s['name']}) : {start} -> {end}")
    return 0


def cmd_all(args: argparse.Namespace) -> int:
    collect_rc = cmd_collect(argparse.Namespace(date=args.date, tomorrow=False, dry_run=False))
    export_rc = cmd_export(argparse.Namespace(date=args.date))
    stats_rc = cmd_stats(argparse.Namespace(season=None))
    return max(collect_rc, export_rc, stats_rc)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m src.main",
        description="Collecte, historisation et analyse des programmes quotidiens du Puy du Fou.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_collect = sub.add_parser("collect", help="Récupère et enregistre le programme officiel d'une date.")
    p_collect.add_argument("--date", help="Date cible au format YYYY-MM-DD (par défaut: aujourd'hui).")
    p_collect.add_argument(
        "--tomorrow", action="store_true",
        help="Cible la date de demain plutôt qu'aujourd'hui ; ignore --date.",
    )
    p_collect.add_argument("--dry-run", action="store_true", help="N'écrit rien en base, affiche l'aperçu extrait.")
    p_collect.add_argument(
        "--source", choices=["json", "pdf"], default="json",
        help="Source de collecte : 'json' (par défaut, page programme-du-jour) ou 'pdf' "
             "(ancienne méthode par téléchargement du PDF officiel, conservée en repli).",
    )
    p_collect.set_defaults(func=cmd_collect)

    p_collect_daily = sub.add_parser(
        "collect-daily",
        help="Point d'entrée quotidien recommandé : recollecte 'aujourd'hui' seulement s'il est "
             "inconnu, puis collecte toujours 'demain'.",
    )
    p_collect_daily.set_defaults(func=cmd_collect_daily)

    p_stats = sub.add_parser("stats", help="Affiche les statistiques globales (et par saison).")
    p_stats.add_argument("--season", type=int, default=None, help="Filtrer sur une année de saison.")
    p_stats.set_defaults(func=cmd_stats)

    p_export = sub.add_parser("export", help="Régénère tous les fichiers JSON du frontend.")
    p_export.add_argument("--date", help="Date de référence pour today.json (par défaut: aujourd'hui).")
    p_export.set_defaults(func=cmd_export)

    p_all = sub.add_parser("all", help="Enchaîne collect + export + stats.")
    p_all.add_argument("--date", help="Date cible au format YYYY-MM-DD (par défaut: aujourd'hui).")
    p_all.set_defaults(func=cmd_all)

    p_set_season = sub.add_parser(
        "set-season-dates",
        help="Renseigne les dates d'ouverture/fermeture d'une saison (parc fermé en dehors).",
    )
    p_set_season.add_argument("year", type=int, help="Année de la saison (ex: 2026).")
    p_set_season.add_argument("--start", help="Date d'ouverture YYYY-MM-DD (omis = inchangée).")
    p_set_season.add_argument("--end", help="Date de fermeture YYYY-MM-DD (omis = inchangée).")
    p_set_season.set_defaults(func=cmd_set_season_dates)

    p_seasons = sub.add_parser("seasons", help="Liste les saisons enregistrées et leurs dates.")
    p_seasons.set_defaults(func=cmd_seasons)

    p_recap = sub.add_parser(
        "season-recap",
        help="(Re)génère explicitement le bilan JSON figé d'une saison (data/json/history/{année}/recap.json).",
    )
    p_recap.add_argument("year", type=int, help="Année de la saison.")
    p_recap.set_defaults(func=cmd_season_recap)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
