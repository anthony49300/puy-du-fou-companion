"""Configuration centrale du projet.

Toutes les valeurs "en dur" ailleurs dans le code (catégories, chemins,
URL source, statuts...) doivent être définies ici et importées, afin de
garder un point unique de configuration.
"""
from __future__ import annotations

import os
from pathlib import Path

# ---------------------------------------------------------------------------
# Chemins
# ---------------------------------------------------------------------------

# Racine du dépôt (deux niveaux au-dessus de ce fichier: src/config.py -> src -> racine)
BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = BASE_DIR / "data"
JSON_DIR = DATA_DIR / "json"
HISTORY_JSON_DIR = JSON_DIR / "history"
RAW_DIR = DATA_DIR / "raw"

# La base SQLite peut être surchargée via la variable d'environnement
# PDF_PROGRAMMES_DB (utile pour les tests, qui utilisent une base temporaire).
DB_PATH = Path(os.environ.get("PDF_PROGRAMMES_DB", str(DATA_DIR / "programmes.db")))

KNOWN_SPECTACLES_PATH = DATA_DIR / "known_spectacles.json"

# Dates d'ouverture/fermeture de chaque saison, éditables directement sans
# passer par une commande Python (voir src/season_config.py, même principe
# que KNOWN_SPECTACLES_PATH ci-dessus pour les spectacles).
SEASONS_CONFIG_PATH = DATA_DIR / "seasons.json"

# Fichiers JSON générés pour le frontend
TODAY_JSON = JSON_DIR / "today.json"
SPECTACLES_JSON = JSON_DIR / "spectacles.json"
DATES_JSON = JSON_DIR / "dates.json"
STATS_JSON = JSON_DIR / "stats.json"

for _d in (DATA_DIR, JSON_DIR, HISTORY_JSON_DIR, RAW_DIR):
    _d.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Source officielle
# ---------------------------------------------------------------------------

# Page publique "programme du jour". Ne contient pas le programme en HTML
# visible (l'onglet "Spectacles" est vide, rempli par du JavaScript) : mais
# Drupal y embarque les données structurées du widget calendrier dans un
# bloc <script data-drupal-selector="drupal-settings-json"> (clé
# `timelineSchedule`), qu'on extrait directement plutôt que de
# télécharger/parser un PDF (voir src/schedule_json_parser.py). Un seul
# chargement de cette page couvre TOUJOURS aujourd'hui + demain +
# après-demain (`timelineSchedule.dates_open`), donc une seule requête
# réseau par collecte quotidienne (au lieu de deux téléchargements PDF
# séparés) et un poids d'environ 16 Ko compressé contre ~1 Mo par PDF —
# un gain important sur le volume transporté par le proxy résidentiel
# (voir HTTP_PROXY_URL ci-dessous), qui reste nécessaire (le WAF bloque
# tout le domaine, pas seulement l'ancienne URL de téléchargement PDF).
SCHEDULE_PAGE_URL = "https://www.puydufou.com/france/fr/programme-du-jour"

# --- Ancienne source (PDF), conservée pour référence/repli mais plus ---
# --- utilisée par défaut (voir PuyDuFouScheduleSourceAdapter dans -------
# --- collector.py, adapter par défaut de Collector). --------------------

# Page qui déclenche le téléchargement du programme du jour. Le site peut
# répondre directement avec un PDF, ou avec une page HTML intermédiaire
# contenant un lien vers le PDF réel : le SourceAdapter (voir collector.py)
# gère les deux cas pour rester robuste à un changement de comportement du
# site officiel.
SOURCE_URL = "https://www.puydufou.com/france/fr/program-day/download-today"

# Le site publie aussi le programme du lendemain (disponible dès 17h30 la
# veille). Une seule collecte quotidienne suffit donc pour couvrir les deux
# jours (aujourd'hui + demain) en récupérant les deux PDF l'un après
# l'autre, plutôt que de dépendre d'un déclenchement matinal fiable — les
# workflows planifiés GitHub Actions peuvent être retardés de plusieurs
# heures (limite de la plateforme, pas de notre côté), donc collecter
# "demain" la veille au soir est plus robuste que d'attendre le matin même.
SOURCE_URL_TOMORROW = "https://www.puydufou.com/france/fr/program-day/download-tomorrow"

HTTP_TIMEOUT_SECONDS = 30
HTTP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# En-têtes additionnels envoyés avec chaque requête vers la source officielle.
# Certains WAF/anti-bot (Cloudflare, Akamai...) se basent aussi sur l'absence
# d'en-têtes "normaux" de navigateur (Accept, Accept-Language...) pour
# distinguer un script d'un navigateur réel, en plus du User-Agent.
HTTP_EXTRA_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Referer": "https://www.puydufou.com/france/fr",
}

# Proxy résidentiel (optionnel). Le WAF (CloudFront + AWS WAF) du site
# officiel bloque systématiquement toute IP d'hébergeur/datacenter, quel
# que soit le fournisseur, le pays ou la page visée (constaté sur les
# runners GitHub-hébergés, plusieurs IP de VPS OVH, et même en imitant
# l'empreinte TLS d'un vrai navigateur) : seule une IP résidentielle passe.
# Format attendu : "http://user:pass@host:port" (voir README/docs pour le
# fournisseur utilisé). Toujours fourni via variable d'environnement/secret
# CI — jamais en clair dans le code ou committé dans le dépôt.
# Non défini = aucun proxy utilisé (cas normal en local, où l'IP réelle du
# poste n'est pas bloquée).
HTTP_PROXY_URL = os.environ.get("COLLECTOR_PROXY_URL") or None

# Nombre de tentatives en cas d'erreur transitoire (403/429/5xx, timeout...)
# avant d'abandonner la collecte, avec un backoff exponentiel entre chaque
# essai. Certains blocages anti-bot sont ponctuels (limite de débit, run
# de vérification) et se résorbent après un court délai.
HTTP_MAX_ATTEMPTS = 3
HTTP_RETRY_BACKOFF_SECONDS = 5

# ---------------------------------------------------------------------------
# Catégories de spectacles
# ---------------------------------------------------------------------------
# Clé technique -> libellé d'affichage français. C'est la SEULE liste
# faisant autorité : le reste du code (normalizer, exporter, frontend)
# doit s'y référer plutôt que de coder des catégories en dur.
#
# Ces 3 catégories (+ "autre" en repli) sont les seules utilisées par le
# site officiel (vérifié sur la page de chaque spectacle) : pas de "Grand
# spectacle" ni d'"Animation" côté Puy du Fou, ce sont des catégories
# maison qu'on avait inventées — retirées pour rester fidèle à la source.
CATEGORIES: dict[str, str] = {
    "spectacle": "Spectacle",
    "spectacle_nocturne": "Spectacle nocturne",
    "spectacle_immersif": "Spectacle immersif",
    "autre": "Autre",
}

DEFAULT_CATEGORY = "autre"

# Une représentation est considérée "nocturne" (pour les statistiques et le
# badge NOCTURNE) si elle appartient à la catégorie spectacle_nocturne OU si
# son heure de début est postérieure ou égale à ce seuil.
NOCTURNAL_HOUR_THRESHOLD = 21  # 21h00

# ---------------------------------------------------------------------------
# Statuts
# ---------------------------------------------------------------------------

# Statut d'une collecte / d'une version de programme journalier (table `dates`)
DATE_STATUS_OK = "ok"
DATE_STATUS_ERROR = "error"
DATE_STATUS_STALE = "stale"  # collecte en erreur, anciennes données conservées
DATE_STATUS_PARTIAL = "partial"  # analysé mais avec des avertissements
# Hors saison (date en dehors de [start_date, end_date] d'une saison dont
# les dates sont connues) : aucune ligne `dates` n'est créée pour ce statut
# (voir Collector.collect), il n'apparaît que côté export (today.json) pour
# distinguer "le parc est fermé" d'une vraie erreur de collecte.
DATE_STATUS_OUT_OF_SEASON = "out_of_season"
# Fermeture ponctuelle EN saison (ex: événement privé, jour de maintenance) :
# contrairement à DATE_STATUS_OUT_OF_SEASON (déduit d'une plage de dates
# configurée dans data/seasons.json), celui-ci est constaté directement
# dans les données de la source pour CETTE date précise (voir
# schedule_json_parser.ParseResult.park_closed) — une ligne `dates` est
# bien créée, avec 0 représentation, pour garder une trace du fait "on a
# vérifié, le parc était fermé" plutôt que de laisser la date inconnue.
DATE_STATUS_CLOSED_DAY = "closed_day"

DATE_STATUSES = (
    DATE_STATUS_OK,
    DATE_STATUS_ERROR,
    DATE_STATUS_STALE,
    DATE_STATUS_PARTIAL,
    DATE_STATUS_OUT_OF_SEASON,
    DATE_STATUS_CLOSED_DAY,
)

# Statut d'une représentation individuelle (table `representations`)
# Pas de statut "annulé" : en pratique, le Puy du Fou supprime quasiment
# jamais un spectacle une fois le programme publié — ça n'arrivera presque
# jamais, ce n'est pas la peine de maintenir cette détection partout.
REPR_STATUS_SCHEDULED = "scheduled"
REPR_STATUS_COMPLET = "complet"
REPR_STATUS_EXCEPTIONNEL = "exceptionnel"
REPR_STATUS_UNKNOWN = "unknown"

REPR_STATUSES = (
    REPR_STATUS_SCHEDULED,
    REPR_STATUS_COMPLET,
    REPR_STATUS_EXCEPTIONNEL,
    REPR_STATUS_UNKNOWN,
)

# Statut de la table collection_logs
LOG_STATUS_RUNNING = "running"
LOG_STATUS_SUCCESS = "success"
LOG_STATUS_ERROR = "error"
LOG_STATUS_NO_CHANGE = "no_change"
LOG_STATUS_OUT_OF_SEASON = "out_of_season"  # collecte volontairement sautée (parc fermé)

# ---------------------------------------------------------------------------
# Divers
# ---------------------------------------------------------------------------

# Durée par défaut (minutes) utilisée pour la détection de conflits horaires
# quand une représentation n'a pas d'heure de fin explicite dans le
# programme officiel (jamais utilisée pour afficher un horaire : uniquement
# pour les calculs de superposition / plan optimal de visite).
DEFAULT_SHOW_DURATION_MINUTES = 25

TIMEZONE_NAME = "Europe/Paris"
