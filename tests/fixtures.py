"""Extraits représentatifs du programme officiel du Puy du Fou, utilisés
comme fixtures dans plusieurs fichiers de tests.

Ces extraits reproduisent la structure RÉELLE du texte tel qu'extrait par
PyMuPDF depuis le PDF officiel (constatée sur le programme du 26/08/2026,
après filtrage de la colonne "restaurants" — voir
`pdf_parser.extract_text_from_pdf`) : pour chaque spectacle, le nom précède
la durée ("35'") qui précède les horaires au format "HH:MM". Ils NE
PROVIENNENT PAS d'une copie du document officiel : seule la structure et
les noms de spectacles (informations factuelles) sont repris, les horaires
et durées sont inventés pour couvrir les cas représentatifs (horaire
ponctuel, plage continue, plage continue coupée sur plusieurs lignes,
mise en page désordonnée, statuts particuliers).
"""
import json

# ---------------------------------------------------------------------------
# Fixtures pour schedule_json_parser (page "programme du jour")
# ---------------------------------------------------------------------------
# Reproduisent la structure RÉELLE du bloc <script
# data-drupal-selector="drupal-settings-json"> (clé `timelineSchedule`),
# constatée sur la page du 02/09/2026 : noms de spectacles préfixés d'un
# "<span class='entity-number'>N</span>", horaires en {"hour", "min"},
# durée en "Nminutes". Les identifiants ("wzobj:..."), horaires et durées
# sont inventés pour couvrir les cas représentatifs (horaire ponctuel avec
# plusieurs séances/jour, accès en continu "libre") ; seuls les noms de
# spectacles (informations factuelles) sont repris.
SAMPLE_TIMELINE_SCHEDULE = {
    # "2026-08-28" et "2026-08-29" sont dans dates_open (le site les
    # reconnaît) mais absentes de `events` (respectivement : clé absente,
    # et clé présente mais vide) : les deux variantes possibles d'une
    # fermeture ponctuelle EN saison (constatée par l'utilisateur comme
    # "Le Puy du Fou est fermé" sur la page officielle), à distinguer
    # d'une date simplement hors de la fenêtre de 3 jours (absente de
    # dates_open, voir tests correspondants).
    "dates_open": ["2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29"],
    "sections": {
        "wzobj:show1": "<span class='entity-number'>1</span>Le Signe du Triomphe",
        "wzobj:show2": "<span class='entity-number'>2</span>Les Vikings",
        "wzobj:libre1": "<span class='entity-number'>10</span>Le Premier Royaume",
    },
    "events": {
        "2026-08-26": {
            "wzobj:show1": {
                "duration": "35minutes",
                "times": [{"start": {"hour": "15", "min": "00"}, "end": {"hour": 15, "min": 35}}],
            },
            "wzobj:show2": {
                "duration": "26minutes",
                "times": [
                    {"start": {"hour": "10", "min": "15"}, "end": {"hour": 10, "min": 41}},
                    {"start": {"hour": "16", "min": "30"}, "end": {"hour": 16, "min": 56}},
                ],
            },
            "wzobj:libre1": {
                "duration": "18minutes",
                "times": [{"start": {"hour": "11", "min": "00"}, "end": {"hour": 17, "min": 0}}],
            },
        },
        "2026-08-27": {
            "wzobj:show1": {
                "duration": "35minutes",
                "times": [{"start": {"hour": "14", "min": "00"}, "end": {"hour": 14, "min": 35}}],
            },
        },
        "2026-08-29": {},
    },
    "time": "2026-08-26",
    "type": "show",
}


def build_schedule_html(timeline_schedule: dict) -> str:
    """Construit une page HTML minimale reproduisant la structure réelle
    (bloc <script data-drupal-selector="drupal-settings-json"> contenant
    `timelineSchedule`), pour tester schedule_json_parser sans dépendre
    d'une vraie page téléchargée."""
    settings = {"timelineSchedule": timeline_schedule}
    return (
        "<!DOCTYPE html><html><head>"
        '<script type="application/json" data-drupal-selector="drupal-settings-json">'
        + json.dumps(settings, ensure_ascii=False)
        + "</script></head><body></body></html>"
    )


SAMPLE_SCHEDULE_HTML = build_schedule_html(SAMPLE_TIMELINE_SCHEDULE)

HTML_WITHOUT_SETTINGS_JSON = "<!DOCTYPE html><html><head></head><body>Rien ici</body></html>"

# Structure minimale mais complète : en-tête de section, quelques
# spectacles à horaires ponctuels, un spectacle continu ("(2)"), un statut
# "complet" annoté dans le nom (cf. `_detect_status_and_clean_name` :
# aucun exemple réel de ce genre d'annotation n'a encore été observé dans
# le nouveau format, la détection par mot-clé est conservée par prudence).
SIMPLE_PROGRAM_TEXT = """\
MERCREDI 26 AOÛT 2026

Spectacles
(1)
Durée
Une fois le spectacle commencé les tribunes seront inaccessibles

LE MIME ET L'ÉTOILE
28'
09:45
15:15

LES VIKINGS
26'
11:30
16:00

LE SECRET DE LA LANCE (COMPLET)
29'
14:00

LE SIGNE DU TRIOMPHE
35'
15:15

LA RENAISSANCE DU CHÂTEAU (2)
30'
de 21:00 à 23:00

LES ORGUES DE FEU
10'
22:30

LES RESTAURANTS
LA TAVERNE
de 11:30 à 20:30
"""

PROGRAM_WITH_EXCEPTIONNEL_TEXT = """\
JEUDI 27 AOÛT 2026

Spectacles
(1)
Durée
Une fois le spectacle commencé les tribunes seront inaccessibles

LE MIME ET L'ÉTOILE
28'
09:45

LE SIGNE DU TRIOMPHE (EXCEPTIONNELLEMENT)
35'
15:15

LES ORGUES DE FEU
10'
22:30

LES RESTAURANTS
"""

# Mise en page "désordonnée" : le nom d'un spectacle est réparti sur deux
# lignes (comme "LE BAL DES OISEAUX" / "FANTÔMES" dans le programme réel).
DISORDERED_PROGRAM_TEXT = """\
VENDREDI 28 AOÛT 2026

Spectacles
(1)
Durée
Une fois le spectacle commencé les tribunes seront inaccessibles

LE MIME ET
L'ÉTOILE
28'
09:45

LES VIKINGS
26'
11:30

LE SIGNE DU
TRIOMPHE
35'
15:15

LES RESTAURANTS
"""

# Plage continue coupée sur plusieurs lignes et interrompue par
# l'ouverture d'une AUTRE plage avant sa propre fermeture — artefact de
# tri par position observé dans le vrai PDF (deux plages de "La
# Renaissance du Château" imbriquées avec le début de "L'Épée du Roi
# Arthur"). Vérifie l'appariement LIFO (parenthèses imbriquées) plutôt que
# FIFO.
INTERLEAVED_CONTINUOUS_PROGRAM_TEXT = """\
SAMEDI 29 AOÛT 2026

Spectacles
(1)
Durée
Une fois le spectacle commencé les tribunes seront inaccessibles

LA RENAISSANCE DU
CHÂTEAU (2)
30'
de 09:30
de
14:30
à
16:45
L'ÉPÉE DU ROI ARTHUR
22'
10:15
à 12:00

LES RESTAURANTS
"""

NUMERIC_DATE_PROGRAM_TEXT = """\
Programme du 29/08/2026

Spectacles
(1)
Durée

LE MIME ET L'ÉTOILE
28'
09:45

LES RESTAURANTS
"""

# Cas réel du PDF "demain" (téléchargé via download-tomorrow) : le pied de
# page contient une date numérique différente de celle du programme (la
# date de GÉNÉRATION du PDF, pas celle du programme) — le format texte en
# tête de document doit être prioritaire sur ce numérique du pied de page.
TOMORROW_PDF_WITH_DIFFERENT_FOOTER_DATE_TEXT = """\
MERCREDI 02 SEPTEMBRE 2026

Spectacles
(1)
Durée

LE MIME ET L'ÉTOILE
28'
09:45

LES RESTAURANTS
Programme français du Puy du Fou pour la journée du 2026-09-02 (Edité à 18:59 le 01/09/2026)
"""

CASE_VARIANTS_PROGRAM_TEXT = """\
DIMANCHE 30 AOÛT 2026

Spectacles
(1)
Durée

LES VIKINGS
26'
11:30

Les vikings
26'
16:00

les Vikings
26'
18:00

LES RESTAURANTS
"""
