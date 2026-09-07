"""Extraction et analyse du programme officiel depuis les données JSON
structurées embarquées dans la page publique "programme du jour", en
remplacement du téléchargement/parsing du PDF (voir pdf_parser.py, conservé
pour référence/repli mais plus utilisé par défaut — voir
`Collector.__init__` dans collector.py).

La page (`config.SCHEDULE_PAGE_URL`) ne contient PAS le programme en HTML
visible : l'onglet "Spectacles" y est vide, rempli par du JavaScript.
Drupal embarque cependant les données du widget calendrier dans un bloc
<script type="application/json" data-drupal-selector="drupal-settings-json">,
sous la clé `timelineSchedule`. Structure observée (programme du
02/09/2026) :

    timelineSchedule.dates_open = ["2026-09-02", "2026-09-03", "2026-09-04"]
    timelineSchedule.sections = {
        "wzobj:scenode_XXXX": "<span class='entity-number'>2</span>Les Vikings",
        ...
    }
    timelineSchedule.events = {
        "2026-09-02": {
            "wzobj:scenode_XXXX": {
                "duration": "26minutes",
                "times": [
                    {"start": {"hour": "10", "min": "15"}, "end": {"hour": 10, "min": 41}, ...},
                    {"start": {"hour": "16", "min": "30"}, "end": {"hour": 16, "min": 56}, ...}
                ]
            },
            ...
        },
        ...
    }

Avantages vérifiés par rapport au PDF : données structurées (fini le
parsing de mise en page fragile — colonnes, plages continues coupées sur
plusieurs lignes...), une seule requête réseau couvre 3 jours au lieu de
deux téléchargements séparés (today/tomorrow), poids ~16 Ko compressé
contre ~1 Mo par PDF (mesuré). Les noms et horaires ont été croisés avec
des données déjà collectées via le PDF : correspondance exacte.

Limite connue : aucun statut "complet"/"exceptionnel" n'est présent dans
cette donnée (contrairement au texte du PDF). Sur toutes les
représentations collectées jusqu'ici via le PDF, ce statut n'a de toute
façon jamais été observé en pratique (toujours "scheduled") : la perte est
jugée acceptable. Toutes les représentations issues de cette source ont
donc le statut REPR_STATUS_SCHEDULED.

Pas de notion de "continu" explicite dans la donnée non plus : elle est
déduite en comparant l'étendue du créneau (fin - début) à la durée
annoncée du spectacle. Un accès "libre" (ex: Le Premier Royaume, 11h-17h
pour une visite de ~18 minutes) a une étendue très supérieure à sa durée ;
une représentation ponctuelle (ex: L'Épée du Roi Arthur, 22 minutes) a une
étendue égale à sa durée, à la minute près. Vérifié sur les 15 spectacles
et 27 représentations du programme réel du 02/09/2026 : jamais de cas
ambigu (écart soit nul, soit de plusieurs heures) — voir
_CONTINUOUS_SPAN_MARGIN_MINUTES.
"""
from __future__ import annotations

import json
import re

from src import config
from src.models import ParsedRepresentation, ParseResult

STRATEGY_NAME = "drupal_settings_json"

_SETTINGS_JSON_RE = re.compile(
    r'data-drupal-selector="drupal-settings-json">(?P<json>.*?)</script>', re.S
)
# Le numéro d'ordre du site officiel est le CONTENU du span (ex:
# "<span class='entity-number'>2</span>Les Vikings"), pas juste sa balise :
# il faut retirer l'élément entier, pas seulement les chevrons, sous peine
# de laisser le chiffre collé au nom ("2Les Vikings").
_ENTITY_NUMBER_SPAN_RE = re.compile(r"<span[^>]*>.*?</span>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_DURATION_NUMBER_RE = re.compile(r"(\d+)")

# Marge (en minutes) au-delà de laquelle l'écart entre la durée annoncée
# d'un spectacle et l'étendue (fin - début) d'un créneau signale un accès
# en continu ("visite libre") plutôt qu'une représentation ponctuelle (voir
# docstring du module).
_CONTINUOUS_SPAN_MARGIN_MINUTES = 5


def _extract_timeline_schedule(html: str) -> dict | None:
    m = _SETTINGS_JSON_RE.search(html)
    if not m:
        return None
    try:
        settings = json.loads(m["json"])
    except json.JSONDecodeError:
        return None
    return settings.get("timelineSchedule")


def _clean_section_name(raw_html: str) -> str:
    """Retire le préfixe "<span class='entity-number'>N</span>" (numéro
    d'ordre du site officiel, avec son contenu) et les espaces superflus du
    nom du spectacle."""
    without_number = _ENTITY_NUMBER_SPAN_RE.sub("", raw_html)
    return _TAG_RE.sub("", without_number).strip()


def _duration_minutes(duration_str: str) -> int | None:
    m = _DURATION_NUMBER_RE.match(duration_str or "")
    return int(m.group(1)) if m else None


def _to_minutes(hhmm: str) -> int:
    h, m = (int(part) for part in hhmm.split(":"))
    return h * 60 + m


def parse_schedule_html(html: str, requested_date: str, *, is_today: bool = False) -> ParseResult:
    """Analyse la page "programme du jour" et extrait les représentations
    de `requested_date` (ISO "YYYY-MM-DD").

    Contrairement à `pdf_parser.parse_program_text` (qui cherche la date
    DANS le texte, potentiellement différente de celle demandée), la date
    est ici un simple index dans `timelineSchedule` : `date_found` vaut
    donc `requested_date` dès qu'elle figure dans `dates_open` (même sans
    aucun spectacle programmé), ou None sinon (jour hors de la fenêtre
    publiée par le site — au-delà d'après-demain), pour rester cohérent
    avec la convention existante : le code appelant (Collector.collect)
    retombe alors sur la date demandée, avec un avertissement plutôt
    qu'une erreur bloquante.

    Distinction "fermé" vs "pas encore publié" : `dates_open` liste les
    jours que le site reconnaît explicitement (widget affiché) ; une date
    qui y figure mais sans aucune entrée dans `events` (ou une entrée
    vide) signifie que le parc est fermé ce jour-là — c'est ce que
    l'utilisateur voit s'afficher comme "Le Puy du Fou est fermé" sur la
    page officielle. Une date ABSENTE de `dates_open` signifie
    normalement autre chose : elle est simplement hors de la fenêtre de 3
    jours publiée (pas encore atteinte), ce qui n'implique rien sur son
    statut réel.

    Exception constatée en pratique (fermeture du 07/09/2026) : `dates_open`
    peut être ENTIÈREMENT VIDE plutôt que de lister le jour avec des
    événements vides — dans ce cas précis, le widget n'affiche jamais rien
    à ouvrir, pas même la date du jour. `is_today=True` (positionné par
    l'appelant, qui connaît la date du jour) permet de distinguer ce cas
    d'une fermeture réelle de "vraiment rien publié pour l'instant" : on ne
    l'applique JAMAIS à demain/après-demain, dont l'absence ne prouve rien
    (ils peuvent simplement ne pas encore être publiés).
    """
    warnings: list[str] = []
    schedule = _extract_timeline_schedule(html)
    if schedule is None:
        warnings.append(
            "Données du calendrier introuvables dans la page (bloc "
            "drupal-settings-json absent ou timelineSchedule manquant) : "
            "le site a peut-être changé de structure."
        )
        return ParseResult(date_found=None, warnings=warnings, strategy_used=STRATEGY_NAME)

    dates_open = schedule.get("dates_open") or []
    if is_today and requested_date not in dates_open and not dates_open:
        # Le parc est fermé aujourd'hui : voir la note sur dates_open vide
        # ci-dessus. Pas d'avertissement ici, comme pour l'autre variante
        # de fermeture (date présente mais events vide) : ce n'est pas une
        # anomalie de collecte.
        return ParseResult(date_found=requested_date, park_closed=True, strategy_used=STRATEGY_NAME)

    if requested_date not in dates_open:
        warnings.append(
            f"Aucune donnée publiée pour {requested_date} sur la page "
            f"(dates disponibles : {', '.join(dates_open) or 'aucune'})."
        )
        return ParseResult(date_found=None, warnings=warnings, strategy_used=STRATEGY_NAME)

    events_for_date = (schedule.get("events") or {}).get(requested_date) or {}
    if not events_for_date:
        # Le parc est fermé ce jour-là (voir docstring) : ce n'est PAS une
        # anomalie, donc pas d'avertissement "aucune représentation
        # trouvée" ici — juste le marqueur park_closed, à charge du code
        # appelant de le refléter comme tel plutôt que comme une erreur.
        return ParseResult(date_found=requested_date, park_closed=True, strategy_used=STRATEGY_NAME)

    sections = schedule.get("sections") or {}
    representations: list[ParsedRepresentation] = []

    for section_id, event in events_for_date.items():
        name_raw = _clean_section_name(sections.get(section_id, section_id))
        duration = _duration_minutes(event.get("duration", ""))

        for slot in event.get("times", []):
            start, end = slot.get("start") or {}, slot.get("end") or {}
            try:
                start_time = f"{int(start['hour']):02d}:{int(start['min']):02d}"
                end_time = f"{int(end['hour']):02d}:{int(end['min']):02d}"
            except (KeyError, ValueError, TypeError):
                warnings.append(f"Créneau ignoré pour {name_raw!r} : horaire illisible ({slot!r}).")
                continue

            span_minutes = _to_minutes(end_time) - _to_minutes(start_time)
            is_continuous = duration is not None and span_minutes - duration > _CONTINUOUS_SPAN_MARGIN_MINUTES

            representations.append(
                ParsedRepresentation(
                    name_raw=name_raw,
                    start_time=start_time,
                    end_time=end_time,
                    is_continuous=is_continuous,
                    # Aucun statut "complet"/"exceptionnel" dans cette
                    # source (voir docstring du module) : toujours planifié.
                    status=config.REPR_STATUS_SCHEDULED,
                    source_text=(
                        f"{name_raw} {duration}' {start_time}-{end_time}"
                        if duration is not None
                        else f"{name_raw} {start_time}-{end_time}"
                    ),
                )
            )

    if not representations:
        warnings.append(f"Aucune représentation trouvée pour {requested_date} dans les données du calendrier.")

    return ParseResult(
        date_found=requested_date,
        representations=representations,
        warnings=warnings,
        strategy_used=STRATEGY_NAME,
    )
