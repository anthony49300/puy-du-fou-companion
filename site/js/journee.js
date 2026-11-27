/* =========================================================================
   journee.js — logique de la page "Ma journée" (planificateur de visite,
   rework "day-editor-v2" : page dédiée, remplace l'ancien onglet Journée
   de carnet.html). Lit/écrit le MÊME blob localStorage que carnet.js
   (plans, visites, réglages) — voir PDF.loadCarnetState/saveCarnetState,
   site/js/app.js — et partage toute la logique pure (conflits, planning
   automatique, export .ics) avec PDF.dayPlan, site/js/day-plan.js.
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;
  var dayPlan = PDF.dayPlan;

  function $(id) { return document.getElementById(id); }

  /* ----------------------------------------------------------------------
   * État persistant (partagé avec carnet.js) + état de page
   * -------------------------------------------------------------------- */
  var stockageOk = true;
  function charger() {
    try { return PDF.loadCarnetState(); }
    catch (e) { stockageOk = false; return null; }
  }
  function sauver() {
    try { PDF.saveCarnetState(S); }
    catch (e) { stockageOk = false; }
  }

  var S = charger() || PDF.carnetEtatInitial();
  if (!S.pass) S.pass = PDF.carnetEtatInitial().pass;
  if (S.gate == null) S.gate = 30;
  if (!S.plans) S.plans = {};
  if (!S.visites) S.visites = [];

  var state = {
    dateStr: null,
    catalogue: [], // [{slug, name, category}] triés par nom
    catalogueBySlug: {},
    datesMap: {}, // "2026-08-26" -> enregistrement dates.json
    realDayCache: {}, // "2026-08-26" -> payload today.json/history, ou null
    currentSlots: [], // dernier programme officiel chargé pour state.dateStr
    calendarPopup: { year: null, month: null }, // mois affiché par le calendrier de date
  };

  var dateDropdown = null;
  var formuleDropdown = null;

  function planCourant(dateStr) {
    if (!dateStr) return null;
    if (!S.plans[dateStr]) S.plans[dateStr] = { moment: "Jour", items: [] };
    return S.plans[dateStr];
  }

  /* ----------------------------------------------------------------------
   * Données : catalogue officiel + programme réel d'une date
   * -------------------------------------------------------------------- */
  function fetchCatalogue() {
    return PDF.fetchJSON("spectacles.json").then(function (data) {
      state.catalogue = (data.spectacles || [])
        .map(function (s) { return { slug: s.slug, name: s.name, category: s.category }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name, "fr"); });
      state.catalogueBySlug = {};
      state.catalogue.forEach(function (s) { state.catalogueBySlug[s.slug] = s; });
    });
  }

  function fetchDatesMap() {
    return PDF.fetchJSON("dates.json").then(function (data) {
      (data.dates || []).forEach(function (rec) { state.datesMap[rec.date] = rec; });
    });
  }

  // Résout toujours avec le payload (format today.json) de la date demandée,
  // ou null si indisponible (hors saison, hors période collectée, erreur
  // réseau, ou pas encore publiée) — jamais rejetée. Mis en cache par date.
  function fetchRealDay(dateStr) {
    if (Object.prototype.hasOwnProperty.call(state.realDayCache, dateStr)) {
      return Promise.resolve(state.realDayCache[dateStr]);
    }
    var promise;
    if (dateStr === PDF.isoDateToday()) {
      promise = PDF.fetchJSON("today.json").then(function (data) {
        return data.date === dateStr ? data : null;
      });
    } else if (state.datesMap[dateStr] != null) {
      promise = PDF.fetchJSON(PDF.historyJsonPath(dateStr, state.datesMap[dateStr].season_year));
    } else {
      promise = Promise.resolve(null);
    }
    return promise.catch(function () { return null; }).then(function (data) {
      state.realDayCache[dateStr] = data;
      return data;
    });
  }

  /* ----------------------------------------------------------------------
   * Chip "Date" (calendrier en panneau ancré desktop / feuille mobile,
   * voir .nav-dropdown) et chip "Formule"
   * -------------------------------------------------------------------- */
  function renderDateChip() {
    var d = PDF.parseISODate(state.dateStr);
    $("jourDateChip").textContent = d
      ? d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" }) + " ▾"
      : "Date ▾";
  }

  function renderFormuleChip() {
    var plan = planCourant(state.dateStr);
    $("jourFormuleChip").textContent = (plan ? plan.moment : "Jour") + " ▾";
  }

  function renderDateCalendar() {
    PDF.renderMiniCalendar(
      "jourDateCalendarWrap", state.calendarPopup.year, state.calendarPopup.month, state.datesMap,
      state.dateStr, dayPlan.planDayCellInfo, selectDate, changeCalendarMonth
    );
  }

  function selectDate(dateStr) {
    setDate(dateStr);
    if (dateDropdown) dateDropdown.close();
  }

  function changeCalendarMonth(delta) {
    var m = state.calendarPopup.month + delta, y = state.calendarPopup.year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    state.calendarPopup.month = m;
    state.calendarPopup.year = y;
    renderDateCalendar();
  }

  function setDate(dateStr) {
    state.dateStr = dateStr;
    state.calendarPopup.year = +dateStr.slice(0, 4);
    state.calendarPopup.month = +dateStr.slice(5, 7) - 1;
    renderDateChip();
    renderDateCalendar();
    renderDay();
  }

  function initFormuleChip() {
    $("jourFormuleDropdown").querySelectorAll("[data-formule]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var plan = planCourant(state.dateStr);
        plan.moment = btn.getAttribute("data-formule");
        sauver();
        renderFormuleChip();
        if (formuleDropdown) formuleDropdown.close();
      });
    });
  }

  /* ----------------------------------------------------------------------
   * Réglages (feuille modale) : pour l'instant juste "Portes ouvertes".
   * -------------------------------------------------------------------- */
  function openSettingsSheet() {
    var dlg = PDF.openSheet(
      "<h2>Réglages</h2>" +
      '<label for="jourGateInput">Portes ouvertes (minutes avant la séance)' +
      '<br><input type="number" id="jourGateInput" min="0" max="90" step="5" style="width:6rem"></label>' +
      '<div class="sheet-dialog-actions"><button type="button" class="btn" data-act="close">Fermer</button></div>'
    );
    var input = dlg.querySelector("#jourGateInput");
    input.value = S.gate;
    input.addEventListener("change", function () {
      S.gate = Math.max(0, +input.value || 0);
      sauver();
      renderDay();
    });
    dlg.querySelector('[data-act="close"]').addEventListener("click", function () { dlg.close(); });
  }

  /* ----------------------------------------------------------------------
   * Partage (identique à l'ancien bouton de carnet.js)
   * -------------------------------------------------------------------- */
  function initShareButton() {
    var btn = $("btnJourneeShare");
    btn.innerHTML = PDF.icon("share");
    btn.addEventListener("click", function () {
      var plan = planCourant(state.dateStr);
      if (!plan.items.length) { PDF.toast("Rien à partager : la journée est vide."); return; }
      var lignes = plan.items.slice().sort(function (a, b) {
        if (a.is_continuous && b.is_continuous) return 0;
        if (a.is_continuous) return -1;
        if (b.is_continuous) return 1;
        return (a.start || "").localeCompare(b.start || "");
      }).map(function (it) {
        return (it.is_continuous ? "En continu" : PDF.formatTimeFR(it.start)) + " — " + it.name;
      });
      var texte = "Ma journée au Puy du Fou (" + PDF.formatDateLongFR(state.dateStr) + ") :\n" + lignes.join("\n");
      if (navigator.share) {
        navigator.share({ title: "Ma journée au Puy du Fou", text: texte }).catch(function () { /* annulé par l'utilisateur */ });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(texte).then(
          function () { PDF.toast("Copié dans le presse-papiers."); },
          function () { PDF.toast("Impossible de copier automatiquement."); }
        );
      } else {
        PDF.toast("Partage non disponible sur ce navigateur.");
      }
    });
  }

  /* ----------------------------------------------------------------------
   * Rendu : bandeau fermeture, ligne de statut officiel, ligne résumé,
   * contenu de la journée.
   *
   * Le contenu (vide/rempli) est volontiers minimal à ce stade (phase 1 de
   * la refonte "day-editor-v2") : seuls l'en-tête compact (date/formule,
   * réglages, chargement auto du programme officiel) et la ligne résumé
   * sont la cible de cette phase. La vraie timeline (cartes une ligne,
   * accès continu groupé, menu "...", "Ajouter ici"...) arrive phase 2/3.
   * -------------------------------------------------------------------- */
  function renderClosedBanner(dateStr) {
    var record = state.datesMap[dateStr];
    var isClosed = record && (record.status === "closed_day" || record.status === "out_of_season");
    $("jour-closed-banner").innerHTML = isClosed
      ? '<div class="status-banner status-stale"><span aria-hidden="true">🚧</span><span>Le Puy du Fou est fermé le ' +
        PDF.escapeHtml(PDF.formatDateFR(dateStr)) + ".</span></div>"
      : "";
  }

  function renderSummaryLine(plan, fixes, conflits) {
    var el = $("jour-summary-line");
    if (!plan.items.length) { el.textContent = ""; return; }
    var parts = [plan.items.length + " spectacle" + (plan.items.length > 1 ? "s" : "")];
    if (fixes.length) parts.push(dayPlan.formatDureeHeuresMinutes(dayPlan.dureeTotaleMinutes(fixes)));
    var html = PDF.escapeHtml(parts.join(" · "));
    var sev = dayPlan.compterSeveriteConflits(conflits);
    if (sev.overlaps > 0) {
      html += ' · <span class="text-danger">⛔ ' + sev.overlaps + " chevauchement" + (sev.overlaps > 1 ? "s" : "") + "</span>";
    } else if (sev.tight > 0) {
      html += ' · <span class="text-warn">⚠ ' + sev.tight + " enchaînement" + (sev.tight > 1 ? "s" : "") + " serré" + (sev.tight > 1 ? "s" : "") + "</span>";
    }
    el.innerHTML = html;
  }

  function renderOfficialStatus(dateStr) {
    var el = $("jour-official-status");
    el.textContent = "Chargement du programme officiel…";
    fetchRealDay(dateStr).then(function (dayData) {
      if (state.dateStr !== dateStr) return; // la date a changé entre-temps
      if (!dayData) {
        state.currentSlots = [];
        el.textContent = "Programme officiel pas encore publié pour cette date.";
        return;
      }
      if (dayData.status === "closed_day" || dayData.status === "out_of_season") {
        state.currentSlots = [];
        el.textContent = "";
        return;
      }
      var slots = dayPlan.realDayToSlots(dayData);
      state.currentSlots = slots;
      if (!slots.length) {
        el.textContent = "Le programme officiel de cette date ne contient aucun horaire.";
        return;
      }
      var distinctSlugs = {};
      slots.forEach(function (s) { if (s.slug) distinctSlugs[s.slug] = true; });
      var nbSpectacles = Object.keys(distinctSlugs).length;
      el.textContent =
        "Programme officiel chargé — " + nbSpectacles + " spectacle" + (nbSpectacles > 1 ? "s" : "") +
        ", " + slots.length + " séance" + (slots.length > 1 ? "s" : "") + ".";
    });
  }

  /* ----------------------------------------------------------------------
   * Journée vide (voir §2.4 de la refonte) : composer automatiquement,
   * choisir dans le programme officiel (lien vers programme.html?date=...,
   * dont les boutons "+" ajoutent directement à CE plan — voir
   * PDF.addToPlan), ou ajouter un spectacle hors programme (feuille modale).
   * -------------------------------------------------------------------- */
  function renderEmptyState() {
    var el = $("jour-content");
    el.innerHTML =
      '<div class="empty-state journee-empty">' +
      '<div class="empty-icon" aria-hidden="true">🗓️</div>' +
      "<h2>Votre journée est vide</h2>" +
      '<p class="text-muted">Comment voulez-vous la composer ?</p>' +
      '<div class="card-grid">' +
      '<button type="button" class="card nav-card nav-card--primary" id="btnComposeAuto">' +
      "<h3>Composer automatiquement</h3>" +
      '<p>Le plus de spectacles possible, sans conflit d\'horaire.</p>' +
      "</button>" +
      '<a class="card nav-card" id="linkChooseProgramme" href="programme.html">' +
      "<h3>Choisir dans le programme</h3>" +
      "<p>Parcourez le programme officiel et ajoutez vos spectacles au fil de l'eau.</p>" +
      "</a>" +
      "</div>" +
      '<button type="button" class="link-button" id="btnAddManualLink">Ajouter un spectacle hors programme (Cinéscénie…)</button>' +
      "</div>";

    $("linkChooseProgramme").href = "programme.html?date=" + encodeURIComponent(state.dateStr);
    $("btnComposeAuto").addEventListener("click", composeAutomatically);
    $("btnAddManualLink").addEventListener("click", openManualAddSheet);
  }

  // Version minimale (mode "libre", sans aperçu ni annulation) : l'assistant
  // complet (modes précis/libre, aperçu avant application, annulation) est
  // prévu phase 5 de la refonte — remplacera cet appel direct.
  function composeAutomatically() {
    if (!state.currentSlots.length) {
      PDF.toast("Programme officiel indisponible pour cette date : impossible de proposer un planning.");
      return;
    }
    var propose = dayPlan.buildAutoPlan(state.currentSlots, S.gate, []);
    if (!propose.length) {
      PDF.toast("Aucune séance ne peut être proposée pour cette date.");
      return;
    }
    var plan = planCourant(state.dateStr);
    plan.items = propose.map(function (s) {
      return {
        slug: s.slug, name: s.name, category: s.category,
        start: s.start, end: s.end, is_continuous: s.is_continuous, status: s.status, uid: PDF.carnetUid(),
      };
    });
    sauver();
    renderDay();
    PDF.toast("Planning proposé : " + propose.length + " spectacle" + (propose.length > 1 ? "s" : "") + ".");
  }

  function openManualAddSheet() {
    var dlg = PDF.openSheet(
      "<h2>Ajouter un spectacle hors programme</h2>" +
      '<p class="text-muted">Ex : Cinéscénie, ou tout spectacle non couvert par la collecte officielle.</p>' +
      '<label for="jourManualName">Nom<br><input type="text" id="jourManualName" placeholder="Cinéscénie" style="width:100%"></label>' +
      '<div class="season-select-row" style="margin-top:0.75rem">' +
      '<label for="jourManualStart">Début<br><input type="time" id="jourManualStart" value="22:00"></label>' +
      '<label for="jourManualEnd">Fin<br><input type="time" id="jourManualEnd" value="23:40"></label>' +
      "</div>" +
      '<div class="sheet-dialog-actions">' +
      '<button type="button" class="btn btn-outline" data-act="cancel">Annuler</button>' +
      '<button type="button" class="btn" data-act="add">Ajouter</button>' +
      "</div>"
    );
    dlg.querySelector('[data-act="cancel"]').addEventListener("click", function () { dlg.close(); });
    dlg.querySelector('[data-act="add"]').addEventListener("click", function () {
      var name = dlg.querySelector("#jourManualName").value.trim();
      var start = dlg.querySelector("#jourManualStart").value;
      var end = dlg.querySelector("#jourManualEnd").value;
      if (!name || !start) { PDF.toast("Indiquez au moins un nom et une heure de début."); return; }
      var plan = planCourant(state.dateStr);
      var candidat = { slug: null, name: name, category: "autre", start: start, end: end || null, is_continuous: false };
      if (PDF.planItemExists(plan, candidat)) { PDF.toast(name + " est déjà dans cette journée à cet horaire."); return; }
      candidat.uid = PDF.carnetUid();
      plan.items.push(candidat);
      sauver();
      dlg.close();
      renderDay();
    });
  }

  // Placeholder minimal pour une journée déjà composée (remplacé par la
  // vraie timeline en phase 3 : accès continu groupé, cartes une ligne,
  // menu "...", "Ajouter ici"...).
  function renderFilledDayPlaceholder(plan) {
    var el = $("jour-content");
    var items = plan.items.slice().sort(function (a, b) {
      if (a.is_continuous && b.is_continuous) return 0;
      if (a.is_continuous) return -1;
      if (b.is_continuous) return 1;
      return (a.start || "").localeCompare(b.start || "");
    });
    el.innerHTML = "<ul class=\"day-timeline\">" + items.map(function (it) {
      return "<li>" + (it.is_continuous ? "En continu" : PDF.formatTimeFR(it.start)) + " — " + PDF.escapeHtml(it.name) + "</li>";
    }).join("") + "</ul>";
  }

  function renderDayContent(plan) {
    if (!plan.items.length) { renderEmptyState(); return; }
    renderFilledDayPlaceholder(plan);
  }

  function renderDay() {
    var dateStr = state.dateStr;
    var plan = planCourant(dateStr);
    renderFormuleChip();
    renderClosedBanner(dateStr);
    var fixes = dayPlan.itemsFixesTries(plan.items);
    var conflits = dayPlan.detecterConflits(fixes, S.gate);
    renderSummaryLine(plan, fixes, conflits);
    renderOfficialStatus(dateStr);
    renderDayContent(plan);
  }

  /* ----------------------------------------------------------------------
   * Démarrage
   * -------------------------------------------------------------------- */

  // "journee.html?date=2026-12-18" présélectionne cette date au lieu
  // d'aujourd'hui (même convention que l'ancien carnet.html?date=...).
  function initialDate() {
    var requested = new URLSearchParams(location.search).get("date");
    return requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PDF.isoDateToday();
  }

  function init() {
    initShareButton();
    $("btnJourneeSettings").innerHTML = PDF.icon("settings");
    $("btnJourneeSettings").addEventListener("click", openSettingsSheet);

    dateDropdown = PDF.initDropdownToggle($("jourDateChip"), $("jourDateDropdown"));
    formuleDropdown = PDF.initDropdownToggle($("jourFormuleChip"), $("jourFormuleDropdown"));
    initFormuleChip();

    Promise.all([fetchCatalogue(), fetchDatesMap()])
      .then(function () { setDate(initialDate()); })
      .catch(function (err) {
        PDF.renderErrorMessage($("jour-content"), "Impossible de charger le catalogue de spectacles (" + err.message + ").");
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
