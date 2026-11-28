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

  // Seuil à partir duquel un creux ENTRE deux séances propose "+ Ajouter
  // ici" (voir dayPlan.findFittingShowings) — les creux en bord de journée
  // (avant la première séance, après la dernière) sont toujours proposés,
  // sans ce seuil.
  var ADD_HERE_MIN_GAP_MIN = 20;

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
    var moment = plan ? plan.moment : "Jour";
    $("jourFormuleChip").textContent = moment + " ▾";
    // Desktop (voir .journee-aside, §2.7) : même formule, en ligne plutôt
    // qu'en panneau — un seul réglage, deux présentations.
    var asideSelect = $("jourFormuleAside");
    if (asideSelect) asideSelect.value = moment;
    var asideGate = $("jourGateAside");
    if (asideGate) asideGate.value = S.gate;
  }

  // Desktop (.journee-aside) : calendrier toujours visible, même panneau
  // que la chip "Date" mobile (voir jourDateCalendarWrap) — PDF.renderMiniCalendar
  // ne sait écrire que dans UN conteneur, donc on l'appelle deux fois.
  function renderDateCalendar() {
    PDF.renderMiniCalendar(
      "jourDateCalendarWrap", state.calendarPopup.year, state.calendarPopup.month, state.datesMap,
      state.dateStr, dayPlan.planDayCellInfo, selectDate, changeCalendarMonth
    );
    if ($("jourDateCalendarAside")) {
      PDF.renderMiniCalendar(
        "jourDateCalendarAside", state.calendarPopup.year, state.calendarPopup.month, state.datesMap,
        state.dateStr, dayPlan.planDayCellInfo, selectDate, changeCalendarMonth
      );
    }
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
   * Desktop (≥1100px, voir .journee-aside dans journee.html/style.css) :
   * panneau collant avec calendrier toujours visible (renderDateCalendar
   * s'en charge déjà), formule et réglages en ligne, entrée vers
   * l'assistant — jamais affiché en-dessous de 1100px (display:none), donc
   * sans incidence sur le mobile même si posé une seule fois ici.
   * -------------------------------------------------------------------- */
  function initDesktopAside() {
    var formuleSelect = $("jourFormuleAside");
    if (formuleSelect) {
      formuleSelect.addEventListener("change", function () {
        var plan = planCourant(state.dateStr);
        plan.moment = formuleSelect.value;
        sauver();
        renderFormuleChip();
      });
    }
    var gateInput = $("jourGateAside");
    if (gateInput) {
      gateInput.addEventListener("change", function () {
        S.gate = Math.max(0, +gateInput.value || 0);
        sauver();
        renderDay();
      });
    }
    var composeBtn = $("btnComposeAutoAside");
    if (composeBtn) composeBtn.addEventListener("click", composeAutomatically);
  }

  // Décalage sous le header (lui-même sticky) pour que le panneau collant
  // ne disparaisse pas dessous — même principe que .tab-bar (carnet.js) ou
  // .hour-nav (programme.js).
  function syncAsideStickyOffset() {
    var header = document.getElementById("site-header");
    var aside = document.querySelector(".journee-aside");
    if (aside) aside.style.top = (header ? header.offsetHeight : 0) + 16 + "px";
  }

  /* ----------------------------------------------------------------------
   * Réglages (feuille modale) : pour l'instant juste "Portes ouvertes".
   * -------------------------------------------------------------------- */
  function openSettingsSheet() {
    var dlg = PDF.openSheet(
      '<div class="sheet-drag-handle" aria-hidden="true"></div>' +
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
    var icon = PDF.icon("alert-triangle", "summary-line-icon");
    if (sev.overlaps > 0) {
      html += ' · <span class="text-danger summary-line-flag">' + icon + sev.overlaps + " chevauchement" + (sev.overlaps > 1 ? "s" : "") + "</span>";
    } else if (sev.tight > 0) {
      html += ' · <span class="text-warn summary-line-flag">' + icon + sev.tight + " enchaînement" + (sev.tight > 1 ? "s" : "") + " serré" + (sev.tight > 1 ? "s" : "") + "</span>";
    }
    el.innerHTML = html;
  }

  function renderOfficialStatus(dateStr) {
    var el = $("jour-official-status");
    el.textContent = "Chargement du programme officiel…";
    fetchRealDay(dateStr).then(function (dayData) {
      if (state.dateStr !== dateStr) return; // la date a changé entre-temps
      var slots = [];
      if (!dayData) {
        el.textContent = "Programme officiel pas encore publié pour cette date.";
      } else if (dayData.status === "closed_day" || dayData.status === "out_of_season") {
        el.textContent = "";
      } else {
        slots = dayPlan.realDayToSlots(dayData);
        if (!slots.length) {
          el.textContent = "Le programme officiel de cette date ne contient aucun horaire.";
        } else {
          var distinctSlugs = {};
          slots.forEach(function (s) { if (s.slug) distinctSlugs[s.slug] = true; });
          var nbSpectacles = Object.keys(distinctSlugs).length;
          el.innerHTML =
            PDF.icon("check", "status-ok-icon") + "Programme officiel chargé — " + nbSpectacles + " spectacle" + (nbSpectacles > 1 ? "s" : "") +
            ", " + slots.length + " séance" + (slots.length > 1 ? "s" : "") + ".";
        }
      }
      // Les alternatives "Changer de séance" dépendent de state.currentSlots,
      // résolu après coup (async) — un re-rendu du contenu (déjà affiché
      // sans elles, le fetch étant quasi toujours plus lent que ce premier
      // rendu) les fait apparaître dès qu'elles sont disponibles.
      state.currentSlots = slots;
      var plan = planCourant(dateStr);
      renderDayContent(plan);
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
    var nbSeances = state.currentSlots.length;
    var dateLabel = PDF.parseISODate(state.dateStr) ? PDF.parseISODate(state.dateStr).toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) : "";
    var chooseDesc = nbSeances
      ? "Parcourez les " + nbSeances + " séances du " + PDF.escapeHtml(dateLabel) + " et ajoutez-les d'un tap."
      : "Parcourez le programme officiel et ajoutez vos spectacles au fil de l'eau.";

    el.innerHTML =
      '<div class="journee-empty">' +
      "<h2>Votre journée est vide</h2>" +
      '<p class="text-muted">Comment voulez-vous la composer ?</p>' +
      '<div class="journee-choice-list">' +
      '<button type="button" class="journee-choice journee-choice--primary" id="btnComposeAuto">' +
      '<span class="journee-choice-icon" aria-hidden="true">' + PDF.icon("wand") + "</span>" +
      '<span class="journee-choice-body">' +
      '<span class="journee-choice-title">Composer automatiquement</span>' +
      '<span class="journee-choice-desc">Le plus de spectacles possible, ou seulement ceux que vous choisissez. Vous voyez le résultat avant de valider.</span>' +
      "</span>" +
      "</button>" +
      '<a class="journee-choice" id="linkChooseProgramme" href="programme.html">' +
      '<span class="journee-choice-icon" aria-hidden="true">' + PDF.icon("list") + "</span>" +
      '<span class="journee-choice-body">' +
      '<span class="journee-choice-title">Choisir dans le programme</span>' +
      '<span class="journee-choice-desc">' + chooseDesc + "</span>" +
      "</span>" +
      "</a>" +
      "</div>" +
      '<button type="button" class="link-button" id="btnAddManualLink">' + PDF.icon("plus") + "Ajouter un spectacle hors programme (Cinéscénie…)</button>" +
      "</div>";

    $("linkChooseProgramme").href = "programme.html?date=" + encodeURIComponent(state.dateStr);
    $("btnComposeAuto").addEventListener("click", composeAutomatically);
    $("btnAddManualLink").addEventListener("click", openManualAddSheet);
  }

  // Version minimale (mode "libre", sans aperçu ni annulation) : l'assistant
  // complet (modes précis/libre, aperçu avant application, annulation) est
  // prévu phase 5 de la refonte — remplacera cet appel direct.
  /* ----------------------------------------------------------------------
   * Assistant "Composer automatiquement" (feuille modale, voir §2.6 de la
   * refonte) : deux modes (libre par défaut / précis), aperçu en direct
   * avant application, jamais appliqué sans ce passage par l'aperçu —
   * l'ancien comportement (phase 2) appliquait buildAutoPlan directement.
   * -------------------------------------------------------------------- */
  function composeAutomatically() {
    if (!state.currentSlots.length) {
      PDF.toast("Programme officiel indisponible pour cette date : impossible de proposer un planning.");
      return;
    }
    openAssistantSheet();
  }

  function openAssistantSheet() {
    var plan = planCourant(state.dateStr);
    var continuousCount = state.currentSlots.filter(function (s) { return s.is_continuous; }).length;

    var distinctShows = {};
    state.currentSlots.forEach(function (s) {
      if (!s.is_continuous && s.slug && !distinctShows[s.slug]) distinctShows[s.slug] = { slug: s.slug, name: s.name, category: s.category };
    });
    var pickList = Object.keys(distinctShows).map(function (k) { return distinctShows[k]; }).sort(function (a, b) {
      var pa = a.category === "spectacle_immersif" ? 0 : 1;
      var pb = b.category === "spectacle_immersif" ? 0 : 1;
      return pa !== pb ? pa - pb : a.name.localeCompare(b.name, "fr");
    });

    var replaceNote = plan.items.length
      ? '<p class="text-warn">Remplacera les ' + plan.items.length + " spectacle" + (plan.items.length > 1 ? "s" : "") + " déjà dans votre journée.</p>"
      : "";

    // Sélection du mode "précis" suivie en JS (pas des <input type=checkbox>
    // natifs) : les chips s'activent au tap, voir .assistant-show-chip.
    var selected = {};

    var html =
      '<div class="sheet-drag-handle" aria-hidden="true"></div>' +
      '<div class="sheet-dialog-header">' +
      '<h2 id="assistant-sheet-title">Composer ma journée</h2>' +
      '<button type="button" class="icon-btn" data-act="close" aria-label="Fermer">' + PDF.icon("x") + "</button>" +
      "</div>" +
      '<div class="assistant-modes" role="radiogroup" aria-label="Mode de composition">' +
      '<label class="radio-card"><input type="radio" name="assistantMode" value="libre" checked>' +
      '<span class="radio-card-dot" aria-hidden="true"></span>' +
      "<span><strong>Le plus de spectacles possible</strong><br><span class=\"text-muted\">Une journée bien remplie, sans conflit.</span></span></label>" +
      '<label class="radio-card"><input type="radio" name="assistantMode" value="precis">' +
      '<span class="radio-card-dot" aria-hidden="true"></span>' +
      "<span><strong>Seulement ceux que je choisis</strong><br><span class=\"text-muted\">Je coche mes incontournables, l'app trouve les séances.</span></span></label>" +
      "</div>" +
      '<div id="assistantPickWrap" hidden>' +
      '<span class="text-muted" style="display:block;margin-bottom:0.4rem;font-size:0.78rem;letter-spacing:0.05em;text-transform:uppercase">Je veux voir</span>' +
      '<div class="assistant-shows" id="assistantPickList">' +
      pickList.map(function (s) {
        return '<button type="button" class="assistant-show-chip" data-show-chip="' + PDF.escapeHtml(s.slug) + '" aria-pressed="false">' + PDF.escapeHtml(s.name) + "</button>";
      }).join("") +
      "</div>" +
      "</div>" +
      '<p class="text-muted" id="assistantInfoLine"></p>' +
      replaceNote +
      '<div id="assistantPreview" aria-live="polite"></div>' +
      '<div style="display:flex;flex-direction:column;gap:0.4rem;margin-top:0.5rem">' +
      '<button type="button" class="btn" data-act="apply" style="width:100%">Appliquer à ma journée</button>' +
      '<span class="text-muted" style="text-align:center;font-size:0.8rem">Vous pourrez annuler juste après.</span>' +
      "</div>";

    var dlg = PDF.openSheet(html, { className: "assistant-sheet" });
    dlg.setAttribute("aria-labelledby", "assistant-sheet-title");

    var continuousNote = continuousCount === 0
      ? "Aucun accès continu ce jour-là."
      : continuousCount === 1
      ? "L’unique accès continu est toujours ajouté."
      : "Les " + continuousCount + " accès continus sont toujours ajoutés.";
    dlg.querySelector("#assistantInfoLine").textContent =
      continuousNote + " Portes " + S.gate + " min avant · formule " + (plan.moment || "Jour") + ".";

    function currentMode() { return dlg.querySelector('input[name="assistantMode"]:checked').value; }
    function selectedSlugs() { return Object.keys(selected).filter(function (k) { return selected[k]; }); }

    function updatePreview() {
      var mode = currentMode();
      dlg.querySelectorAll(".radio-card").forEach(function (card) {
        card.classList.toggle("is-selected", card.querySelector("input").value === mode);
      });
      dlg.querySelector("#assistantPickWrap").hidden = mode !== "precis";
      var previewEl = dlg.querySelector("#assistantPreview");
      if (mode === "libre") {
        var propose = dayPlan.buildAutoPlan(state.currentSlots, S.gate, []);
        var fixesDispo = state.currentSlots.filter(function (s) { return !s.is_continuous && s.start && s.end && s.status !== "complet"; }).length;
        var fixesRetenues = propose.filter(function (s) { return !s.is_continuous; }).length;
        var ecartees = fixesDispo - fixesRetenues;
        previewEl.innerHTML =
          '<div class="status-banner status-ok">' + PDF.icon("check") + "<span>Aperçu : " + propose.length + " spectacle" + (propose.length > 1 ? "s" : "") +
          (ecartees > 0 ? ", " + ecartees + " séance" + (ecartees > 1 ? "s" : "") + " incompatible" + (ecartees > 1 ? "s" : "") + " écartée" + (ecartees > 1 ? "s" : "") : ", aucun conflit") +
          ".</span></div>";
        return;
      }
      var mandatory = selectedSlugs();
      if (!mandatory.length) {
        previewEl.innerHTML = '<p class="text-muted">Choisissez au moins un spectacle.</p>';
        return;
      }
      var manques = dayPlan.analyserManques(mandatory, state.currentSlots, S.gate, [], state.catalogueBySlug);
      previewEl.innerHTML = !manques.length
        ? '<div class="status-banner status-ok">' + PDF.icon("check") + "<span>Aperçu : vos " + mandatory.length + " spectacle" + (mandatory.length > 1 ? "s" : "") +
          " tiennent tous, aucun conflit.</span></div>"
        : '<div class="status-banner status-warn">' + PDF.icon("alert-triangle") + "<span>" +
          manques.map(function (m) { return PDF.escapeHtml(m.name) + " ne peut pas être casé"; }).join(", ") + ".</span></div>";
    }

    dlg.querySelectorAll('input[name="assistantMode"]').forEach(function (r) { r.addEventListener("change", updatePreview); });
    dlg.querySelectorAll("[data-show-chip]").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var slug = chip.getAttribute("data-show-chip");
        selected[slug] = !selected[slug];
        chip.classList.toggle("is-selected", !!selected[slug]);
        chip.setAttribute("aria-pressed", String(!!selected[slug]));
        updatePreview();
      });
    });
    updatePreview();

    dlg.querySelector('[data-act="close"]').addEventListener("click", function () { dlg.close(); });
    dlg.querySelector('[data-act="apply"]').addEventListener("click", function () {
      var mode = currentMode();
      var mandatory = mode === "precis" ? selectedSlugs() : [];
      if (mode === "precis" && !mandatory.length) { PDF.toast("Cochez au moins un spectacle."); return; }
      var propose = dayPlan.buildAutoPlan(state.currentSlots, S.gate, mandatory);
      if (!propose.length) { PDF.toast("Aucune séance ne peut être proposée pour cette date."); return; }
      var previousItems = plan.items;
      plan.items = propose.map(function (s) {
        return {
          slug: s.slug, name: s.name, category: s.category,
          start: s.start, end: s.end, is_continuous: s.is_continuous, status: s.status, uid: PDF.carnetUid(),
        };
      });
      sauver();
      dlg.close();
      renderDay();
      PDF.toastUndo("Planning appliqué : " + propose.length + " spectacle" + (propose.length > 1 ? "s" : "") + ".", function () {
        plan.items = previousItems;
        sauver();
        renderDay();
      });
    });
  }

  function openManualAddSheet() {
    var dlg = PDF.openSheet(
      '<div class="sheet-drag-handle" aria-hidden="true"></div>' +
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

  /* ----------------------------------------------------------------------
   * Journée composée — timeline v2 (voir §2.5 de la refonte) :
   * - accès continu groupé en une ligne repliable (jamais "En continu"
   *   dans la colonne horaire, qui n'existe que pour les séances à heure
   *   fixe) ;
   * - cartes une ligne (heure de début en gras/accent, heure de fin petite
   *   et discrète, nom + "Portes ..." + badges), menu "..." fantôme
   *   ("Changer de séance"/"Supprimer", jamais de × rouge visible) ;
   * - lignes de marge entre deux séances consécutives (marche à pied),
   *   chevauchement réel marqué en rouge sur les deux cartes + "Autres
   *   séances" (voir dayPlan.conflitChevauchementAvec).
   * -------------------------------------------------------------------- */

  // Autres horaires connus du même spectacle ce jour-là (programme officiel
  // déjà en mémoire, voir state.currentSlots) — jamais l'horaire déjà choisi.
  function alternativesForSlug(slug, excludeStart) {
    return state.currentSlots.filter(function (s) {
      return s.slug === slug && !s.is_continuous && s.start && s.start !== excludeStart;
    });
  }

  // `autoShow`: visible dès le rendu (chevauchement réel ou séance estimée
  // non confirmée) — sinon replié, à révéler via "Changer de séance" dans
  // le menu "...". Jamais rendu pour un ajout manuel (pas de slug à comparer).
  function swapChipsBlockHtml(it, autoShow) {
    if (!it.slug) return "";
    var alternatives = alternativesForSlug(it.slug, it.start);
    var inner = alternatives.length
      ? '<div class="swap-chips-label">Autres séances</div><div class="chip-row">' +
        alternatives.map(function (s) {
          return '<button type="button" class="chip" data-swap-uid="' + it.uid + '" data-swap-start="' + s.start + '" data-swap-end="' + (s.end || "") + '">' +
            PDF.escapeHtml(PDF.formatTimeFR(s.start)) + "</button>";
        }).join("") + "</div>"
      : '<p class="text-muted" style="margin:0">Aucun autre horaire connu pour ce spectacle aujourd’hui.</p>';
    return '<div class="swap-chips" data-swap-for="' + it.uid + '"' + (autoShow ? "" : " hidden") + ">" + inner + "</div>";
  }

  // Menu "..." (ghost, 44px) : "Changer de séance" (seulement si un slug
  // existe — un ajout manuel n'a pas d'"autres séances" à proposer) et
  // "Supprimer" (toujours, avec annulation — voir deleteItem).
  function cardMenuHtml(it, opts) {
    opts = opts || {};
    var changerItem = opts.allowSwap && it.slug
      ? '<button type="button" class="nav-dropdown-link" data-menu-action="changer" data-uid="' + it.uid + '">Changer de séance</button>'
      : "";
    return (
      '<div class="nav-group nav-group--inline">' +
      '<button type="button" class="icon-btn card-menu-toggle" data-menu-toggle data-uid="' + it.uid + '" ' +
      'aria-haspopup="true" aria-expanded="false" aria-label="Actions pour ' + PDF.escapeHtml(it.name) + '">' + PDF.icon("more-horizontal") + "</button>" +
      '<div class="nav-dropdown" data-menu data-uid="' + it.uid + '">' +
      changerItem +
      '<button type="button" class="nav-dropdown-link" data-menu-action="supprimer" data-uid="' + it.uid + '">Supprimer</button>' +
      "</div>" +
      "</div>"
    );
  }

  function continuousRowHtml(items) {
    if (!items.length) return "";
    var names = items.map(function (it) { return it.name; }).join(", ");
    var detail = items.map(function (it) {
      var range = it.start && it.end ? '<div class="text-muted">' + PDF.escapeHtml(PDF.formatTimeFR(it.start)) + "–" + PDF.escapeHtml(PDF.formatTimeFR(it.end)) + "</div>" : "";
      return (
        '<div class="continuous-row-item">' +
        "<div><strong>" + PDF.escapeHtml(it.name) + "</strong>" + range + "</div>" +
        cardMenuHtml(it, { allowSwap: false }) +
        "</div>"
      );
    }).join("");
    return (
      '<div class="continuous-row-wrap">' +
      '<button type="button" class="continuous-row-toggle" data-continuous-toggle aria-expanded="false">' +
      '<span class="continuous-row-dot" aria-hidden="true"></span>' +
      '<span class="continuous-row-text">' +
      '<span class="continuous-row-title">Accès continu · ' + items.length + "</span>" +
      '<span class="continuous-row-subtitle">' + PDF.escapeHtml(names) + "</span>" +
      "</span>" +
      PDF.icon("chevron-down") +
      "</button>" +
      '<div class="continuous-row-detail" id="continuousDetail" hidden>' + detail + "</div>" +
      "</div>"
    );
  }

  function accessibleCardLabel(it, gateTime) {
    var parts = [PDF.formatTimeFR(it.start)];
    if (it.end) parts.push("à " + PDF.formatTimeFR(it.end));
    parts.push(it.name);
    if (gateTime) parts.push("portes " + PDF.formatTimeFR(gateTime));
    return parts.join(", ");
  }

  function fixedCardHtml(it, conflits) {
    var sev = dayPlan.severiteConflit(it, conflits);
    var autreConflit = sev === "error" ? dayPlan.conflitChevauchementAvec(it, conflits) : null;
    var cls = "day-card day-card--oneline" +
      (it.category === "spectacle_nocturne" ? " day-card--night" : "") +
      (autreConflit ? " day-card--danger" : "");
    var dotCls = "day-timeline-dot" + (autreConflit ? " is-danger" : sev === "warn" ? " is-warn" : "");
    var badges = it.slug
      ? PDF.representationBadges({ start: it.start, is_continuous: false, status: it.status || "scheduled" }, it.category)
      : '<span class="badge badge-default">Ajout manuel</span>';
    if (it.unconfirmed) badges += '<span class="badge badge-conflict-warn">Horaire non confirmé</span>';
    else if (it.estimated) badges += '<span class="badge badge-default">Estimé</span>';

    var gateTime = it.start ? dayPlan.minutesToHHMM(PDF.timeToMinutes(it.start) - S.gate) : null;
    var gateNote = gateTime
      ? '<div class="gate-note">' + PDF.icon("door") + " Portes " + PDF.escapeHtml(PDF.formatTimeFR(gateTime)) + "</div>"
      : "";
    var autoShowSwap = !!(autreConflit || it.unconfirmed);

    return (
      '<li class="day-timeline-item" aria-label="' + PDF.escapeHtml(accessibleCardLabel(it, gateTime)) + '">' +
      '<div class="day-timeline-time tnum"><span class="card-time-start">' + PDF.escapeHtml(PDF.formatTimeFR(it.start)) + "</span>" +
      (it.end ? '<span class="card-time-end">' + PDF.escapeHtml(PDF.formatTimeFR(it.end)) + "</span>" : "") + "</div>" +
      '<div class="day-timeline-rail"><span class="' + dotCls + '"></span></div>' +
      '<div class="' + cls + '">' +
      '<div class="day-card-main"><span class="day-card-name">' + PDF.escapeHtml(it.name) + '</span><div class="day-card-badges">' + badges + "</div></div>" +
      cardMenuHtml(it, { allowSwap: true }) +
      (autreConflit ? '<div class="day-card-conflict">Chevauche ' + PDF.escapeHtml(autreConflit.name) + "</div>" : "") +
      gateNote +
      swapChipsBlockHtml(it, autoShowSwap) +
      "</div>" +
      "</li>"
    );
  }

  function gapRowHtml(it, next) {
    if (it.is_continuous || !it.end || !next || next.is_continuous || !next.start) return "";
    var marge = dayPlan.margeMinutes(it, next);
    if (marge < 0) return ""; // vrai chevauchement : déjà signalé par day-card--danger, pas de ligne de marge
    var tendu = marge < S.gate;
    return (
      '<li class="day-gap-row"><div></div><div></div>' +
      '<div class="day-gap-note' + (tendu ? " is-warn" : "") + '">' + PDF.icon("walking") + " " +
      (tendu ? marge + " min pour rejoindre — enchaînement serré" : marge + " min de marge") +
      "</div></li>"
    );
  }

  // Libellé contextuel du panneau "+ Ajouter ici" une fois déplié — un creux
  // en bord de journée (avant la première séance / après la dernière) n'a
  // qu'une seule borne connue, l'autre reste ouverte.
  // "N min libres" pour un creux entre deux séances (on connaît sa durée
  // exacte) ; phrasé ouvert pour un creux en bord de journée (avant la
  // première séance/après la dernière), dont une seule borne est connue.
  function gapLabel(gap) {
    if (gap.gapMinutes != null) return gap.gapMinutes + " min libres";
    if (gap.end) return "Libre jusqu’à " + PDF.formatTimeFR(gap.end);
    if (gap.start) return "Libre à partir de " + PDF.formatTimeFR(gap.start);
    return "Libre";
  }

  function fittingCandidateRowHtml(c) {
    var meta = dayPlan.formatDureeHeuresMinutes(c.durationMinutes) + " · fin " + PDF.formatTimeFR(c.end);
    if (c.alreadyPlannedAt) meta += " · déjà prévu à " + PDF.formatTimeFR(c.alreadyPlannedAt);
    return (
      '<button type="button" class="fitting-candidate" data-add-fitting ' +
      'data-slug="' + PDF.escapeHtml(c.slug) + '" data-name="' + PDF.escapeHtml(c.name) + '" data-category="' + PDF.escapeHtml(c.category || "") + '" ' +
      'data-start="' + c.start + '" data-end="' + c.end + '">' +
      '<span class="fitting-candidate-time tnum">' + PDF.escapeHtml(PDF.formatTimeFR(c.start)) + "</span>" +
      '<span class="fitting-candidate-body">' +
      '<span class="fitting-candidate-name">' + PDF.escapeHtml(c.name) + "</span>" +
      '<span class="fitting-candidate-meta">' + PDF.escapeHtml(meta) + "</span>" +
      "</span>" +
      '<span class="fitting-candidate-add" aria-hidden="true">' + PDF.icon("plus") + "</span>" +
      "</button>"
    );
  }

  // Toujours déplié (pas de clic pour révéler) : un creux assez grand pour
  // qu'une séance y tienne entièrement mérite de le montrer directement.
  function gapRowWithAddHereHtml(gap) {
    var inner = gap.candidates.length
      ? '<span class="day-gap-addhere-label">' + PDF.escapeHtml(gapLabel(gap)) + " — ça tient :</span>" + gap.candidates.map(fittingCandidateRowHtml).join("")
      : '<span class="day-gap-addhere-label">Aucune séance ne tient entièrement dans ce créneau (' + PDF.escapeHtml(gapLabel(gap).toLowerCase()) + ").</span>";
    return '<li class="day-gap-row day-gap-row--addhere"><div></div><div></div><div class="day-gap-addhere">' + inner + "</div></li>";
  }

  function renderFilledDay(plan) {
    var el = $("jour-content");
    var continuous = plan.items.filter(function (it) { return it.is_continuous; });
    var allFixed = plan.items
      .filter(function (it) { return !it.is_continuous; })
      .sort(function (a, b) { return (a.start || "").localeCompare(b.start || ""); });
    var fixes = dayPlan.itemsFixesTries(plan.items);
    var conflits = dayPlan.detecterConflits(fixes, S.gate);
    var fittingGaps = dayPlan.findFittingShowings(plan.items, state.currentSlots, { gateMin: S.gate, minGapMin: ADD_HERE_MIN_GAP_MIN });
    var gapsByKey = {};
    fittingGaps.forEach(function (g) { gapsByKey[(g.afterUid || "") + "|" + (g.beforeUid || "")] = g; });

    var html = continuousRowHtml(continuous);
    html += '<ol class="day-timeline">';

    if (allFixed.length) {
      var edgeBefore = gapsByKey["|" + allFixed[0].uid];
      if (edgeBefore) html += gapRowWithAddHereHtml(edgeBefore);
    }

    allFixed.forEach(function (it, idx) {
      html += fixedCardHtml(it, conflits);
      var next = allFixed[idx + 1];
      if (next) {
        html += gapRowHtml(it, next);
        var mid = gapsByKey[it.uid + "|" + next.uid];
        if (mid) html += gapRowWithAddHereHtml(mid);
      } else {
        var edgeAfter = gapsByKey[it.uid + "|"];
        if (edgeAfter) html += gapRowWithAddHereHtml(edgeAfter);
      }
    });

    html += "</ol>";
    html += footerActionsHtml();
    el.innerHTML = html;
  }

  // Actions de bas de page (voir §2.5 de la refonte) : jamais sticky,
  // seulement pour une journée déjà composée (une journée vide propose
  // "Composer automatiquement"/"Choisir dans le programme" à la place,
  // voir renderEmptyState). Réutilise le menu "..." générique (voir
  // [data-menu-toggle]/[data-menu] dans initContentDelegation) avec
  // data-uid="footer" plutôt qu'un mécanisme séparé.
  function footerActionsHtml() {
    return (
      '<div class="season-select-row no-print" style="margin-top:1.25rem">' +
      '<button type="button" class="btn" data-footer-action="compose">Composer automatiquement</button>' +
      '<button type="button" class="btn btn-outline" data-footer-action="ics">Agenda .ics</button>' +
      '<div class="nav-group nav-group--inline">' +
      '<button type="button" class="icon-btn" data-menu-toggle data-uid="footer" aria-haspopup="true" aria-expanded="false" aria-label="Plus d’actions">' + PDF.icon("more-horizontal") + "</button>" +
      '<div class="nav-dropdown" data-menu data-uid="footer">' +
      '<button type="button" class="nav-dropdown-link" data-footer-action="save-visit">Enregistrer comme visite effectuée</button>' +
      '<button type="button" class="nav-dropdown-link" data-footer-action="print">Imprimer cette journée</button>' +
      '<button type="button" class="nav-dropdown-link" data-footer-action="clear">Vider la journée</button>' +
      "</div>" +
      "</div>" +
      "</div>"
    );
  }

  function closeAllCardMenus() {
    document.querySelectorAll("#jour-content [data-menu].open").forEach(function (m) { m.classList.remove("open"); });
    document.querySelectorAll('#jour-content [data-menu-toggle][aria-expanded="true"]').forEach(function (t) { t.setAttribute("aria-expanded", "false"); });
  }

  // Suppression immédiate mais annulable (toast "Annuler" quelques secondes)
  // — jamais de confirmation bloquante pour un geste aussi facilement
  // réversible (même principe que l'ancien onglet Journée de carnet.js).
  function deleteItem(uid) {
    var plan = planCourant(state.dateStr);
    var idx = -1;
    for (var i = 0; i < plan.items.length; i++) { if (plan.items[i].uid === uid) { idx = i; break; } }
    if (idx === -1) return;
    var removed = plan.items[idx];
    var removedAt = idx;
    plan.items.splice(idx, 1);
    sauver();
    renderDay();
    PDF.toastUndo(removed.name + " retiré de la journée.", function () {
      plan.items.splice(Math.min(removedAt, plan.items.length), 0, removed);
      sauver();
      renderDay();
    });
  }

  /* ----------------------------------------------------------------------
   * Actions de bas de page (Agenda .ics / Enregistrer comme visite /
   * Imprimer / Vider) — voir footerActionsHtml.
   * -------------------------------------------------------------------- */
  function exportIcs() {
    var plan = planCourant(state.dateStr);
    if (!plan.items.length) { PDF.toast("Cette journée est vide."); return; }
    var contenu = dayPlan.buildIcs(state.dateStr, plan.items, S.gate, new Date(), PDF.carnetUid);
    var blob = new Blob([contenu], { type: "text/calendar;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "journee-puy-du-fou-" + state.dateStr + ".ics";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    PDF.toast("Fichier .ics téléchargé — importez-le dans votre calendrier.");
  }

  function saveAsVisit() {
    var dateStr = state.dateStr;
    var plan = planCourant(dateStr);
    if (!plan.items.length) { PDF.toast("Cette journée est vide."); return; }
    var visite = S.visites.filter(function (v) { return v.date === dateStr; })[0];
    if (!visite) {
      visite = { date: dateStr, moment: plan.moment || "Jour", com: "", seen: {} };
      S.visites.push(visite);
    } else {
      visite.moment = plan.moment || visite.moment;
    }
    plan.items.forEach(function (it) {
      var key = it.slug || (PDF.CARNET_MANUAL_PREFIX + it.name);
      visite.seen[key] = (visite.seen[key] || 0) + 1;
    });
    S.visites.sort(function (a, b) { return a.date.localeCompare(b.date); });
    sauver();
    PDF.toast("Journée du " + PDF.formatDateFR(dateStr) + " ajoutée au carnet de visites.");
  }

  function clearDay() {
    var plan = planCourant(state.dateStr);
    if (!plan.items.length) return;
    var previousItems = plan.items;
    plan.items = [];
    sauver();
    renderDay();
    PDF.toastUndo("Journée vidée.", function () {
      plan.items = previousItems;
      sauver();
      renderDay();
    });
  }

  // Délégation unique sur #jour-content (régénéré en entier à chaque rendu,
  // voir renderFilledDay/renderEmptyState) : un seul listener posé une fois
  // dans init(), jamais réattaché, plutôt qu'un par carte/bouton éphémère.
  function initContentDelegation() {
    var el = $("jour-content");
    el.addEventListener("click", function (e) {
      var contToggle = e.target.closest("[data-continuous-toggle]");
      if (contToggle) {
        var detail = $("continuousDetail");
        var willOpen = detail.hidden;
        detail.hidden = !willOpen;
        contToggle.setAttribute("aria-expanded", String(willOpen));
        return;
      }

      var menuToggle = e.target.closest("[data-menu-toggle]");
      if (menuToggle) {
        var uid = menuToggle.getAttribute("data-uid");
        var menu = el.querySelector('[data-menu][data-uid="' + uid + '"]');
        var willOpenMenu = menu && !menu.classList.contains("open");
        closeAllCardMenus();
        if (willOpenMenu) { menu.classList.add("open"); menuToggle.setAttribute("aria-expanded", "true"); }
        return;
      }

      var menuAction = e.target.closest("[data-menu-action]");
      if (menuAction) {
        var action = menuAction.getAttribute("data-menu-action");
        var actionUid = menuAction.getAttribute("data-uid");
        closeAllCardMenus();
        if (action === "supprimer") deleteItem(actionUid);
        else if (action === "changer") {
          var swapBlock = el.querySelector('[data-swap-for="' + actionUid + '"]');
          if (swapBlock) swapBlock.hidden = !swapBlock.hidden;
        }
        return;
      }

      var swapBtn = e.target.closest("[data-swap-uid]");
      if (swapBtn) {
        var plan = planCourant(state.dateStr);
        var cible = plan.items.filter(function (x) { return x.uid === swapBtn.getAttribute("data-swap-uid"); })[0];
        if (!cible) return;
        cible.start = swapBtn.getAttribute("data-swap-start");
        cible.end = swapBtn.getAttribute("data-swap-end") || null;
        // On vient de choisir un horaire TIRÉ DU PROGRAMME OFFICIEL : ni
        // estimé ni non confirmé, quel que soit l'état précédent.
        delete cible.estimated;
        delete cible.unconfirmed;
        delete cible.confidence;
        sauver();
        renderDay();
        return;
      }

      var fittingBtn = e.target.closest("[data-add-fitting]");
      if (fittingBtn) {
        var planNow = planCourant(state.dateStr);
        var candidat = {
          slug: fittingBtn.getAttribute("data-slug"), name: fittingBtn.getAttribute("data-name"),
          category: fittingBtn.getAttribute("data-category") || null,
          start: fittingBtn.getAttribute("data-start"), end: fittingBtn.getAttribute("data-end"),
          is_continuous: false, status: "scheduled",
        };
        if (PDF.planItemExists(planNow, candidat)) { PDF.toast(candidat.name + " est déjà dans cette journée."); return; }
        candidat.uid = PDF.carnetUid();
        planNow.items.push(candidat);
        sauver();
        renderDay();
        PDF.toast(candidat.name + " ajouté à la journée.");
        return;
      }

      var footerBtn = e.target.closest("[data-footer-action]");
      if (footerBtn) {
        closeAllCardMenus();
        var footerAction = footerBtn.getAttribute("data-footer-action");
        if (footerAction === "compose") composeAutomatically();
        else if (footerAction === "ics") exportIcs();
        else if (footerAction === "save-visit") saveAsVisit();
        else if (footerAction === "print") window.print();
        else if (footerAction === "clear") clearDay();
      }
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest("[data-menu-toggle]") && !e.target.closest(".nav-dropdown[data-menu]")) closeAllCardMenus();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAllCardMenus();
    });
  }

  function renderDayContent(plan) {
    if (!plan.items.length) { renderEmptyState(); return; }
    renderFilledDay(plan);
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
    initDesktopAside();
    initContentDelegation();
    syncAsideStickyOffset();
    window.addEventListener("resize", syncAsideStickyOffset);

    Promise.all([fetchCatalogue(), fetchDatesMap()])
      .then(function () {
        setDate(initialDate());
        // "journee.html?date=...&assistant=1" : lien "Composer
        // automatiquement" depuis l'aside du Programme (voir programme.js)
        // quand le plan du jour est vide.
        if (new URLSearchParams(location.search).get("assistant") === "1") openAssistantSheet();
      })
      .catch(function (err) {
        PDF.renderErrorMessage($("jour-content"), "Impossible de charger le catalogue de spectacles (" + err.message + ").");
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
