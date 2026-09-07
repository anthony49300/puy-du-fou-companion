"""Tests du module src.schedule_json_parser (analyse de la page "programme
du jour" -> représentations), miroir de tests/test_parser.py pour la
source JSON structurée qui a remplacé le PDF par défaut (voir
src/collector.py, PuyDuFouScheduleSourceAdapter).
"""
from src import config, schedule_json_parser
from tests.fixtures import HTML_WITHOUT_SETTINGS_JSON, SAMPLE_SCHEDULE_HTML, build_schedule_html


def test_parse_extracts_all_representations_for_requested_date():
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-26")
    assert result.date_found == "2026-08-26"
    # Le Signe (1) + Les Vikings (2 séances) + Le Premier Royaume (1) = 4
    assert len(result.representations) == 4
    assert not result.warnings


def test_parse_strips_entity_number_prefix_from_name():
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-26")
    names = {r.name_raw for r in result.representations}
    assert "Les Vikings" in names
    assert not any("entity-number" in n or "<span" in n for n in names)


def test_parse_keeps_both_sessions_of_a_multi_slot_show():
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-26")
    vikings = [r for r in result.representations if r.name_raw == "Les Vikings"]
    assert {(r.start_time, r.end_time) for r in vikings} == {("10:15", "10:41"), ("16:30", "16:56")}
    assert all(not r.is_continuous for r in vikings)


def test_parse_detects_continuous_access_window_from_span_vs_duration():
    """Le Premier Royaume : durée de visite 18 minutes mais fenêtre
    d'accès 11h-17h (6h) -> accès en continu, pas une séance ponctuelle."""
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-26")
    royaume = next(r for r in result.representations if r.name_raw == "Le Premier Royaume")
    assert royaume.is_continuous is True
    assert (royaume.start_time, royaume.end_time) == ("11:00", "17:00")


def test_parse_does_not_flag_fixed_slot_as_continuous():
    """Le Signe du Triomphe : étendue du créneau == durée annoncée (35') -> séance ponctuelle."""
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-26")
    signe = next(r for r in result.representations if r.name_raw == "Le Signe du Triomphe")
    assert signe.is_continuous is False


def test_parse_all_representations_have_scheduled_status():
    """Aucun statut "complet"/"exceptionnel" n'existe dans cette source :
    toujours REPR_STATUS_SCHEDULED (voir docstring du module)."""
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-26")
    assert all(r.status == config.REPR_STATUS_SCHEDULED for r in result.representations)


def test_parse_different_date_on_same_page_returns_its_own_representations():
    """Une seule page couvre plusieurs dates : chacune doit rester isolée."""
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-27")
    assert result.date_found == "2026-08-27"
    assert len(result.representations) == 1
    assert result.representations[0].start_time == "14:00"


def test_parse_date_not_in_dates_open_returns_none_with_warning():
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-09-15")
    assert result.date_found is None
    assert result.representations == []
    assert result.warnings
    assert "2026-09-15" in result.warnings[0]
    assert result.park_closed is False


def test_parse_detects_closed_day_when_date_missing_from_events():
    """"2026-08-28" est dans dates_open mais absente de `events` (clé
    inexistante) : le parc est fermé ce jour-là, pas une anomalie."""
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-28")
    assert result.date_found == "2026-08-28"
    assert result.park_closed is True
    assert result.representations == []
    assert not result.warnings  # pas une anomalie : aucun avertissement à ce stade


def test_parse_detects_closed_day_when_events_entry_is_empty():
    """"2026-08-29" est dans dates_open ET dans `events`, mais avec un
    dictionnaire vide (deuxième variante possible d'une fermeture)."""
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-29")
    assert result.date_found == "2026-08-29"
    assert result.park_closed is True
    assert result.representations == []


def test_parse_open_day_is_not_flagged_as_closed():
    result = schedule_json_parser.parse_schedule_html(SAMPLE_SCHEDULE_HTML, "2026-08-26")
    assert result.park_closed is False


def test_parse_detects_closed_day_when_dates_open_is_entirely_empty_and_it_is_today():
    """Fermeture ponctuelle constatée en pratique (07/09/2026) : le widget
    ne liste ABSOLUMENT aucune date ouverte plutôt que de lister le jour
    avec des événements vides — uniquement interprété comme une fermeture
    quand c'est la date du jour (is_today=True)."""
    html = build_schedule_html({"dates_open": [], "events": {}, "sections": {}})
    result = schedule_json_parser.parse_schedule_html(html, "2026-09-07", is_today=True)
    assert result.date_found == "2026-09-07"
    assert result.park_closed is True
    assert result.representations == []
    assert not result.warnings  # pas une anomalie, comme l'autre variante de fermeture


def test_parse_extracts_next_opening_date_from_visible_closure_text():
    """"Prochaine ouverture le Jeudi 10 Septembre 2026" (texte visible, hors
    JSON) constaté sur la page pendant la fermeture du 07/09/2026."""
    html = build_schedule_html({"dates_open": [], "events": {}, "sections": {}})
    html = html.replace(
        "</body>",
        '<div class="next"> Prochaine ouverture le Jeudi 10 Septembre 2026</div></body>',
    )
    result = schedule_json_parser.parse_schedule_html(html, "2026-09-07", is_today=True)
    assert result.park_closed is True
    assert result.next_opening_date == "2026-09-10"


def test_parse_next_opening_date_is_none_when_absent():
    html = build_schedule_html({"dates_open": [], "events": {}, "sections": {}})
    result = schedule_json_parser.parse_schedule_html(html, "2026-09-07", is_today=True)
    assert result.park_closed is True
    assert result.next_opening_date is None


def test_parse_empty_dates_open_for_a_future_date_stays_unpublished_not_closed():
    """La même page vide, mais pour demain/après-demain (is_today=False) :
    reste "pas encore publié", pas une fermeture — l'absence de données ne
    prouve rien pour un jour qui n'est pas encore arrivé."""
    html = build_schedule_html({"dates_open": [], "events": {}, "sections": {}})
    result = schedule_json_parser.parse_schedule_html(html, "2026-09-08", is_today=False)
    assert result.date_found is None
    assert result.park_closed is False
    assert result.warnings


def test_parse_missing_settings_json_returns_none_with_warning():
    result = schedule_json_parser.parse_schedule_html(HTML_WITHOUT_SETTINGS_JSON, "2026-08-26")
    assert result.date_found is None
    assert result.representations == []
    assert result.warnings


def test_parse_malformed_json_in_settings_block_returns_none_with_warning():
    broken_html = '<script data-drupal-selector="drupal-settings-json">{not valid json</script>'
    result = schedule_json_parser.parse_schedule_html(broken_html, "2026-08-26")
    assert result.date_found is None
    assert result.warnings
