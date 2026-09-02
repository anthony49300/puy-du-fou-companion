"""Extraction et analyse du programme officiel au format PDF.

Le module est volontairement séparé en deux couches :

1. `extract_text_from_pdf` : dépend de PyMuPDF (fitz) et transforme un
   fichier PDF en texte. Plusieurs stratégies sont tentées si la première
   ne produit pas un résultat exploitable, car l'ordre du texte extrait
   d'un PDF n'est PAS garanti (colonnes, tableaux, blocs positionnés
   librement...).

2. `parse_program_text` : pure logique texte -> données structurées, sans
   dépendance à PyMuPDF. Cette séparation permet de tester la logique de
   reconnaissance des horaires/spectacles avec de simples chaînes de
   caractères représentatives, sans avoir besoin de vrais fichiers PDF
   dans les tests (voir tests/test_parser.py).

Format réel observé (programme du 26/08/2026) : pour chaque spectacle, le
bloc de texte contient, dans cet ordre, le NOM (une ou deux lignes, en
majuscules), la DURÉE ("35'"), puis un ou plusieurs horaires au format
"HH:MM" (horaires ponctuels) ou une plage continue "de HH:MM à HH:MM"
(spectacles en "visite libre", marqués "(2)"). Ceci est très différent
d'un format "horaire d'abord" imaginé initialement ; `parse_program_text`
est écrit pour CE format réel.
"""
from __future__ import annotations

import re
from datetime import date as date_cls

from src import config
from src.models import ParseResult, ParsedRepresentation

# ---------------------------------------------------------------------------
# Extraction PDF -> texte (PyMuPDF)
# ---------------------------------------------------------------------------

# La colonne "Spectacles" (noms/durées/horaires) occupe la partie gauche de
# la page ; la partie droite contient une colonne d'icônes de restaurants
# sans rapport, qui se retrouve interclassée avec les horaires si on ne
# trie que par position verticale. On exclut cette colonne à l'extraction
# plutôt que d'essayer de la filtrer après coup dans le texte.
CONTENT_COLUMN_MAX_X0_RATIO = 0.45


def extract_text_from_pdf(pdf_path: str) -> tuple[str, str]:
    """Extrait le texte d'un PDF avec repli sur plusieurs stratégies.

    Retourne (texte, nom_de_la_stratégie_utilisée).

    Stratégie 1 ("blocks_filtered", prioritaire) : extraction par blocs
    positionnés, triés par position (y puis x), en ne retenant que ceux de
    la colonne de contenu principale (voir CONTENT_COLUMN_MAX_X0_RATIO).
    C'est la stratégie qui correspond à la mise en page réelle du
    programme officiel.
    Stratégie 2 ("text") : extraction "texte simple" page par page, dans
    l'ordre naturel de PyMuPDF — utile si la mise en page change et que
    la colonne de contenu n'est plus identifiable par position.
    Stratégie 3 ("blocks") : blocs positionnés SANS filtre de colonne.
    """
    try:
        import pymupdf as fitz  # nom d'import moderne de PyMuPDF (>=1.24)
    except ImportError:  # pragma: no cover - compat versions plus anciennes
        import fitz  # PyMuPDF historique

    # Import local (plutôt qu'en tête de module) pour ne pas exiger la
    # dépendance dans les environnements qui ne font qu'analyser du texte
    # déjà extrait (ex: tests unitaires de parse_program_text).

    doc = fitz.open(pdf_path)
    try:
        filtered_parts = []
        blocks_parts = []
        for page in doc:
            max_x0 = page.rect.width * CONTENT_COLUMN_MAX_X0_RATIO
            blocks = page.get_text("blocks")  # (x0, y0, x1, y1, text, block_no, ...)
            blocks_sorted = sorted(blocks, key=lambda b: (round(b[1], 1), round(b[0], 1)))
            for b in blocks_sorted:
                blocks_parts.append(b[4])
                if b[0] < max_x0:
                    filtered_parts.append(b[4])
        filtered_text = "\n".join(filtered_parts)
        if _looks_sufficiently_parsable(filtered_text):
            return filtered_text, "blocks_filtered"

        simple_text = "\n".join(page.get_text("text") for page in doc)
        if _looks_sufficiently_parsable(simple_text):
            return simple_text, "text"

        blocks_text = "\n".join(blocks_parts)
        if _looks_sufficiently_parsable(blocks_text):
            return blocks_text, "blocks"

        # Aucune stratégie idéale : on retourne la plus riche en horaires
        # détectés plutôt que d'échouer complètement.
        candidates = [
            (filtered_text, "blocks_filtered_fallback"),
            (blocks_text, "blocks_fallback"),
            (simple_text, "text_fallback"),
        ]
        return max(candidates, key=lambda c: len(TIME_RE.findall(c[0])))
    finally:
        doc.close()


def _looks_sufficiently_parsable(text: str) -> bool:
    """Heuristique : au moins quelques horaires "HH:MM"/"HHhMM" détectés."""
    return len(TIME_RE.findall(text)) >= 3


# ---------------------------------------------------------------------------
# Analyse du texte -> représentations structurées
# ---------------------------------------------------------------------------

# Horaire "HH:MM" (format observé dans le programme réel) ou "HHhMM"
# (repli, au cas où une autre page/version utiliserait ce séparateur).
TIME_RE = re.compile(r"(?P<h>\d{1,2})\s*[:hH]\s*(?P<m>\d{2})")

DURATION_LINE_RE = re.compile(r"^(?P<dur>\d{1,3})\s*['’]\s*(?P<rest>.*)$")

# Caractères pouvant introduire la fin d'une plage continue "de X ... Y" :
# "à" est la forme réelle observée ; les autres sont des variantes de
# tirets/séparateurs gardées par prudence (OCR, changement de police...).
# IMPORTANT : chaîne non-brute, pour que à soit bien interprété par
# Python (une chaîne brute laisserait l'échappement littéral, ce qui ferait
# échouer silencieusement toute reconnaissance de "à").
_CLOSER_CHARS = "à≈–—-"

FULL_CONTINUOUS_RE = re.compile(
    r"^de\s+(?P<sh>\d{1,2})[:h](?P<sm>\d{2})\s*[" + _CLOSER_CHARS + r"]+\s*"
    r"(?P<eh>\d{1,2})[:h](?P<em>\d{2})$",
    re.IGNORECASE,
)
DE_WITH_START_RE = re.compile(r"^de\s+(?P<h>\d{1,2})[:h](?P<m>\d{2})$", re.IGNORECASE)
DE_ALONE_RE = re.compile(r"^de$", re.IGNORECASE)
CLOSER_WITH_TIME_RE = re.compile(
    r"^[" + _CLOSER_CHARS + r"]+\s*(?P<h>\d{1,2})[:h](?P<m>\d{2})$", re.IGNORECASE
)
CLOSER_ALONE_RE = re.compile(r"^[" + _CLOSER_CHARS + r"]+$", re.IGNORECASE)

BARE_TIMES_LINE_RE = re.compile(r"^\d{1,2}[:h]\d{2}(\s+\d{1,2}[:h]\d{2})*$", re.IGNORECASE)

# "(2)" (seul sur sa ligne ou en suffixe d'un nom) marque un spectacle en
# "visite libre et en continu" (cf. note de bas de page du programme).
# "(1)" est la note générique ("le programme peut être modifié"), sans
# rapport avec la continuité : à ignorer.
INLINE_PAREN_SUFFIX_RE = re.compile(r"^(?P<base>.+?)\s*\(\s*(?P<num>[12])\s*\)\s*$")
STANDALONE_PAREN_RE = re.compile(r"^\(\s*(?P<num>[12])\s*\)$")

CONTINUOUS_KEYWORDS = (
    "en continu",
    "toute la journee",
    "toute la journée",
    "acces libre",
    "accès libre",
    "continu",
)

COMPLET_KEYWORDS = ("complet",)
EXCEPTIONNEL_KEYWORDS = ("exceptionnellement", "exceptionnel")

# Lignes de mise en page / notes légales à ignorer : ni un nom de
# spectacle, ni un horaire, elles ne doivent jamais démarrer ou polluer une
# entrée. Repérées par sous-chaîne (insensible à la casse) plutôt que par
# égalité stricte, pour tolérer de petites variations de ponctuation.
NOISE_LINE_SUBSTRINGS = (
    "une fois le spectacle",
    "nouveau spectacle",
    "reserve le droit",
    "réserve le droit",
    "visite libre et en continu",
    "susceptible de heurter",
    "traduction accessible",
    "audio-description accessible",
    "peuvent etre modifies",
    "peuvent être modifiés",
    "guide visiteur",
)

MONTHS_FR = {
    "janvier": 1, "fevrier": 2, "février": 2, "mars": 3, "avril": 4, "mai": 5,
    "juin": 6, "juillet": 7, "aout": 8, "août": 8, "septembre": 9,
    "octobre": 10, "novembre": 11, "decembre": 12, "décembre": 12,
}

DATE_TEXT_RE = re.compile(
    r"(?P<day>\d{1,2})\s*(?P<month>[A-Za-zéûîôâàè]+)\s*(?P<year>\d{4})", re.IGNORECASE
)
DATE_NUMERIC_RE = re.compile(r"(?P<day>\d{2})/(?P<month>\d{2})/(?P<year>\d{4})")


def extract_program_date(text: str, default: date_cls | None = None) -> str | None:
    """Cherche une date (jour programme officiel) dans le texte.

    Reconnaît "26 août 2026" et "26/08/2026". Retourne une date ISO
    "YYYY-MM-DD" ou None si rien n'est trouvé (le code appelant doit alors
    se rabattre sur la date demandée par l'utilisateur, en le signalant
    comme avertissement plutôt que comme certitude).

    Le format texte ("26 août 2026", en tête du document) est cherché
    AVANT le format numérique : le pied de page contient aussi une date
    numérique ("Edité à 18h02 le 01/09/2026"), qui est la date de
    GÉNÉRATION du PDF, pas celle du programme — pour le PDF "demain"
    (téléchargé via download-tomorrow), ces deux dates diffèrent, et
    matcher le numérique en premier renverrait la mauvaise date.
    """
    m = DATE_TEXT_RE.search(text)
    if m:
        month_key = m["month"].lower()
        month = MONTHS_FR.get(month_key)
        if month:
            return f"{m['year']}-{month:02d}-{int(m['day']):02d}"

    m = DATE_NUMERIC_RE.search(text)
    if m:
        return f"{m['year']}-{m['month']}-{m['day']}"
    return None


def _is_noise_line(line: str) -> bool:
    if line in ("Spectacles", "Durée"):
        return True
    lower = line.lower()
    if any(sub in lower for sub in NOISE_LINE_SUBSTRINGS):
        return True
    if STANDALONE_PAREN_RE.match(line) and STANDALONE_PAREN_RE.match(line)["num"] == "1":
        return True
    # Lettres isolées identifiant une icône de la colonne restaurants
    # (ex: "M", "X", "H"...). Toujours en MAJUSCULE dans le programme
    # réel : on ne filtre pas les lettres minuscules isolées pour ne pas
    # confondre avec le connecteur accentué "à" (fermeture de plage
    # continue), qui est en minuscule.
    if len(line) == 1 and line.isalpha() and line.isupper():
        return True
    return False


def _new_entry(first_name_part: str, *, continuous: bool = False) -> dict:
    return {
        "name_parts": [first_name_part],
        "duration": None,
        "sessions": [],
        "continuous": continuous,
        "awaiting": None,  # None | "start" | "close" (plage continue coupée sur plusieurs lignes)
    }


def _entry_is_complete(entry: dict | None) -> bool:
    return entry is not None and entry["duration"] is not None and len(entry["sessions"]) > 0


def parse_program_text(text: str, requested_date: str | None = None) -> ParseResult:
    """Analyse le texte du programme et extrait les représentations.

    Algorithme adapté au format réel : pour chaque spectacle, le nom
    précède la durée qui précède les horaires (voir docstring du module).
    Les horaires ponctuels ("HH:MM" seul) donnent chacun une
    représentation ; les plages continues ("de HH:MM à HH:MM", signalées
    par "(2)") donnent une représentation par plage. L'heure de fin d'une
    représentation ponctuelle est déduite de la durée du spectacle quand
    elle est disponible.

    Robustesse à la mise en page : une plage continue peut être scindée
    sur plusieurs lignes ("de" / "09:30" / ... / "à" / "12:00"), et cette
    coupure peut elle-même être interrompue par l'ouverture d'une AUTRE
    plage avant que la première ne se referme (artefact de tri par
    position dans le PDF). On empile donc les plages ouvertes et on
    referme la plus récemment ouverte à chaque marqueur de fermeture
    rencontré (comme des parenthèses imbriquées), plutôt que de supposer
    un ordre parfait.
    """
    warnings: list[str] = []
    date_found = extract_program_date(text)
    if date_found is None:
        warnings.append(
            "Date du programme introuvable dans le texte source ; "
            f"utilisation de la date demandée ({requested_date})."
        )

    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]

    entries: list[dict] = []
    current: dict | None = None
    open_stack: list[dict] = []
    in_section = False

    def flush() -> None:
        nonlocal current
        if current is not None and current["name_parts"] and current["sessions"]:
            entries.append(current)
        elif current is not None and current["name_parts"]:
            warnings.append(
                f"Spectacle {' '.join(current['name_parts'])!r} sans horaire détecté, ignoré."
            )
        current = None

    def add_point_time(h: str, m: str) -> None:
        assert current is not None
        current["sessions"].append({"start": f"{int(h):02d}:{m}", "end": None, "continuous": False})

    def open_continuous(h: str, m: str) -> None:
        assert current is not None
        sess = {"start": f"{int(h):02d}:{m}", "end": None, "continuous": True}
        current["sessions"].append(sess)
        open_stack.append(sess)
        current["continuous"] = True

    def close_most_recent(h: str, m: str) -> None:
        if open_stack:
            sess = open_stack.pop()
            sess["end"] = f"{int(h):02d}:{m}"
        else:
            warnings.append(
                f"Fermeture de plage continue ({int(h):02d}:{m}) sans ouverture correspondante."
            )

    for line in lines:
        if not in_section:
            if line == "Spectacles":
                in_section = True
            continue
        if line.lower() == "les restaurants":
            break
        if _is_noise_line(line):
            continue

        m = STANDALONE_PAREN_RE.match(line)
        if m and m["num"] == "2":
            if current is not None:
                current["continuous"] = True
            continue

        m = FULL_CONTINUOUS_RE.match(line)
        if m:
            if current is not None:
                current["sessions"].append({
                    "start": f"{int(m['sh']):02d}:{m['sm']}",
                    "end": f"{int(m['eh']):02d}:{m['em']}",
                    "continuous": True,
                })
                current["continuous"] = True
            continue

        m = DURATION_LINE_RE.match(line)
        if m and current is not None and current["duration"] is None and not current["sessions"]:
            current["duration"] = int(m["dur"])
            rest = m["rest"].strip()
            if rest and BARE_TIMES_LINE_RE.match(rest):
                for tm in TIME_RE.finditer(rest):
                    add_point_time(tm["h"], tm["m"])
            continue

        m = DE_WITH_START_RE.match(line)
        if m and current is not None:
            open_continuous(m["h"], m["m"])
            continue

        if DE_ALONE_RE.match(line) and current is not None:
            current["awaiting"] = "start"
            continue

        m = CLOSER_WITH_TIME_RE.match(line)
        if m:
            close_most_recent(m["h"], m["m"])
            continue

        if CLOSER_ALONE_RE.match(line) and current is not None:
            current["awaiting"] = "close"
            continue

        if BARE_TIMES_LINE_RE.match(line):
            times = list(TIME_RE.finditer(line))
            awaiting = current["awaiting"] if current is not None else None
            if awaiting == "start":
                open_continuous(times[0]["h"], times[0]["m"])
                current["awaiting"] = None
                for tm in times[1:]:
                    add_point_time(tm["h"], tm["m"])
            elif awaiting == "close":
                close_most_recent(times[0]["h"], times[0]["m"])
                current["awaiting"] = None
                for tm in times[1:]:
                    add_point_time(tm["h"], tm["m"])
            elif current is not None:
                for tm in times:
                    add_point_time(tm["h"], tm["m"])
            continue

        # Ligne restante : nom de spectacle (ou suite d'un nom sur
        # plusieurs lignes), avec suffixe "(1)"/"(2)" éventuel.
        base_line = line
        mark_continuous = False
        m = INLINE_PAREN_SUFFIX_RE.match(line)
        if m:
            base_line = m["base"].strip()
            if m["num"] == "2":
                mark_continuous = True

        if current is None or _entry_is_complete(current):
            flush()
            current = _new_entry(base_line, continuous=mark_continuous)
        else:
            current["name_parts"].append(base_line)
            if mark_continuous:
                current["continuous"] = True

    flush()

    if open_stack:
        warnings.append(
            f"{len(open_stack)} plage(s) horaire(s) continue(s) jamais refermée(s) "
            "(fin de document atteinte)."
        )

    representations = [rep for entry in entries for rep in _entry_to_representations(entry)]

    return ParseResult(
        date_found=date_found or requested_date,
        representations=representations,
        warnings=warnings,
        strategy_used="text",
    )


def _entry_to_representations(entry: dict) -> list[ParsedRepresentation]:
    name_raw = " ".join(entry["name_parts"])
    status, name_clean = _detect_status_and_clean_name(name_raw)
    duration = entry["duration"]

    representations = []
    for session in entry["sessions"]:
        start_time = session["start"]
        end_time = session["end"]
        is_continuous = session["continuous"] or entry["continuous"]
        if end_time is None and not is_continuous and duration:
            end_time = _add_minutes(start_time, duration)
        source_bits = [name_raw]
        if duration:
            source_bits.append(f"{duration}'")
        source_bits.append(start_time if end_time is None else f"{start_time}-{end_time}")
        representations.append(
            ParsedRepresentation(
                name_raw=name_clean,
                start_time=start_time,
                end_time=end_time,
                is_continuous=is_continuous,
                status=status,
                source_text=" ".join(source_bits),
            )
        )
    return representations


def _add_minutes(hhmm: str, minutes: int) -> str:
    h, m = (int(part) for part in hhmm.split(":"))
    total = (h * 60 + m + minutes) % (24 * 60)
    return f"{total // 60:02d}:{total % 60:02d}"


def _detect_status_and_clean_name(name: str) -> tuple[str, str]:
    """Détecte un statut particulier à partir du texte du nom.

    NB : aucun exemple réel de statut "complet" n'a encore été observé dans
    le nouveau format (nom d'abord, horaires "HH:MM") au moment de
    l'écriture de cette fonction — cette détection par mot-clé est reprise
    par prudence de l'ancien format mais n'est pas garantie de correspondre
    à la façon dont le site officiel signale ce statut aujourd'hui.
    À ajuster dès qu'un exemple réel sera observé.

    Pas de statut "annulé" : en pratique, un spectacle publié au programme
    officiel n'est quasiment jamais supprimé après coup, ça ne vaut pas la
    peine de maintenir cette détection (voir config.REPR_STATUSES).
    """
    status = config.REPR_STATUS_SCHEDULED
    lowered = name.lower()
    lowered_norm = (
        lowered.replace("é", "e").replace("è", "e").replace("ê", "e").replace("û", "u").replace("î", "i")
    )

    if any(kw in lowered_norm for kw in COMPLET_KEYWORDS):
        status = config.REPR_STATUS_COMPLET
    elif any(kw in lowered_norm for kw in EXCEPTIONNEL_KEYWORDS):
        status = config.REPR_STATUS_EXCEPTIONNEL

    name_clean = re.sub(r"\(.*?\)", "", name).strip()
    name_clean = re.sub(
        r"\b(complet|exceptionnellement|en continu)\b",
        "",
        name_clean,
        flags=re.IGNORECASE,
    ).strip(" -–—:")
    name_clean = re.sub(r"\s+", " ", name_clean).strip()
    if not name_clean:
        name_clean = name.strip()
    return status, name_clean
