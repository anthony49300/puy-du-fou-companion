"""Tests du module src.pdf_parser (analyse texte -> représentations).

Ces tests n'utilisent aucun vrai fichier PDF : ils exercent directement
`parse_program_text` sur des extraits de texte représentatifs (voir
tests/fixtures.py), ce qui est possible car l'extraction PDF -> texte est
volontairement séparée de l'analyse texte -> données dans pdf_parser.py.
"""
from src import config, pdf_parser
from tests.fixtures import (
    CASE_VARIANTS_PROGRAM_TEXT,
    DISORDERED_PROGRAM_TEXT,
    INTERLEAVED_CONTINUOUS_PROGRAM_TEXT,
    NUMERIC_DATE_PROGRAM_TEXT,
    PROGRAM_WITH_EXCEPTIONNEL_TEXT,
    SIMPLE_PROGRAM_TEXT,
    TOMORROW_PDF_WITH_DIFFERENT_FOOTER_DATE_TEXT,
)


def test_extract_program_date_text_format():
    assert pdf_parser.extract_program_date(SIMPLE_PROGRAM_TEXT) == "2026-08-26"


def test_extract_program_date_numeric_format():
    assert pdf_parser.extract_program_date(NUMERIC_DATE_PROGRAM_TEXT) == "2026-08-29"


def test_extract_program_date_missing_returns_none():
    assert pdf_parser.extract_program_date("Aucune date ici") is None


def test_extract_program_date_prefers_header_over_footer_generation_date():
    """Cas réel du PDF 'demain' : le pied de page contient une date
    numérique de GÉNÉRATION du PDF (aujourd'hui), différente de la date du
    programme (demain, en tête de document au format texte) — c'est cette
    dernière qui doit l'emporter."""
    result = pdf_parser.extract_program_date(TOMORROW_PDF_WITH_DIFFERENT_FOOTER_DATE_TEXT)
    assert result == "2026-09-02"


def test_parse_simple_program_detects_all_representations():
    result = pdf_parser.parse_program_text(SIMPLE_PROGRAM_TEXT)
    assert result.date_found == "2026-08-26"
    # 6 spectacles, mais Le Mime et Les Vikings ont chacun 2 horaires -> 8
    assert len(result.representations) == 8


def test_parse_recognizes_hhmm_colon_time_format():
    result = pdf_parser.parse_program_text(SIMPLE_PROGRAM_TEXT)
    first = next(r for r in result.representations if "MIME" in r.name_raw.upper())
    assert first.start_time in ("09:45", "15:15")


def test_parse_computes_end_time_from_duration():
    """Une représentation ponctuelle n'a pas d'heure de fin explicite dans
    le programme réel (juste une durée en minutes) : elle est déduite."""
    result = pdf_parser.parse_program_text(SIMPLE_PROGRAM_TEXT)
    vikings = next(
        r for r in result.representations if "VIKINGS" in r.name_raw.upper() and r.start_time == "11:30"
    )
    assert vikings.end_time == "11:56"  # 11:30 + 26 minutes


def test_parse_detects_continuous_show():
    result = pdf_parser.parse_program_text(SIMPLE_PROGRAM_TEXT)
    continuous = next(r for r in result.representations if "RENAISSANCE" in r.name_raw.upper())
    assert continuous.is_continuous is True
    assert continuous.start_time == "21:00"
    assert continuous.end_time == "23:00"


def test_parse_detects_complet_status():
    result = pdf_parser.parse_program_text(SIMPLE_PROGRAM_TEXT)
    complets = [r for r in result.representations if r.status == config.REPR_STATUS_COMPLET]
    assert len(complets) == 1
    assert "SECRET DE LA LANCE" in complets[0].name_raw.upper()
    # L'annotation de statut est retirée du nom nettoyé.
    assert "COMPLET" not in complets[0].name_raw.upper()


def test_parse_handles_multiple_representations_of_same_show():
    result = pdf_parser.parse_program_text(SIMPLE_PROGRAM_TEXT)
    vikings = [r for r in result.representations if "VIKINGS" in r.name_raw.upper()]
    assert len(vikings) == 2
    assert {r.start_time for r in vikings} == {"11:30", "16:00"}


def test_parse_detects_exceptionnel_status():
    result = pdf_parser.parse_program_text(PROGRAM_WITH_EXCEPTIONNEL_TEXT)
    exceptionnel = next(r for r in result.representations if "TRIOMPHE" in r.name_raw.upper())
    assert exceptionnel.status == config.REPR_STATUS_EXCEPTIONNEL


def test_parse_source_text_preserved():
    result = pdf_parser.parse_program_text(SIMPLE_PROGRAM_TEXT)
    first = next(r for r in result.representations if "MIME" in r.name_raw.upper() and r.start_time == "09:45")
    assert "09:45" in first.source_text
    assert "MIME" in first.source_text.upper()


def test_parse_handles_multiline_show_name():
    """Cas où le nom du spectacle est réparti sur deux lignes (mise en
    page en colonne étroite)."""
    result = pdf_parser.parse_program_text(DISORDERED_PROGRAM_TEXT)
    names = {r.name_raw.upper() for r in result.representations}
    assert any("MIME" in n and "TOILE" in n for n in names)
    assert any("VIKINGS" in n for n in names)
    assert any("SIGNE" in n and "TRIOMPHE" in n for n in names)


def test_parse_interleaved_continuous_ranges_close_lifo():
    """Cas réel observé : une plage continue coupée sur plusieurs lignes
    est interrompue par l'ouverture d'une autre plage avant sa propre
    fermeture (artefact de tri par position dans le PDF). Les fermetures
    doivent s'apparier à l'ouverture la plus récente (comme des
    parenthèses imbriquées), pas à la plus ancienne (FIFO), sous peine
    d'inverser les deux plages."""
    result = pdf_parser.parse_program_text(INTERLEAVED_CONTINUOUS_PROGRAM_TEXT)
    renaissance = next(r for r in result.representations if "RENAISSANCE" in r.name_raw.upper())
    epee = next(r for r in result.representations if "ARTHUR" in r.name_raw.upper())
    assert renaissance.start_time == "09:30"
    assert renaissance.end_time == "12:00"
    assert renaissance.is_continuous is True
    assert epee.start_time == "10:15"
    assert epee.end_time == "10:37"  # horaire ponctuel : 10:15 + 22 minutes de durée
    assert epee.is_continuous is False


def test_parse_case_variants_produce_distinct_raw_names_but_same_cleanup_target():
    """Le parser produit les noms bruts ; c'est le normalizer (testé à part)
    qui garantit qu'ils convergent vers le même spectacle canonique."""
    result = pdf_parser.parse_program_text(CASE_VARIANTS_PROGRAM_TEXT)
    assert len(result.representations) == 3
    assert all("vikings" in r.name_raw.lower() for r in result.representations)


def test_parse_show_without_any_time_is_dropped_with_warning():
    text = """\
Programme du 31/08/2026

Spectacles
(1)
Durée

SPECTACLE SANS HORAIRE

LES RESTAURANTS
"""
    result = pdf_parser.parse_program_text(text)
    assert result.representations == []
    assert any("sans horaire" in w for w in result.warnings)
