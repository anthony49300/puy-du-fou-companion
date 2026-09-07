"""Collecte du programme officiel du Puy du Fou.

Architecture :

- `SourceAdapter` est une interface abstraite responsable UNIQUEMENT de
  récupérer les octets bruts du programme (PDF) depuis la source officielle.
  Si le site change de méthode de diffusion (nouvelle URL, nouveau format,
  page intermédiaire différente...), il suffit d'adapter/remplacer cette
  classe sans toucher au reste du pipeline (parsing, validation, stockage).

- `Collector` orchestre : fetch -> sauvegarde brute -> hash -> extraction ->
  parsing -> normalisation -> validation -> écriture SQLite (ou dry-run).

Aucune donnée existante n'est jamais supprimée ou remplacée par du vide en
cas d'échec : voir `collect()` pour le détail de la gestion d'erreurs.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date as date_cls
from datetime import datetime
from datetime import timedelta
from functools import lru_cache
from pathlib import Path
from typing import Optional

from src import config, database, normalizer, pdf_parser, schedule_json_parser, season_config
from src.models import now_iso, today_paris


@dataclass
class FetchResult:
    content: bytes
    content_type: str  # "pdf" ou "html"
    source_url: str
    program_published_at: Optional[str] = None


class SourceAdapter:
    """Interface abstraite : ne fait que récupérer les octets du programme."""

    def fetch(self, target_date: date_cls) -> FetchResult:  # pragma: no cover - interface
        raise NotImplementedError


class PuyDuFouSourceAdapter(SourceAdapter):
    """Adapter pour la source officielle actuelle.

    Robustesse : la page `SOURCE_URL` peut soit répondre directement avec un
    PDF (Content-Type application/pdf ou octets commençant par %PDF), soit
    répondre avec une page HTML qui déclenche elle-même le téléchargement
    (lien vers un fichier .pdf, redirection JS, etc.). Les deux cas sont
    gérés ici pour ne pas dépendre d'une URL de PDF figée.
    """

    def __init__(self, source_url: str = config.SOURCE_URL, timeout: int = config.HTTP_TIMEOUT_SECONDS):
        self.source_url = source_url
        self.timeout = timeout

    def fetch(self, target_date: date_cls) -> FetchResult:
        import httpx

        headers = {"User-Agent": config.HTTP_USER_AGENT, **config.HTTP_EXTRA_HEADERS}
        client_kwargs = dict(follow_redirects=True, timeout=self.timeout, headers=headers)
        if config.HTTP_PROXY_URL:
            client_kwargs["proxy"] = config.HTTP_PROXY_URL
        with httpx.Client(**client_kwargs) as client:
            response = _get_with_retry(client, self.source_url)
            content = response.content
            content_type_header = response.headers.get("content-type", "")

            if self._is_pdf(content, content_type_header):
                return FetchResult(content=content, content_type="pdf", source_url=self.source_url)

            # Réponse HTML : on cherche un lien vers un PDF téléchargeable.
            pdf_url = self._find_pdf_link(content, str(response.url))
            if pdf_url is None:
                raise RuntimeError(
                    "Réponse de la source officielle non reconnue : ni PDF direct, "
                    "ni lien PDF trouvé dans la page HTML. Le site a peut-être changé "
                    "de structure (voir SourceAdapter.fetch)."
                )
            pdf_response = _get_with_retry(client, pdf_url)
            if not self._is_pdf(pdf_response.content, pdf_response.headers.get("content-type", "")):
                raise RuntimeError(f"Le lien trouvé ({pdf_url}) ne pointe pas vers un PDF valide.")
            return FetchResult(content=pdf_response.content, content_type="pdf", source_url=pdf_url)

    @staticmethod
    def _is_pdf(content: bytes, content_type_header: str) -> bool:
        return content[:5] == b"%PDF-" or "application/pdf" in content_type_header.lower()

    @staticmethod
    def _find_pdf_link(html_content: bytes, base_url: str) -> Optional[str]:
        from urllib.parse import urljoin

        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html_content, "html.parser")
        for tag in soup.find_all("a", href=True):
            href = tag["href"]
            if ".pdf" in href.lower() or "download" in href.lower():
                return urljoin(base_url, href)
        return None


class PuyDuFouScheduleSourceAdapter(SourceAdapter):
    """Adapter par défaut : récupère la page "programme du jour" (données
    structurées embarquées, voir schedule_json_parser.py) plutôt que le PDF.

    Une seule page (`SCHEDULE_PAGE_URL`) couvre toujours aujourd'hui, demain
    et après-demain : le `fetch` est donc identique quelle que soit la date
    demandée (`target_date` n'est même pas utilisé ici), seul le parsing
    filtre ensuite sur la date effectivement voulue. Combiné au cache
    ci-dessous, cela permet à `collect-daily` de ne faire qu'UNE requête
    réseau même quand plusieurs des 3 jours sont inconnus en même temps
    (ex: premier lancement, ou rattrapage après plusieurs jours sans run).
    """

    def __init__(self, source_url: str = config.SCHEDULE_PAGE_URL, timeout: int = config.HTTP_TIMEOUT_SECONDS):
        self.source_url = source_url
        self.timeout = timeout

    def fetch(self, target_date: date_cls) -> FetchResult:  # noqa: ARG002 - voir docstring
        return _cached_fetch_schedule_page(self.source_url, self.timeout)


@lru_cache(maxsize=8)
def _cached_fetch_schedule_page(source_url: str, timeout: int) -> FetchResult:
    """Requête réseau réelle, mise en cache le temps du process courant
    (même principe que `normalizer._load_known_spectacles` : voir
    `clear_schedule_fetch_cache` pour la vider, utile en test). Une seule
    invocation CLI (ex: `collect-daily`) peut appeler `Collector.collect()`
    plusieurs fois de suite pour des dates différentes ; comme ces dates
    proviennent toutes de la MÊME page, ce cache évite de la re-télécharger
    à chaque appel — le cache ne survit pas au process (nouvelle invocation
    CLI = nouvelle requête), donc pas de risque de données périmées d'un
    jour à l'autre.
    """
    import httpx

    headers = {"User-Agent": config.HTTP_USER_AGENT, **config.HTTP_EXTRA_HEADERS}
    client_kwargs = dict(follow_redirects=True, timeout=timeout, headers=headers)
    if config.HTTP_PROXY_URL:
        client_kwargs["proxy"] = config.HTTP_PROXY_URL
    with httpx.Client(**client_kwargs) as client:
        response = _get_with_retry(client, source_url)
        return FetchResult(content=response.content, content_type="html", source_url=source_url)


def clear_schedule_fetch_cache() -> None:
    """Vide le cache de `_cached_fetch_schedule_page` (tests, ou pour forcer
    une nouvelle requête réseau au sein d'un même process)."""
    _cached_fetch_schedule_page.cache_clear()


def _get_with_retry(client, url: str):
    """GET avec quelques tentatives en cas d'erreur transitoire.

    Certains blocages anti-bot (403/429) ou erreurs serveur (5xx) sont
    ponctuels et se résorbent après un court délai. On retente donc
    plusieurs fois avec un backoff exponentiel avant d'abandonner, et on
    enrichit le message d'erreur final avec des indices de diagnostic
    (statut, en-têtes du WAF éventuel, début du corps de la réponse) pour
    faciliter l'investigation sans avoir à reproduire l'appel.
    """
    import time

    import httpx

    last_exc: Exception | None = None
    for attempt in range(1, config.HTTP_MAX_ATTEMPTS + 1):
        try:
            response = client.get(url)
            response.raise_for_status()
            return response
        except httpx.HTTPStatusError as exc:
            last_exc = exc
            status = exc.response.status_code
            # Pas la peine de retenter une 404 ou autre erreur client
            # définitive : seuls le rate-limiting (429), les blocages
            # anti-bot ponctuels (403) et les erreurs serveur (5xx)
            # justifient une nouvelle tentative.
            retriable = status == 429 or status == 403 or status >= 500
            if not retriable or attempt == config.HTTP_MAX_ATTEMPTS:
                diag_headers = {
                    k: v
                    for k, v in exc.response.headers.items()
                    if k.lower() in ("server", "cf-ray", "cf-mitigated", "x-served-by", "via", "retry-after")
                }
                body_snippet = exc.response.text[:200].replace("\n", " ") if exc.response.text else ""
                raise RuntimeError(
                    f"{exc} (tentative {attempt}/{config.HTTP_MAX_ATTEMPTS}, "
                    f"en-têtes diagnostic={diag_headers or 'aucun'}, "
                    f"début de réponse={body_snippet!r})"
                ) from exc
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt == config.HTTP_MAX_ATTEMPTS:
                raise
        if attempt < config.HTTP_MAX_ATTEMPTS:
            time.sleep(config.HTTP_RETRY_BACKOFF_SECONDS * attempt)
    raise last_exc  # pragma: no cover - inatteignable, garde-fou


def compute_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def compute_content_hash(resolved: list[tuple]) -> str:
    """Hash déterministe du contenu structuré (spectacle, horaires, statut)
    d'un programme, indépendant de l'ordre d'extraction et des octets bruts
    du PDF source. Deux collectes du même programme officiel doivent
    produire le même hash même si le PDF source a été régénéré entre-temps.
    """
    import json

    canonical = sorted(
        (info.slug, rep.start_time, rep.end_time, rep.is_continuous, rep.status)
        for info, rep in resolved
    )
    return hashlib.sha256(json.dumps(canonical, ensure_ascii=False).encode("utf-8")).hexdigest()


_MAX_BACKFILL_DAYS = 60  # garde-fou : une date de réouverture mal lue/absurde ne doit pas créer des centaines de lignes


def _backfill_closed_range(conn, *, season_id: int, source_url: str, from_date: date_cls, until_date: date_cls) -> int:
    """Crée une version "closed_day" pour chaque date strictement entre
    `from_date` (déjà traitée par l'appelant, exclue ici) et `until_date`
    (date de réouverture annoncée, exclue), sauf si déjà résolue
    (ok/closed_day) — ne touche jamais un jour qui a de vraies données.

    Utilisé quand la page annonce "Prochaine ouverture le ..." pendant une
    fermeture (voir schedule_json_parser.ParseResult.next_opening_date) :
    on connaît alors le statut de toute la période d'un coup, sans attendre
    que chaque jour devienne "aujourd'hui" à son tour. Retourne le nombre
    de dates créées.
    """
    created = 0
    current = from_date + timedelta(days=1)
    steps = 0
    while current < until_date and steps < _MAX_BACKFILL_DAYS:
        date_str = current.isoformat()
        existing = database.get_active_date(conn, date_str)
        if existing is None or existing["status"] not in (config.DATE_STATUS_OK, config.DATE_STATUS_CLOSED_DAY):
            database.create_date_version(
                conn,
                date_str=date_str,
                season_id=season_id,
                source_url=source_url,
                source_file=None,
                source_hash=None,
                content_hash=None,
                retrieved_at=now_iso(),
                program_published_at=None,
                status=config.DATE_STATUS_CLOSED_DAY,
                warnings=[f'Fermeture déduite de l\'annonce "Prochaine ouverture le {until_date.isoformat()}" sur la page officielle.'],
            )
            created += 1
        current += timedelta(days=1)
        steps += 1
    return created


def save_raw(
    content: bytes, date_str: str, content_hash: str, *, extension: str = "pdf", raw_dir: Optional[Path] = None
) -> Path:
    directory = raw_dir or config.RAW_DIR
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{date_str}_{content_hash[:8]}.{extension}"
    path = directory / filename
    path.write_bytes(content)
    return path


@dataclass
class CollectOutcome:
    status: str  # config.DATE_STATUS_*
    date_str: str
    message: str
    spectacle_count: int = 0
    representation_count: int = 0
    warnings: list[str] | None = None
    date_id: Optional[int] = None
    dry_run_preview: Optional[list[dict]] = None


class Collector:
    def __init__(self, adapter: Optional[SourceAdapter] = None, db_path: Optional[Path] = None):
        self.adapter = adapter or PuyDuFouScheduleSourceAdapter()
        self.db_path = db_path

    def collect(self, target_date: Optional[date_cls] = None, *, dry_run: bool = False) -> CollectOutcome:
        target_date = target_date or today_paris()
        date_str = target_date.isoformat()

        with database.connect(self.db_path) as conn:
            log_id = database.log_collection_start(conn, self.adapter.source_url if hasattr(self.adapter, "source_url") else "")

            # Si au moins une saison a des dates d'ouverture/fermeture
            # connues (voir data/seasons.json, ou `set_season_dates`) et que
            # la date cible ne tombe dans la plage d'AUCUNE d'entre elles,
            # on ne tente même pas la récupération réseau : le parc est
            # simplement fermé, ce n'est pas une erreur de collecte. On
            # cherche par PLAGE de dates plutôt que par année calendaire de
            # la date cible : une saison peut chevaucher le nouvel an (ex:
            # "Noël au Puy du Fou" jusqu'en janvier), auquel cas une date de
            # janvier appartient à la saison de l'année précédente. Si
            # aucune saison n'a de dates renseignées, comportement inchangé
            # (on tente la collecte comme avant).
            season_config.sync_all_to_database(conn)
            dated_seasons = [s for s in database.list_seasons(conn) if s["start_date"] and s["end_date"]]
            if dated_seasons and database.get_season_for_date(conn, date_str) is None:
                windows = ", ".join(f"{s['year']}: {s['start_date']} -> {s['end_date']}" for s in dated_seasons)
                message = (
                    f"Hors saison : {date_str} ne tombe dans la période d'ouverture d'aucune "
                    f"saison connue ({windows})."
                )
                database.log_collection_finish(
                    conn, log_id, status=config.LOG_STATUS_OUT_OF_SEASON, message=message
                )
                return CollectOutcome(
                    status=config.DATE_STATUS_OUT_OF_SEASON, date_str=date_str, message=message
                )

            try:
                fetch_result = self.adapter.fetch(target_date)
            except Exception as exc:  # noqa: BLE001 - on veut capturer toute erreur réseau/parsing
                message = f"Échec de la récupération du programme officiel : {exc}"
                database.log_collection_finish(conn, log_id, status=config.LOG_STATUS_ERROR, message=message)
                # Règle d'or : on NE TOUCHE PAS aux données existantes.
                return CollectOutcome(status=config.DATE_STATUS_ERROR, date_str=date_str, message=message)

            raw_hash = compute_hash(fetch_result.content)

            is_html_source = fetch_result.content_type == "html"
            extension = "html" if is_html_source else "pdf"

            try:
                raw_path = None
                if not dry_run:
                    raw_path = save_raw(fetch_result.content, date_str, raw_hash, extension=extension)

                if is_html_source:
                    # Pas de fichier disque nécessaire : le parsing lit
                    # directement le contenu déjà en mémoire (contrairement
                    # au PDF, qui doit être ouvert par PyMuPDF depuis un
                    # vrai fichier — voir le repli dry-run ci-dessous).
                    html_text = fetch_result.content.decode("utf-8", errors="replace")
                    parse_result = schedule_json_parser.parse_schedule_html(
                        html_text, requested_date=date_str, is_today=(target_date == today_paris())
                    )
                    strategy = "drupal_settings_json"
                else:
                    pdf_path = raw_path
                    if pdf_path is None:
                        # En dry-run, on écrit tout de même le brut dans un
                        # fichier temporaire pour que PyMuPDF puisse l'ouvrir,
                        # mais on ne le conserve pas dans data/raw.
                        import tempfile

                        tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
                        tmp.write(fetch_result.content)
                        tmp.close()
                        pdf_path = Path(tmp.name)

                    text, strategy = pdf_parser.extract_text_from_pdf(str(pdf_path))
                    parse_result = pdf_parser.parse_program_text(text, requested_date=date_str)
            except Exception as exc:  # noqa: BLE001
                message = f"Échec de l'analyse du programme récupéré : {exc}"
                database.log_collection_finish(conn, log_id, status=config.LOG_STATUS_ERROR, message=message)
                return CollectOutcome(status=config.DATE_STATUS_ERROR, date_str=date_str, message=message)

            effective_date_str = parse_result.date_found or date_str
            warnings = list(parse_result.warnings)

            if effective_date_str != date_str:
                warnings.append(
                    f"La date extraite du programme ({effective_date_str}) diffère de la "
                    f"date demandée ({date_str}) ; les données sont enregistrées sous {effective_date_str}."
                )

            resolved = [
                (normalizer.resolve_spectacle(rep.name_raw), rep) for rep in parse_result.representations
            ]

            for info, _rep in resolved:
                if not info.known:
                    warnings.append(
                        f"Spectacle inconnu de la configuration, conservé tel quel : {info.name!r} "
                        f"(slug généré : {info.slug}). Ajoutez-le à data/known_spectacles.json si besoin."
                    )

            if not resolved:
                if parse_result.park_closed:
                    warnings.append(f"Le Puy du Fou est fermé le {effective_date_str}.")
                else:
                    warnings.append("Aucune représentation détectée dans le programme récupéré.")

            # Hash calculé sur le CONTENU STRUCTURÉ (représentations résolues),
            # pas sur les octets bruts du PDF : un PDF régénéré par le site
            # officiel peut différer octet pour octet (métadonnées, timestamps
            # internes...) sans que le programme lui-même ait changé. Comparer
            # le contenu structuré évite de créer une nouvelle version à
            # chaque collecte alors que rien n'a réellement changé.
            content_hash = compute_content_hash(resolved)

            if dry_run:
                database.log_collection_finish(
                    conn, log_id, status=config.LOG_STATUS_NO_CHANGE, message="dry-run : aucune écriture en base."
                )
                preview = [
                    {
                        "name": info.name,
                        "slug": info.slug,
                        "category": info.category,
                        "known": info.known,
                        "start": rep.start_time,
                        "end": rep.end_time,
                        "is_continuous": rep.is_continuous,
                        "status": rep.status,
                        "source_text": rep.source_text,
                    }
                    for info, rep in resolved
                ]
                return CollectOutcome(
                    status=config.DATE_STATUS_OK,
                    date_str=effective_date_str,
                    message=f"[dry-run] {len(resolved)} représentation(s) détectée(s), extraction stratégie={strategy}.",
                    spectacle_count=len({info.slug for info, _ in resolved}),
                    representation_count=len(resolved),
                    warnings=warnings,
                    dry_run_preview=preview,
                )

            if parse_result.park_closed:
                # Constaté sur la source (0 représentation, mais date bien
                # reconnue par le site) : normal, pas une anomalie — statut
                # dédié plutôt que "partial" (qui impliquerait un souci de
                # collecte) malgré la présence d'un avertissement.
                status = config.DATE_STATUS_CLOSED_DAY
            else:
                status = config.DATE_STATUS_PARTIAL if warnings else config.DATE_STATUS_OK

            # --- Écriture en base ---
            previous_hash = database.get_latest_hash(conn, effective_date_str)
            existing = database.get_active_date(conn, effective_date_str)
            # Le hash ne porte QUE sur les représentations résolues (voir
            # compute_content_hash) : deux collectes "0 représentation" ont
            # donc le MÊME hash que le jour soit "pas encore publié"
            # (partial) ou "confirmé fermé" (closed_day) — un changement de
            # statut à lui seul, sans changement de représentations, doit
            # quand même créer une nouvelle version, sinon la transition
            # partial -> closed_day (ou l'inverse) ne serait jamais
            # enregistrée.
            status_unchanged = existing is not None and existing["status"] == status
            if previous_hash == content_hash and status_unchanged:
                database.log_collection_finish(
                    conn, log_id, status=config.LOG_STATUS_NO_CHANGE,
                    message=(
                        f"Programme du {effective_date_str} inchangé (contenu identique à la version "
                        "précédente) : aucune nouvelle version créée."
                    ),
                )
                reps = database.get_representations_for_date_id(conn, existing["id"]) if existing else []
                return CollectOutcome(
                    status=existing["status"] if existing else config.DATE_STATUS_OK,
                    date_str=effective_date_str,
                    message="Programme inchangé depuis la dernière collecte.",
                    spectacle_count=len({r["spectacle_id"] for r in reps}),
                    representation_count=len(reps),
                    warnings=warnings,
                    date_id=existing["id"] if existing else None,
                )

            season_year = target_date.year
            # Si la date effective appartient à une autre année (ex: 31 déc /
            # 1er janvier), on rattache à l'année réelle de la date effective.
            try:
                season_year = int(effective_date_str[:4])
            except ValueError:
                pass
            season_id = database.get_or_create_season(conn, season_year)

            date_id, version = database.create_date_version(
                conn,
                date_str=effective_date_str,
                season_id=season_id,
                source_url=fetch_result.source_url,
                source_file=str(raw_path),
                source_hash=raw_hash,
                content_hash=content_hash,
                retrieved_at=now_iso(),
                program_published_at=fetch_result.program_published_at,
                status=status,
                warnings=warnings,
            )

            for info, rep in resolved:
                spectacle_id = database.get_or_create_spectacle(
                    conn, name=info.name, slug=info.slug, category=info.category
                )
                database.insert_representation(
                    conn,
                    date_id=date_id,
                    spectacle_id=spectacle_id,
                    start_time=rep.start_time,
                    end_time=rep.end_time,
                    is_continuous=rep.is_continuous,
                    status=rep.status,
                    source_text=rep.source_text,
                )

            backfilled = 0
            if parse_result.park_closed and parse_result.next_opening_date:
                try:
                    until_date = date_cls.fromisoformat(parse_result.next_opening_date)
                except ValueError:
                    until_date = None
                if until_date is not None:
                    backfilled = _backfill_closed_range(
                        conn, season_id=season_id, source_url=fetch_result.source_url,
                        from_date=date_cls.fromisoformat(effective_date_str), until_date=until_date,
                    )

            message = (
                f"Programme du {effective_date_str} enregistré (version {version}), "
                f"{len(resolved)} représentation(s), stratégie d'extraction={strategy}."
            )
            if backfilled:
                message += (
                    f" Fermeture annoncée jusqu'au {parse_result.next_opening_date} : "
                    f"{backfilled} jour(s) supplémentaire(s) marqué(s) fermé(s)."
                )
            database.log_collection_finish(conn, log_id, status=config.LOG_STATUS_SUCCESS, message=message)

            return CollectOutcome(
                status=status,
                date_str=effective_date_str,
                message=message,
                spectacle_count=len({info.slug for info, _ in resolved}),
                representation_count=len(resolved),
                warnings=warnings,
                date_id=date_id,
            )
