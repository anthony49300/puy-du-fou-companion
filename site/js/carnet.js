/* =========================================================================
   carnet.js — logique de la page "Mon carnet" (planificateur personnel,
   carnet de visites, bilan personnel, pass & budget).

   Tout ce qui est personnel (plans de journée, visites, réglages du pass)
   reste dans le localStorage de CE navigateur — rien n'est envoyé ni
   stocké côté serveur. En revanche, le catalogue de spectacles et les
   horaires proposés pour une date donnée viennent des vraies données déjà
   collectées (spectacles.json / today.json / history/{année}/{date}.json)
   plutôt que d'une liste maintenue à la main : ils restent donc à jour
   tout seuls au fil de la saison.
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  var MOIS = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
  ];
  // Clé pseudo-slug des ajouts manuels, forme par défaut de l'état et petits
  // widgets de dialogue (toast/confirmation) : partagés avec journee.js
  // (voir PDF.carnetEtatInitial/PDF.CARNET_MANUAL_PREFIX/PDF.toast*,
  // site/js/app.js) — les deux pages lisent/écrivent le même blob localStorage.
  var MANUAL_PREFIX = PDF.CARNET_MANUAL_PREFIX;

  var stockageOk = true;
  // Lecture/écriture déléguées à PDF (site/js/app.js) : même clé, même
  // forme de données, partagée avec le bouton "+" de l'accueil/Programme
  // (voir PDF.addToPlan). Le try/catch (et donc `stockageOk`) reste ici
  // plutôt que dans PDF.*, pour que chaque appelant garde la main sur sa
  // propre gestion d'erreur.
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
    catalogue: [], // [{slug, name, category}] triés par nom
    catalogueBySlug: {},
    datesMap: {}, // "2026-08-26" -> enregistrement dates.json (season_year, status, ...)
    realDayCache: {}, // "2026-08-26" -> payload today.json/history, ou null si indisponible
    currentRealSlots: [], // options actuellement proposées dans le select "programme officiel"
    currentVisit: null, // visite actuellement ouverte dans le panneau de détail (onglet Visites)
    autoPlanSlots: [], // horaires officiels proposés pour le panneau "planning automatique"
    planCalendar: { year: null, month: null }, // mois affiché par le calendrier de "Composer la journée"
    reconciledDates: {}, // "2026-08-26" -> true une fois réconciliée (voir reconcileEstimatedItems) : pas deux fois le même toast
    calendar: null, // data/json/calendar.json, résolu une fois (voir PDF.fetchCalendarOnce)
  };

  var uid = PDF.carnetUid;
  function eur(n) {
    return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  }
  // toast/toastUndo/confirmDialog : voir PDF.toast*/PDF.confirmDialog,
  // site/js/app.js (partagés avec journee.js, pas de logique dupliquée).
  var toast = PDF.toast;
  var toastUndo = PDF.toastUndo;
  var confirmDialog = PDF.confirmDialog;
  function $(id) { return document.getElementById(id); }

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
      // L'enregistrement complet (pas juste season_year) : le calendrier de
      // "Composer la journée" a aussi besoin du statut pour signaler les
      // jours de fermeture ponctuelle (voir planDayCellInfo).
      (data.dates || []).forEach(function (rec) { state.datesMap[rec.date] = rec; });
    });
  }

  // Toute date du calendrier (aujourd'hui, demain une fois publié...) ou de
  // l'historique (jours passés) déjà collectée peut être chargée dans
  // "Journée" — pas seulement aujourd'hui/demain. On rend ça visible via la
  // liste suggérée du champ date (list="planDates") et un texte d'aide.
  function populerDatesConnues() {
    var dates = Object.keys(state.datesMap).sort();
    var hint = $("planDatesHint");
    if (hint) {
      hint.textContent = dates.length
        ? "Programme officiel disponible du " + PDF.formatDateFR(dates[0]) + " au " + PDF.formatDateFR(dates[dates.length - 1]) +
          " (" + dates.length + " jour" + (dates.length > 1 ? "s" : "") + ", mis en évidence dans le calendrier ci-dessus)."
        : "Aucun programme officiel collecté pour le moment : le calendrier reste utilisable pour un plan manuel.";
    }
  }

  // Retourne une Promise résolue avec le payload (format today.json) de la
  // date demandée, ou null si indisponible (hors saison, hors période
  // collectée, ou erreur réseau) — jamais rejetée.
  function fetchRealDay(dateStr) {
    if (Object.prototype.hasOwnProperty.call(state.realDayCache, dateStr)) {
      return Promise.resolve(state.realDayCache[dateStr]);
    }
    var promise;
    if (dateStr === PDF.isoDateToday()) {
      // today.json peut retomber sur la dernière date fiable connue si la
      // collecte du jour a échoué : on vérifie que c'est bien CETTE date.
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

  // realDayToSlots/probableToSlots : voir PDF.dayPlan, site/js/day-plan.js
  // (partagées avec journee.js).
  var realDayToSlots = PDF.dayPlan.realDayToSlots;
  var probableToSlots = PDF.dayPlan.probableToSlots;

  // Tente une estimation pour une date sans programme officiel (voir
  // btnLoadReal) : résout toujours (jamais rejetée), même sans résultat.
  function loadProbableSlots(dateStr) {
    return Promise.all([PDF.fetchScheduleIndexOnce(), PDF.fetchCalendarOnce()]).then(function (results) {
      var index = results[0];
      state.calendar = results[1];
      var probable = index ? PDF.scheduleStats.probableProgramme(index, state.calendar, dateStr) : null;
      if (!probable || !probable.spectacles.length) {
        populerSelectReel([]);
        toast("Aucune donnée officielle ni estimation fiable pour cette date : ajoutez manuellement si besoin.");
        return;
      }
      var slots = probableToSlots(probable);
      populerSelectReel(slots);
      toast(
        slots.length + " horaire(s) estimé(s) (" + Math.round(
          probable.spectacles.reduce(function (sum, s) { return sum + s.confidence; }, 0) / probable.spectacles.length * 100
        ) + "% de confiance moyenne) — programme officiel pas encore publié."
      );
    });
  }

  /* ----------------------------------------------------------------------
   * Onglets
   * -------------------------------------------------------------------- */

  // "jour" (clé interne historique) correspond à l'ancre "#journee" dans
  // l'URL (voir site/js/app.js, NAV_PRIMARY) : la barre de nav du site
  // pointe vers carnet.html#journee/#visites/#bilan/#pass pour cibler
  // directement un onglet, et doit elle-même rester en phase quand on
  // change d'onglet ICI, d'où la mise à jour du hash ci-dessous.
  var TAB_TO_HASH = { jour: "journee", visites: "visites", bilan: "bilan", pass: "pass" };

  function switchTab(tab) {
    document.querySelectorAll("#carnet-tabs .tab").forEach(function (b) {
      var active = b.getAttribute("data-tab") === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      // Roving tabindex (pattern ARIA tablist) : seul l'onglet actif est
      // atteignable par Tab, les flèches gauche/droite font le reste.
      b.setAttribute("tabindex", active ? "0" : "-1");
    });
    ["jour", "visites", "bilan", "pass"].forEach(function (name) {
      $("tab-" + name).hidden = name !== tab;
    });
    if (tab === "visites") renderVisites();
    if (tab === "bilan") renderBilan();
    if (tab === "pass") renderPass();
    var hash = "#" + TAB_TO_HASH[tab];
    if (location.hash !== hash && history.replaceState) {
      history.replaceState(null, "", hash);
    }
  }

  // Permet à un lien externe (nav du site, favori, partage) de cibler un
  // onglet précis via carnet.html#journee|visites|bilan|pass.
  var HASH_TO_TAB = { journee: "jour", visites: "visites", bilan: "bilan", pass: "pass" };

  function tabFromHash() {
    var key = (location.hash || "").replace(/^#/, "");
    return HASH_TO_TAB[key] || null;
  }

  // N'applique le hash qu'une fois le catalogue chargé (voir init()) :
  // renderVisites/renderBilan/renderPass lisent state.catalogue, encore
  // vide avant la résolution de fetchCatalogue() — y arriver plus tôt via
  // le hash figerait un onglet sans ses colonnes, jamais corrigé ensuite
  // (rien ne rappelle ces render* une fois les données arrivées, en
  // dehors d'un changement d'onglet explicite).
  function initTabRouting() {
    window.addEventListener("hashchange", function () {
      var tab = tabFromHash();
      if (tab) switchTab(tab);
    });
  }

  function applyInitialHashTab() {
    var initial = tabFromHash();
    if (initial) switchTab(initial);
  }

  // Déplace le focus et active l'onglet ciblé par les flèches — Gauche/
  // Droite cyclent, Home/Fin vont aux extrémités (pattern ARIA tablist
  // "activation automatique" : la flèche change l'onglet affiché, pas
  // seulement le focus).
  function initTabKeyboardNav() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll("#carnet-tabs .tab"));
    tabs.forEach(function (tabBtn, i) {
      tabBtn.addEventListener("keydown", function (e) {
        var targetIndex = null;
        if (e.key === "ArrowRight") targetIndex = (i + 1) % tabs.length;
        else if (e.key === "ArrowLeft") targetIndex = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === "Home") targetIndex = 0;
        else if (e.key === "End") targetIndex = tabs.length - 1;
        if (targetIndex == null) return;
        e.preventDefault();
        tabs[targetIndex].focus();
        switchTab(tabs[targetIndex].getAttribute("data-tab"));
      });
    });
  }

  // Décalage sous le header (lui-même sticky, voir style.css) pour que la
  // barre d'onglets collante sur mobile ne disparaisse pas dessous.
  function syncStickyOffsets() {
    var header = document.getElementById("site-header");
    var tabs = $("carnet-tabs");
    if (tabs) tabs.style.top = (header ? header.offsetHeight : 0) + "px";
  }

  /* ----------------------------------------------------------------------
   * Onglet Journée
   * -------------------------------------------------------------------- */

  function planCourant(dateStr) {
    if (!dateStr) return null;
    if (!S.plans[dateStr]) S.plans[dateStr] = { moment: "Jour", items: [] };
    return S.plans[dateStr];
  }

  // Conflits, génération automatique, calendrier : voir PDF.dayPlan,
  // site/js/day-plan.js (partagés avec journee.js, pas de logique dupliquée).
  function itemsFixesTries(plan) { return PDF.dayPlan.itemsFixesTries(plan.items); }
  var detecterConflits = PDF.dayPlan.detecterConflits;
  var severiteConflit = PDF.dayPlan.severiteConflit;
  var planItemExists = PDF.planItemExists;
  var buildAutoPlan = PDF.dayPlan.buildAutoPlan;
  var optionsPourManquant = PDF.dayPlan.optionsPourManquant;
  function analyserManques(mandatorySlugs, slots, gate, planItems) {
    return PDF.dayPlan.analyserManques(mandatorySlugs, slots, gate, planItems, state.catalogueBySlug);
  }
  var planDayCellInfo = PDF.dayPlan.planDayCellInfo;

  function renderPlanCalendar() {
    PDF.renderMiniCalendar(
      "planCalendarWrap", state.planCalendar.year, state.planCalendar.month, state.datesMap,
      $("planDate").value, planDayCellInfo, selectPlanDate, changePlanCalendarMonth
    );
  }

  function selectPlanDate(dateStr) {
    $("planDate").value = dateStr;
    state.planCalendar.year = +dateStr.slice(0, 4);
    state.planCalendar.month = +dateStr.slice(5, 7) - 1;
    renderPlanCalendar();
    // Déclenche le même traitement que si le champ natif avait changé
    // (fermeture des panneaux "programme officiel"/"planning auto", etc.).
    $("planDate").dispatchEvent(new Event("change"));
  }

  function changePlanCalendarMonth(delta) {
    var m = state.planCalendar.month + delta, y = state.planCalendar.year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    state.planCalendar.month = m;
    state.planCalendar.year = y;
    renderPlanCalendar();
  }

  function renderJour() {
    var dateStr = $("planDate").value;
    var plan = planCourant(dateStr);
    $("planMoment").value = plan.moment || "Jour";
    // Mis en forme "mercredi 22 juillet · Jour" (voir .label-upper, qui le
    // passe en MAJUSCULES à l'affichage) — sans l'année, superflue ici.
    var dLabel = PDF.parseISODate(dateStr);
    $("planSelectedDateLabel").textContent = dLabel
      ? dLabel.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) + " · " + (plan.moment || "Jour")
      : "";
    $("planHint").textContent = stockageOk ? "" : "Stockage local indisponible : pensez à exporter vos données.";

    var record = state.datesMap[dateStr];
    var isClosed = record && (record.status === "closed_day" || record.status === "out_of_season");
    $("planClosedBanner").innerHTML = isClosed
      ? '<div class="status-banner status-stale"><span aria-hidden="true">🚧</span><span>Le Puy du Fou est fermé le ' +
        PDF.escapeHtml(PDF.formatDateFR(dateStr)) + ".</span></div>"
      : "";
    // Rien à charger/proposer un jour fermé (voir le message déjà renvoyé
    // par ces boutons dans ce cas) : autant le signaler avant le clic.
    $("btnLoadReal").disabled = !!isClosed;
    $("btnAutoPlan").disabled = !!isClosed;
    // Rien à enregistrer/exporter/imprimer/vider pour une journée vide.
    var hasItems = plan.items.length > 0;
    $("btnSaveVisit").disabled = !hasItems;
    $("btnExportIcs").disabled = !hasItems;
    $("btnPrintDay").disabled = !hasItems;
    $("btnClearDay").disabled = !hasItems;

    var tous = plan.items.slice().sort(function (a, b) {
      if (a.is_continuous && b.is_continuous) return 0;
      if (a.is_continuous) return -1;
      if (b.is_continuous) return 1;
      return (a.start || "").localeCompare(b.start || "");
    });
    var fixes = itemsFixesTries(plan);
    var conflits = detecterConflits(fixes, S.gate);

    renderJourKpis(plan, fixes, conflits);
    renderTimeline(tous, conflits);
    renderAlertes(tous, conflits);
    renderSwapChipsAsync(dateStr, tous, conflits);
    reconcileEstimatedItems(dateStr);
    updateLoadButtonLabel(dateStr);
  }

  // Une fois que le programme officiel existe pour une date qui n'en avait
  // pas au moment de l'ajout (séances "estimées", voir programme.html/
  // "Programme probable"), confronte chaque séance estimée au programme
  // réel : une correspondance exacte (même slug, même heure de début) lève
  // silencieusement le drapeau "estimated" ; sinon l'item est gardé mais
  // marqué "unconfirmed" (voir renderTimeline/renderSwapChipsAsync), et un
  // toast résume l'écart. Ne tourne qu'une fois par date (state.reconciledDates)
  // pour ne pas re-déclencher le toast à chaque rendu de la même journée.
  function reconcileEstimatedItems(dateStr) {
    if (state.reconciledDates[dateStr]) return;
    var plan = planCourant(dateStr);
    var estimatedItems = plan.items.filter(function (it) { return it.estimated && !it.unconfirmed; });
    if (!estimatedItems.length) { state.reconciledDates[dateStr] = true; return; }
    fetchRealDay(dateStr).then(function (dayData) {
      if (!dayData) return; // pas encore publié : on retentera au prochain rendu de cette date
      state.reconciledDates[dateStr] = true;
      var officialSlots = realDayToSlots(dayData);
      var matched = [];
      var unmatched = [];
      estimatedItems.forEach(function (it) {
        var hit = officialSlots.some(function (s) { return s.slug === it.slug && s.start === it.start; });
        if (hit) matched.push(it); else unmatched.push(it);
      });
      matched.forEach(function (it) { delete it.estimated; delete it.confidence; });
      unmatched.forEach(function (it) { it.unconfirmed = true; });
      if (matched.length || unmatched.length) { sauver(); renderJour(); }
      if (unmatched.length) {
        toast(
          unmatched.length + " séance" + (unmatched.length > 1 ? "s" : "") + " estimée" + (unmatched.length > 1 ? "s" : "") +
          " non confirmée" + (unmatched.length > 1 ? "s" : "") + " par le programme officiel : " +
          unmatched.map(function (it) { return it.name + " (" + PDF.formatTimeFR(it.start) + ")"; }).join(", ") +
          " — voir les autres séances proposées."
        );
      } else if (matched.length) {
        toast(matched.length + " séance" + (matched.length > 1 ? "s" : "") + " estimée" + (matched.length > 1 ? "s" : "") + " confirmée" + (matched.length > 1 ? "s" : "") + " par le programme officiel.");
      }
    });
  }

  // "Charger le programme officiel" devient "... probable" quand aucun
  // programme officiel n'existe encore pour la date sélectionnée (voir
  // PDF.scheduleStats.probableProgramme) — fetchRealDay est déjà mis en
  // cache par date, ce changement de libellé ne coûte donc pas de requête
  // supplémentaire au clic.
  function updateLoadButtonLabel(dateStr) {
    var btn = $("btnLoadReal");
    if (!btn || !dateStr) return;
    fetchRealDay(dateStr).then(function (dayData) {
      if ($("planDate").value !== dateStr) return; // la date a changé entre-temps
      btn.textContent = dayData ? "Charger le programme officiel de cette date" : "Charger le programme probable de cette date";
    });
  }

  // Durée totale des séances à heure fixe (les attractions en continu n'ont
  // pas de "temps de spectacle" ponctuel à additionner).
  var dureeTotaleMinutes = PDF.dayPlan.dureeTotaleMinutes;
  var formatDureeHeuresMinutes = PDF.dayPlan.formatDureeHeuresMinutes;

  // Menu "Plus d'actions" (Enregistrer comme visite / Imprimer / Vider) :
  // mêmes ouverture/fermeture au clic extérieur et à Échap que le panneau
  // "Explorer" de la nav (voir initNavDropdown, site/js/app.js), réécrites
  // ici en quelques lignes plutôt que de généraliser ce mécanisme pour un
  // unique autre appelant.
  function initDayActionsMenu() {
    var toggle = $("dayActionsToggle");
    var menu = $("dayActionsMenu");
    if (!toggle || !menu) return;
    toggle.innerHTML = PDF.icon("more-horizontal");
    function close() { menu.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
    function open() { menu.classList.add("open"); toggle.setAttribute("aria-expanded", "true"); }
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.classList.contains("open")) close(); else open();
    });
    document.addEventListener("click", function (e) {
      if (!menu.contains(e.target) && e.target !== toggle) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.classList.contains("open")) { close(); toggle.focus(); }
    });
    // Referme après un clic sur une des actions (pas de navigation de page
    // qui le ferait naturellement, contrairement au panneau "Explorer").
    menu.addEventListener("click", function (e) {
      if (e.target.closest("button")) close();
    });
  }

  function initShareButton() {
    var btn = $("btnShareDay");
    if (!btn) return;
    btn.innerHTML = PDF.icon("share");
    btn.addEventListener("click", function () {
      var dateStr = $("planDate").value;
      var plan = planCourant(dateStr);
      if (!plan.items.length) { toast("Rien à partager : la journée est vide."); return; }
      var lignes = plan.items.slice().sort(function (a, b) {
        if (a.is_continuous && b.is_continuous) return 0;
        if (a.is_continuous) return -1;
        if (b.is_continuous) return 1;
        return (a.start || "").localeCompare(b.start || "");
      }).map(function (it) {
        return (it.is_continuous ? "En continu" : PDF.formatTimeFR(it.start)) + " — " + it.name;
      });
      var texte = "Ma journée au Puy du Fou (" + PDF.formatDateLongFR(dateStr) + ") :\n" + lignes.join("\n");
      if (navigator.share) {
        navigator.share({ title: "Ma journée au Puy du Fou", text: texte }).catch(function () { /* annulé par l'utilisateur : rien à faire */ });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(texte).then(
          function () { toast("Copié dans le presse-papiers."); },
          function () { toast("Impossible de copier automatiquement."); }
        );
      } else {
        toast("Partage non disponible sur ce navigateur.");
      }
    });
  }

  function renderJourKpis(plan, fixes, conflits) {
    var wrap = $("jourKpis");
    if (!wrap) return;
    var n = conflits.length;
    var conflitLabel = n > 0 ? n + (n > 1 ? " conflits" : " conflit") : "0 conflit";
    wrap.innerHTML =
      '<div class="stat-tile"><div class="stat-label">Spectacles</div><div class="stat-value">' + plan.items.length + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Temps de spectacle</div><div class="stat-value">' +
      (fixes.length ? formatDureeHeuresMinutes(dureeTotaleMinutes(fixes)) : "—") + "</div></div>" +
      '<div class="stat-tile' + (n > 0 ? " stat-tile--danger" : "") + '"><div class="stat-label">Conflits</div><div class="stat-value">' + conflitLabel + "</div></div>";
  }

  // Minutes depuis minuit -> "HH:MM" (inverse de PDF.timeToMinutes), avec
  // repli circulaire si la marge fait passer avant minuit (cas limite
  // improbable vu les horaires réels du parc, géré par prudence).
  var minutesToHHMM = PDF.dayPlan.minutesToHHMM;

  /* ----------------------------------------------------------------------
   * Export .ics de la journée composée — voir PDF.dayPlan.buildIcs,
   * site/js/day-plan.js (partagé avec journee.js).
   * -------------------------------------------------------------------- */
  function buildIcs(dateStr, items, gate, now) {
    return PDF.dayPlan.buildIcs(dateStr, items, gate, now, uid);
  }

  var margeMinutes = PDF.dayPlan.margeMinutes;
  var conflitChevauchementAvec = PDF.dayPlan.conflitChevauchementAvec;

  function renderTimeline(items, conflits) {
    var el = $("jourTimeline");
    if (!items.length) {
      el.innerHTML =
        '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🗓️</div>' +
        "<p>Ajoutez un spectacle pour composer cette journée — depuis le programme officiel, ou manuellement.</p></div>";
      return;
    }
    var html = '<ol class="day-timeline">';
    items.forEach(function (it, idx) {
      var sev = severiteConflit(it, conflits);
      var autreConflit = sev === "error" ? conflitChevauchementAvec(it, conflits) : null;
      var cls = "day-card" +
        (it.category === "spectacle_nocturne" ? " day-card--night" : "") +
        (autreConflit ? " day-card--danger" : "");
      var dotCls = "day-timeline-dot" + (autreConflit ? " is-danger" : sev === "warn" ? " is-warn" : "");
      var timeLabel = it.is_continuous
        ? "En continu"
        : PDF.formatTimeFR(it.start);
      var badges = it.slug
        ? PDF.representationBadges({ start: it.start, is_continuous: it.is_continuous, status: it.status || "scheduled" }, it.category)
        : '<span class="badge badge-default">Ajout manuel</span>';
      // Voir reconcileEstimatedItems : "estimated" = pas encore de programme
      // officiel pour cette date (programme probable) ; "unconfirmed" = le
      // programme officiel existe désormais mais ne confirme pas CET
      // horaire précis (ni ajouté ni retiré automatiquement, à l'utilisateur
      // de décider — voir les chips "Autres séances" ci-dessous).
      if (it.unconfirmed) badges += '<span class="badge badge-conflict-warn">Horaire non confirmé</span>';
      else if (it.estimated) badges += '<span class="badge badge-default">Estimé</span>';
      var gateNote = (!it.is_continuous && it.start)
        ? '<div class="gate-note">' + PDF.icon("door") + " Portes " +
          PDF.escapeHtml(PDF.formatTimeFR(minutesToHHMM(PDF.timeToMinutes(it.start) - S.gate))) + "</div>"
        : "";
      var needsSwapChips = (autreConflit || it.unconfirmed) && it.slug;

      html +=
        '<li class="day-timeline-item">' +
        '<div class="day-timeline-time tnum">' + PDF.escapeHtml(timeLabel) + (it.end && !it.is_continuous ? '<div class="text-muted" style="font-weight:400;font-size:0.75rem">' + PDF.escapeHtml(PDF.formatTimeFR(it.end)) + "</div>" : "") + "</div>" +
        '<div class="day-timeline-rail"><span class="' + dotCls + '"></span></div>' +
        '<div class="' + cls + '">' +
        '<div class="day-card-name">' + PDF.escapeHtml(it.name) + "</div>" +
        '<div class="day-card-badges">' + badges + "</div>" +
        (autreConflit ? '<div class="day-card-conflict">Chevauche ' + PDF.escapeHtml(autreConflit.name) + "</div>" : "") +
        (needsSwapChips ? '<div class="swap-chips" id="swap-' + it.uid + '"></div>' : "") +
        gateNote +
        '<button type="button" class="btn btn-outline no-print remove-btn" data-remove="' + it.uid + '" aria-label="Retirer ' + PDF.escapeHtml(it.name) + '">' + PDF.icon("x") + "</button>" +
        "</div>" +
        "</li>";

      var next = items[idx + 1];
      if (!it.is_continuous && it.end && next && !next.is_continuous && next.start) {
        var marge = margeMinutes(it, next);
        if (marge >= 0) {
          var tendu = marge < S.gate;
          html +=
            '<li class="day-gap-row"><div></div><div></div>' +
            '<div class="day-gap-note' + (tendu ? " is-warn" : "") + '">' + PDF.icon("walking") + " " +
            (tendu
              ? marge + " min pour rejoindre — enchaînement serré"
              : marge + " min de marge") +
            "</div></li>";
        }
      }
    });
    html += "</ol>";
    el.innerHTML = html;
    el.querySelectorAll("[data-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var dateStr = $("planDate").value;
        var plan = planCourant(dateStr);
        var targetUid = btn.getAttribute("data-remove");
        plan.items = plan.items.filter(function (it) { return it.uid !== targetUid; });
        sauver();
        renderJour();
      });
    });
  }

  // Pour chaque séance en chevauchement réel OU "non confirmée" par le
  // programme officiel (voir reconcileEstimatedItems), propose en chips les
  // autres horaires connus du MÊME spectacle ce jour-là pour la déplacer en
  // un tap — n'affiche rien si le programme officiel de cette date n'est
  // pas disponible (ex: ajout manuel, jour trop ancien, pas encore publié).
  function renderSwapChipsAsync(dateStr, items, conflits) {
    var cibles = items.filter(function (it) {
      return it.slug && (it.unconfirmed || conflits.some(function (c) { return c.chevauchement && (c.a === it || c.b === it); }));
    });
    if (!cibles.length) return;
    fetchRealDay(dateStr).then(function (dayData) {
      if (!dayData) return;
      var slots = realDayToSlots(dayData);
      cibles.forEach(function (it) {
        var hote = document.getElementById("swap-" + it.uid);
        if (!hote) return;
        var autres = slots.filter(function (s) {
          return s.slug === it.slug && !s.is_continuous && s.start && s.start !== it.start;
        });
        if (!autres.length) return;
        hote.innerHTML =
          '<div class="swap-chips-label">Autres séances</div><div class="chip-row">' +
          autres.map(function (s) {
            return '<button type="button" class="chip" data-swap-uid="' + it.uid + '" data-swap-start="' + s.start + '" data-swap-end="' + (s.end || "") + '">' +
              PDF.escapeHtml(PDF.formatTimeFR(s.start)) + "</button>";
          }).join("") + "</div>";
        hote.querySelectorAll("[data-swap-uid]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var plan = planCourant(dateStr);
            var cible = plan.items.find(function (x) { return x.uid === btn.getAttribute("data-swap-uid"); });
            if (!cible) return;
            cible.start = btn.getAttribute("data-swap-start");
            cible.end = btn.getAttribute("data-swap-end") || null;
            // On vient de choisir un horaire TIRÉ DU PROGRAMME OFFICIEL :
            // ni estimé ni non confirmé, quel que soit l'état précédent.
            delete cible.estimated;
            delete cible.unconfirmed;
            delete cible.confidence;
            sauver();
            renderJour();
          });
        });
      });
    });
  }

  function renderAlertes(items, conflits) {
    var wrap = $("jourAlertesWrap");
    var el = $("jourAlertes");
    if (!items.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    if (!conflits.length) {
      el.innerHTML = '<div class="status-banner status-ok"><span aria-hidden="true">✅</span>' +
        "<span>Aucun chevauchement : chaque spectacle laisse le temps d'arriver aux portes du suivant.</span></div>";
      return;
    }
    el.innerHTML = conflits.map(function (c) {
      if (c.chevauchement) {
        var msgErreur = "<strong>" + PDF.escapeHtml(c.a.name) + "</strong> se termine à " + PDF.formatTimeFR(c.a.end) +
          ", pendant <strong>" + PDF.escapeHtml(c.b.name) + "</strong> (débute à " + PDF.formatTimeFR(c.b.start) + ") : impossible de voir les deux en entier.";
        return '<div class="status-banner status-error"><span aria-hidden="true">⛔</span><span>' + msgErreur + "</span></div>";
      }
      var msgTendu = "<strong>" + PDF.escapeHtml(c.a.name) + "</strong> se termine à " + PDF.formatTimeFR(c.a.end) +
        ", après l'ouverture des portes du <strong>" + PDF.escapeHtml(c.b.name) + "</strong> (" + PDF.formatTimeFR(c.b.start) + ") : ça va être juste.";
      return '<div class="status-banner status-warn"><span aria-hidden="true">⚠️</span><span>' + msgTendu + "</span></div>";
    }).join("");
  }

  function populerSelectReel(slots) {
    var wrap = $("addFromRealWrap");
    var sel = $("addRealSelect");
    state.currentRealSlots = slots;
    if (!slots.length) { wrap.hidden = true; return; }
    sel.innerHTML = slots.map(function (s, i) {
      var label =
        (s.is_continuous
          ? "En continu" + (s.end ? " " + PDF.formatTimeFR(s.start) + "–" + PDF.formatTimeFR(s.end) : "")
          : PDF.formatTimeFR(s.start)) +
        " — " + s.name +
        (s.estimated ? " (estimé, " + Math.round(s.confidence * 100) + "%)" : "");
      return '<option value="' + i + '">' + PDF.escapeHtml(label) + "</option>";
    }).join("");
    wrap.hidden = false;
  }

  // Panneau "planning automatique" : laisse choisir, avant de générer, les
  // spectacles à caser en priorité (immersifs à capacité limitée en tête —
  // ce sont eux qu'on risque le plus de rater).
  function openAutoPlanPicker(slots) {
    state.autoPlanSlots = slots;
    var vus = {};
    var distincts = [];
    // Seuls les spectacles à heure fixe ont un intérêt à cocher : les
    // attractions en continu (souvent les immersifs, en accès libre sur une
    // plage horaire) sont de toute façon toujours incluses automatiquement.
    slots.forEach(function (s) {
      if (s.is_continuous || !s.slug || vus[s.slug]) return;
      vus[s.slug] = true;
      distincts.push({ slug: s.slug, name: s.name, category: s.category });
    });
    distincts.sort(function (a, b) {
      var pa = a.category === "spectacle_immersif" ? 0 : 1;
      var pb = b.category === "spectacle_immersif" ? 0 : 1;
      return pa !== pb ? pa - pb : a.name.localeCompare(b.name, "fr");
    });
    $("autoPlanChecklist").innerHTML = distincts.length
      ? distincts.map(function (s) {
          return (
            '<label class="pick-item">' +
            '<input type="checkbox" value="' + PDF.escapeHtml(s.slug) + '">' +
            '<span class="pick-name">' + PDF.escapeHtml(s.name) + "</span>" +
            PDF.categoryBadgeHtml(s.category) +
            "</label>"
          );
        }).join("")
      : '<p class="text-muted">Aucun spectacle à heure fixe ce jour-là.</p>';
    $("autoPlanResult").innerHTML = "";
    $("autoPlanWrap").hidden = false;
    if (typeof $("autoPlanWrap").scrollIntoView === "function") {
      $("autoPlanWrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function closeAutoPlanPicker() {
    $("autoPlanWrap").hidden = true;
    $("autoPlanResult").innerHTML = "";
  }

  // Bilan de la génération : reste affiché (pas un toast qui disparaît) tant
  // que le panneau est ouvert, avec — en mode précis — un choix concret à
  // faire pour chaque spectacle demandé qui n'a pas pu être casé.
  function renderAutoPlanResult(mandatorySlugs, slots, propose) {
    var el = $("autoPlanResult");

    if (!mandatorySlugs.length) {
      var fixesDispo = slots.filter(function (s) { return !s.is_continuous && s.start && s.end && s.status !== "complet"; }).length;
      var fixesRetenues = propose.filter(function (s) { return !s.is_continuous; }).length;
      var ecartees = fixesDispo - fixesRetenues;
      el.innerHTML = '<div class="status-banner status-ok"><span aria-hidden="true">✅</span><span>' +
        "Planning proposé : " + propose.length + " spectacle" + (propose.length > 1 ? "s" : "") +
        (ecartees > 0 ? " (" + ecartees + " séance" + (ecartees > 1 ? "s" : "") + " horaire incompatible écartée" + (ecartees > 1 ? "s" : "") + ")" : "") +
        ".</span></div>";
      return;
    }

    var dateStr = $("planDate").value;
    var plan = planCourant(dateStr);
    var manques = analyserManques(mandatorySlugs, slots, S.gate, plan.items);

    if (!manques.length) {
      el.innerHTML = '<div class="status-banner status-ok"><span aria-hidden="true">✅</span><span>' +
        "Les " + mandatorySlugs.length + " spectacle" + (mandatorySlugs.length > 1 ? "s" : "") + " demandé" + (mandatorySlugs.length > 1 ? "s" : "") +
        " " + (mandatorySlugs.length > 1 ? "sont tous casés" : "est casé") + ".</span></div>";
      return;
    }

    el.innerHTML =
      '<div class="status-banner status-warn"><span aria-hidden="true">⚠️</span><span>' +
      (mandatorySlugs.length - manques.length) + "/" + mandatorySlugs.length + " spectacle" + (mandatorySlugs.length > 1 ? "s" : "") +
      " demandé" + (mandatorySlugs.length > 1 ? "s" : "") + " casé" + (mandatorySlugs.length > 1 ? "s" : "") +
      " — les suivants se heurtent à un conflit, à vous de choisir :</span></div>" +
      manques.map(function (m) {
        if (!m.options.length) {
          return '<div class="autoplan-conflict"><strong>' + PDF.escapeHtml(m.name) + "</strong>Aucun horaire disponible ce jour-là.</div>";
        }
        return (
          '<div class="autoplan-conflict"><strong>' + PDF.escapeHtml(m.name) + "</strong>" +
          m.options.map(function (opt, i) {
            var noms = opt.blockers.map(function (b) {
              return PDF.escapeHtml(b.name) + " (" + PDF.formatTimeFR(b.start) + "–" + PDF.formatTimeFR(b.end) + ")";
            }).join(" et ");
            return (
              '<div class="autoplan-choice">' +
              "<span>" + PDF.formatTimeFR(opt.start) + "–" + PDF.formatTimeFR(opt.end) +
              (noms ? " — à la place de " + noms : " — créneau libre") + "</span>" +
              '<button type="button" class="btn btn-outline" data-swap="' + m.slug + "|" + i + '">Faire ce choix</button>' +
              "</div>"
            );
          }).join("") +
          "</div>"
        );
      }).join("");

    el.querySelectorAll("[data-swap]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var parts = btn.getAttribute("data-swap").split("|");
        var slug = parts[0], idx = +parts[1];
        var m = manques.filter(function (x) { return x.slug === slug; })[0];
        var opt = m.options[idx];
        var planNow = planCourant($("planDate").value);
        var blockerUids = {};
        opt.blockers.forEach(function (b) { blockerUids[b.uid] = true; });
        planNow.items = planNow.items.filter(function (it) { return !blockerUids[it.uid]; });
        var slotData = slots.filter(function (s) {
          return s.slug === slug && s.start === opt.start && s.end === opt.end;
        })[0];
        if (slotData) {
          planNow.items.push({
            slug: slotData.slug, name: slotData.name, category: slotData.category,
            start: slotData.start, end: slotData.end, is_continuous: slotData.is_continuous, status: slotData.status, uid: uid(),
          });
        }
        sauver();
        renderJour();
        renderAutoPlanResult(mandatorySlugs, slots, propose);
      });
    });
  }

  function initJourListeners() {
    $("planDate").addEventListener("change", function () {
      state.currentRealSlots = [];
      $("addFromRealWrap").hidden = true;
      closeAutoPlanPicker();
      renderJour();
    });
    $("planGate").addEventListener("change", function () {
      S.gate = Math.max(0, +$("planGate").value || 0);
      sauver();
      renderJour();
    });
    $("planMoment").addEventListener("change", function () {
      var plan = planCourant($("planDate").value);
      plan.moment = $("planMoment").value;
      sauver();
    });

    $("btnLoadReal").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      if (!dateStr) return toast("Choisissez une date.");
      var btn = $("btnLoadReal");
      btn.disabled = true;
      fetchRealDay(dateStr).then(function (dayData) {
        if (dayData) {
          btn.disabled = false;
          var slots = realDayToSlots(dayData);
          populerSelectReel(slots);
          if (!slots.length) {
            toast(
              dayData.status === "closed_day" || dayData.status === "out_of_season"
                ? "Le Puy du Fou est fermé ce jour-là : ajoutez manuellement si besoin."
                : "Le programme officiel de cette date ne contient aucun horaire."
            );
          } else {
            toast(slots.length + " horaire(s) chargé(s) depuis le programme officiel.");
          }
          return;
        }
        // Pas (encore) de programme officiel : tente une estimation (voir
        // PDF.scheduleStats.probableProgramme) plutôt que de s'arrêter là.
        loadProbableSlots(dateStr).then(function () { btn.disabled = false; });
      });
    });

    $("btnAutoPlan").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      if (!dateStr) return toast("Choisissez une date.");
      var btn = $("btnAutoPlan");
      btn.disabled = true;
      fetchRealDay(dateStr).then(function (dayData) {
        btn.disabled = false;
        if (!dayData) {
          toast("Aucune donnée officielle pour cette date (hors saison, pas encore publiée, ou trop ancienne) : impossible de proposer un planning.");
          return;
        }
        var slots = realDayToSlots(dayData);
        populerSelectReel(slots);
        if (!slots.length) {
          toast(
            dayData.status === "closed_day" || dayData.status === "out_of_season"
              ? "Le Puy du Fou est fermé ce jour-là : rien à proposer."
              : "Le programme officiel de cette date ne contient aucun horaire."
          );
          return;
        }
        openAutoPlanPicker(slots);
      });
    });

    $("btnCancelAutoPlan").addEventListener("click", closeAutoPlanPicker);

    $("btnGenerateAutoPlan").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      var plan = planCourant(dateStr);
      var slots = state.autoPlanSlots;
      if (!plan || !slots.length) return;
      var mandatorySlugs = Array.prototype.slice
        .call($("autoPlanChecklist").querySelectorAll("input[type=checkbox]:checked"))
        .map(function (cb) { return cb.value; });

      function applyPlan() {
        var propose = buildAutoPlan(slots, S.gate, mandatorySlugs);
        if (!propose.length) {
          toast("Aucune séance ne peut être proposée pour cette date (toutes complètes, ou incompatibles entre elles).");
          return;
        }
        plan.items = propose.map(function (s) {
          return {
            slug: s.slug, name: s.name, category: s.category,
            start: s.start, end: s.end, is_continuous: s.is_continuous, status: s.status, uid: uid(),
          };
        });
        sauver();
        renderJour();
        renderAutoPlanResult(mandatorySlugs, slots, propose);
      }

      if (plan.items.length) {
        confirmDialog("Remplacer le programme actuel de cette journée par une proposition automatique ?", "Remplacer").then(function (ok) {
          if (ok) applyPlan();
        });
      } else {
        applyPlan();
      }
    });

    $("btnAddReal").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      var plan = planCourant(dateStr);
      if (!plan) return toast("Choisissez une date.");
      var idx = $("addRealSelect").value;
      if (idx === "") return;
      var slot = state.currentRealSlots[+idx];
      if (!slot) return;
      var candidat = {
        slug: slot.slug, name: slot.name, category: slot.category,
        start: slot.start, end: slot.end, is_continuous: slot.is_continuous, status: slot.status,
      };
      if (slot.estimated) { candidat.estimated = true; candidat.confidence = slot.confidence; }
      if (planItemExists(plan, candidat)) return toast(slot.name + " est déjà dans cette journée.");
      candidat.uid = uid();
      plan.items.push(candidat);
      sauver();
      renderJour();
    });

    $("btnAddManual").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      var plan = planCourant(dateStr);
      if (!plan) return toast("Choisissez une date.");
      var name = $("addManualName").value.trim();
      var start = $("addManualStart").value;
      var end = $("addManualEnd").value;
      if (!name || !start) return toast("Indiquez au moins un nom et une heure de début.");
      var candidat = { slug: null, name: name, category: "autre", start: start, end: end || null, is_continuous: false };
      if (planItemExists(plan, candidat)) return toast(name + " est déjà dans cette journée à cet horaire.");
      candidat.uid = uid();
      plan.items.push(candidat);
      sauver();
      renderJour();
      $("addManualName").value = "";
    });

    $("btnClearDay").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      var plan = S.plans[dateStr];
      if (!plan || !plan.items.length) return;
      var previousItems = plan.items;
      plan.items = [];
      sauver();
      renderJour();
      toastUndo("Journée vidée.", function () {
        plan.items = previousItems;
        sauver();
        renderJour();
      });
    });

    $("btnSaveVisit").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      var plan = S.plans[dateStr];
      if (!plan || !plan.items.length) return toast("Cette journée est vide.");
      var visite = S.visites.filter(function (v) { return v.date === dateStr; })[0];
      if (!visite) {
        visite = { date: dateStr, moment: plan.moment || "Jour", com: "", seen: {} };
        S.visites.push(visite);
      } else {
        visite.moment = plan.moment || visite.moment;
      }
      plan.items.forEach(function (it) {
        var key = it.slug || (MANUAL_PREFIX + it.name);
        visite.seen[key] = (visite.seen[key] || 0) + 1;
      });
      S.visites.sort(function (a, b) { return a.date.localeCompare(b.date); });
      sauver();
      toast("Journée du " + PDF.formatDateFR(dateStr) + " ajoutée au carnet de visites.");
    });

    $("btnExportIcs").addEventListener("click", function () {
      var dateStr = $("planDate").value;
      var plan = S.plans[dateStr];
      if (!plan || !plan.items.length) return toast("Cette journée est vide.");
      var contenu = buildIcs(dateStr, plan.items, S.gate);
      var blob = new Blob([contenu], { type: "text/calendar;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "journee-puy-du-fou-" + dateStr + ".ics";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast("Fichier .ics téléchargé — importez-le dans votre calendrier.");
    });

    $("btnPrintDay").addEventListener("click", function () { window.print(); });
  }

  // "carnet.html?date=2026-12-18#journee" présélectionne cette date au lieu
  // d'aujourd'hui (ex: lien "Préparer ma visite" depuis la carte de
  // réouverture de l'accueil, voir index.html) — ignoré si absent/invalide.
  function initialPlanDate() {
    var requested = new URLSearchParams(location.search).get("date");
    return requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : PDF.isoDateToday();
  }

  function initPlanUI() {
    var dateStr = initialPlanDate();
    $("planDate").value = dateStr;
    state.planCalendar.year = +dateStr.slice(0, 4);
    state.planCalendar.month = +dateStr.slice(5, 7) - 1;
    renderPlanCalendar();
    $("planGate").value = S.gate;
    renderJour();
  }

  /* ----------------------------------------------------------------------
   * Onglet Visites
   * -------------------------------------------------------------------- */

  // Colonnes du carnet : tout le catalogue officiel + les ajouts manuels
  // déjà utilisés dans au moins une visite (ex: Cinéscénie).
  function toutesLesColonnes() {
    var cols = state.catalogue.map(function (s) { return { key: s.slug, name: s.name, category: s.category }; });
    var extras = {};
    S.visites.forEach(function (v) {
      Object.keys(v.seen).forEach(function (k) {
        if (k.indexOf(MANUAL_PREFIX) === 0 && !state.catalogueBySlug[k]) extras[k] = k.slice(MANUAL_PREFIX.length);
      });
    });
    Object.keys(extras).sort().forEach(function (k) { cols.push({ key: k, name: extras[k], category: "autre" }); });
    return cols;
  }

  // Fait avancer le compteur "vu" d'un spectacle pour une visite : 0 -> 1 ->
  // 2 -> effacé. Partagé entre la grille et le panneau de détail.
  function cycleSeen(seen, key) {
    var n = seen[key] || 0;
    if (n >= 2) delete seen[key]; else seen[key] = n + 1;
  }

  // Supprime une visite immédiatement (pas de confirm() bloquant — une
  // suppression reste facilement annulable, voir toastUndo), partagé entre
  // la grille et le panneau de détail.
  function deleteVisit(v) {
    if (!v) return;
    S.visites = S.visites.filter(function (x) { return x !== v; });
    sauver();
    if (state.currentVisit === v) closeVisitDetail();
    renderVisites();
    toastUndo("Visite du " + PDF.formatDateFR(v.date) + " supprimée.", function () {
      S.visites.push(v);
      S.visites.sort(function (a, b) { return a.date.localeCompare(b.date); });
      sauver();
      renderVisites();
    });
  }

  function renderVisites() {
    var table = $("tblVisites");
    var cols = toutesLesColonnes();
    var vs = S.visites.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var totaux = {};
    cols.forEach(function (c) { totaux[c.key] = 0; });
    vs.forEach(function (v) { cols.forEach(function (c) { totaux[c.key] += v.seen[c.key] || 0; }); });

    var head =
      "<thead><tr><th class=\"visit-date-col\">Date de visite</th>" +
      cols.map(function (c) {
        return '<th class="visit-show-col" title="' + PDF.escapeHtml(c.name) + '"><span>' + PDF.escapeHtml(c.name) + "</span></th>";
      }).join("") +
      '<th class="no-print"></th></tr></thead>';

    var body = "<tbody>" + (vs.length ? vs.map(function (v, vi) {
      return (
        '<tr><td class="visit-date-col">' + PDF.escapeHtml(PDF.formatDateLongFR(v.date)) +
        '<span class="visit-note">' + PDF.escapeHtml(v.moment || "Jour") + "</span>" +
        (v.com ? '<span class="visit-note">' + PDF.escapeHtml(v.com) + "</span>" : "") +
        ' <button type="button" class="visit-date-link" data-editv="' + vi + '">✏️ Modifier</button>' +
        "</td>" +
        cols.map(function (c) {
          var n = v.seen[c.key] || 0;
          var cls = n === 1 ? "is-seen" : n > 1 ? "is-seen-twice" : "";
          var label = n === 0 ? "" : n === 1 ? "✓" : "×" + n;
          return '<td class="visit-cell ' + cls + '"><button type="button" data-cell="' + vi + "|" + c.key + '">' + label + "</button></td>";
        }).join("") +
        '<td class="no-print"><button type="button" class="btn btn-outline" data-delv="' + vi + '" aria-label="Supprimer">✕</button></td></tr>'
      );
    }).join("") : (
      '<tr><td colspan="' + (cols.length + 2) + '" class="text-muted" style="padding:1.5rem;text-align:center">' +
      "Aucune visite pour le moment. Ajoutez-en une, ou planifiez une journée puis « Enregistrer comme visite »." +
      "</td></tr>"
    )) + "</tbody>";

    var foot =
      '<tfoot><tr><td class="visit-date-col">Total — ' + vs.length + " visite" + (vs.length > 1 ? "s" : "") + "</td>" +
      cols.map(function (c) { return "<td>" + (totaux[c.key] || "·") + "</td>"; }).join("") +
      '<td class="no-print"></td></tr></tfoot>';

    table.innerHTML = head + body + foot;

    table.querySelectorAll("[data-cell]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var parts = btn.getAttribute("data-cell").split("|");
        var v = vs[+parts[0]];
        cycleSeen(v.seen, parts[1]);
        sauver();
        renderVisites();
        if (state.currentVisit === v) renderVisitChecklist();
      });
    });
    table.querySelectorAll("[data-delv]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteVisit(vs[+btn.getAttribute("data-delv")]);
      });
    });
    table.querySelectorAll("[data-editv]").forEach(function (btn) {
      btn.addEventListener("click", function () { openVisitDetail(vs[+btn.getAttribute("data-editv")]); });
    });
  }

  /* -- Panneau de détail d'une visite (vue checklist, édition en place) -- */

  function openVisitDetail(visite) {
    state.currentVisit = visite;
    $("visitDetailWrap").hidden = false;
    $("visitDetailTitle").textContent = "Visite du " + PDF.formatDateFR(visite.date);
    $("visitDate").value = visite.date;
    $("visitMoment").value = visite.moment || "Jour";
    $("visitCom").value = visite.com || "";
    $("visitDetailHint").textContent = "";
    renderVisitChecklist();
    if (typeof $("visitDetailWrap").scrollIntoView === "function") {
      $("visitDetailWrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function closeVisitDetail() {
    state.currentVisit = null;
    $("visitDetailWrap").hidden = true;
  }

  function renderVisitChecklist() {
    var visite = state.currentVisit;
    if (!visite) return;
    var cols = toutesLesColonnes();
    $("visitChecklist").innerHTML = cols.map(function (c) {
      var n = visite.seen[c.key] || 0;
      var cls = n === 1 ? "is-seen" : n > 1 ? "is-seen-twice" : "";
      var label = n === 0 ? "—" : n === 1 ? "✓" : "×" + n;
      return (
        '<div class="visit-check-item">' +
        '<button type="button" class="visit-check-btn ' + cls + '" data-checkkey="' + c.key + '">' + label + "</button>" +
        '<span class="visit-check-name">' + PDF.escapeHtml(c.name) + "</span>" +
        "</div>"
      );
    }).join("");
    $("visitChecklist").querySelectorAll("[data-checkkey]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        cycleSeen(visite.seen, btn.getAttribute("data-checkkey"));
        sauver();
        renderVisitChecklist();
        renderVisites();
      });
    });
  }

  function initVisitesListeners() {
    $("btnAddVisit").addEventListener("click", function () {
      var d = $("planDate").value || PDF.isoDateToday();
      var existante = S.visites.filter(function (v) { return v.date === d; })[0];
      if (existante) {
        openVisitDetail(existante);
        toast("Une visite existe déjà pour cette date — ouverte pour modification.");
        return;
      }
      var visite = { date: d, moment: "Jour", com: "", seen: {} };
      S.visites.push(visite);
      S.visites.sort(function (a, b) { return a.date.localeCompare(b.date); });
      sauver();
      renderVisites();
      openVisitDetail(visite);
    });

    $("btnCloseVisitDetail").addEventListener("click", closeVisitDetail);

    $("visitDate").addEventListener("change", function () {
      var v = state.currentVisit;
      if (!v) return;
      var d = $("visitDate").value;
      if (!d) return;
      if (S.visites.some(function (x) { return x !== v && x.date === d; })) {
        $("visitDate").value = v.date;
        toast("Cette date est déjà utilisée par une autre visite.");
        return;
      }
      v.date = d;
      S.visites.sort(function (a, b) { return a.date.localeCompare(b.date); });
      sauver();
      $("visitDetailTitle").textContent = "Visite du " + PDF.formatDateFR(v.date);
      renderVisites();
    });

    $("visitMoment").addEventListener("change", function () {
      if (!state.currentVisit) return;
      state.currentVisit.moment = $("visitMoment").value;
      sauver();
      renderVisites();
    });

    $("visitCom").addEventListener("input", function () {
      if (!state.currentVisit) return;
      state.currentVisit.com = $("visitCom").value;
      sauver();
    });
    $("visitCom").addEventListener("change", function () {
      if (!state.currentVisit) return;
      state.currentVisit.com = $("visitCom").value;
      sauver();
      renderVisites();
    });

    $("btnDeleteVisitDetail").addEventListener("click", function () {
      deleteVisit(state.currentVisit);
    });
  }

  /* ----------------------------------------------------------------------
   * Onglet Bilan
   * -------------------------------------------------------------------- */

  function computeStats() {
    var cols = toutesLesColonnes();
    var vs = S.visites.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
    var parShow = {};
    cols.forEach(function (c) { parShow[c.key] = 0; });
    vs.forEach(function (v) {
      Object.keys(v.seen).forEach(function (k) { if (parShow[k] != null) parShow[k] += v.seen[k]; });
    });
    var seances = 0;
    cols.forEach(function (c) { seances += parShow[c.key]; });
    var cines = 0;
    vs.forEach(function (v) { cines += v.seen[MANUAL_PREFIX + "Cinéscénie"] || 0; });
    var differents = cols.filter(function (c) { return parShow[c.key] > 0; }).length;

    var parMoment = { "Jour": 0, "Après-midi": 0, "Soirée": 0 };
    vs.forEach(function (v) { var m = v.moment || "Jour"; parMoment[m] = (parMoment[m] || 0) + 1; });

    var parMois = {};
    vs.forEach(function (v) { var m = MOIS[+v.date.slice(5, 7) - 1]; parMois[m] = (parMois[m] || 0) + 1; });

    var parVisite = vs.map(function (v) {
      var n = 0;
      Object.keys(v.seen).forEach(function (k) { n += v.seen[k]; });
      return { v: v, n: n };
    });
    var best = parVisite.slice().sort(function (a, b) { return b.n - a.n; })[0];

    return {
      vs: vs, cols: cols, parShow: parShow, seances: seances, cines: cines, differents: differents,
      parMoment: parMoment, parMois: parMois, best: best,
      moyenne: vs.length ? seances / vs.length : 0,
    };
  }

  function renderBarsHtml(entries) {
    var max = entries.reduce(function (m, e) { return Math.max(m, e.n); }, 0) || 1;
    return '<div class="bars">' + entries.map(function (e) {
      var w = e.n === 0 ? 0 : (e.n / max * 100);
      return (
        '<div class="bar">' +
        '<div class="bar-label' + (e.n === 0 ? " is-muted" : "") + '">' + PDF.escapeHtml(e.nom) + "</div>" +
        '<div class="bar-track"><div class="bar-fill' + (e.nuit ? " bar-fill-nocturne" : "") + '" style="width:' + w + '%"></div></div>' +
        '<div class="bar-count">' + e.n + "</div></div>"
      );
    }).join("") + "</div>";
  }

  function renderBilan() {
    var st = computeStats();
    $("bilanKpis").innerHTML = [
      ["Visites", st.vs.length],
      ["Séances", st.seances],
      ["Par visite", PDF.formatNumberFR(st.moyenne, { minimumFractionDigits: 1, maximumFractionDigits: 1 })],
      ["Cinéscénies", st.cines],
      ["Spectacles vus", st.differents + '<small style="font-size:0.55em;color:var(--text-soft)"> / ' + st.cols.length + "</small>"],
    ].map(function (kv) {
      return '<div class="stat-tile"><div class="stat-label">' + kv[0] + '</div><div class="stat-value">' + kv[1] + "</div></div>";
    }).join("");

    var ranked = st.cols
      .map(function (c) { return { nom: c.name, n: st.parShow[c.key] || 0, nuit: c.category === "spectacle_nocturne" }; })
      .sort(function (a, b) { return b.n - a.n; });
    $("bilanPalmares").innerHTML = ranked.length ? renderBarsHtml(ranked) : '<p class="text-muted">Enregistrez une visite pour voir votre classement.</p>';

    var moisOrdre = Object.keys(st.parMois);
    $("bilanParMois").innerHTML = moisOrdre.length
      ? renderBarsHtml(moisOrdre.map(function (m) { return { nom: m, n: st.parMois[m] }; }))
      : '<p class="text-muted">Enregistrez une visite pour voir votre rythme.</p>';

    $("bilanParMoment").innerHTML = st.vs.length
      ? renderBarsHtml(Object.keys(st.parMoment).map(function (k) { return { nom: k, n: st.parMoment[k] }; }))
      : '<p class="text-muted">Jour, après-midi ou soirée : la répartition apparaîtra ici.</p>';

    var jamais = st.cols.filter(function (c) { return !st.parShow[c.key]; });
    $("bilanJamaisVus").innerHTML = jamais.length
      ? jamais.map(function (c) { return '<span class="chip">' + PDF.escapeHtml(c.name) + "</span>"; }).join("")
      : '<span class="text-muted">Tous les spectacles connus ont été vus.</span>';

    $("bilanMeilleureJournee").textContent = (st.best && st.best.n)
      ? (PDF.formatDateLongFR(st.best.v.date) + " — " + st.best.n + " spectacle" + (st.best.n > 1 ? "s" : "") + " en une journée.")
      : "Pas encore de journée enregistrée.";
  }

  /* ----------------------------------------------------------------------
   * Onglet Pass
   * -------------------------------------------------------------------- */

  function initPassInputs() {
    ["prixPass", "prixBillet", "prixCine", "fraisVisite"].forEach(function (k) {
      var el = $(k);
      el.value = S.pass[k];
      el.addEventListener("input", function () {
        S.pass[k] = Math.max(0, +el.value || 0);
        sauver();
        renderPass();
      });
    });
  }

  function renderPass() {
    var st = computeStats(), p = S.pass, nv = st.vs.length;
    var coutTotal = p.prixPass + nv * p.fraisVisite + st.cines * p.prixCine;
    var parVisite = nv ? coutTotal / nv : 0;
    var parSeance = st.seances ? p.prixPass / st.seances : 0;
    var sansPass = nv * p.prixBillet;
    var economie = sansPass - p.prixPass;
    var seuil = p.prixBillet > 0 ? Math.ceil(p.prixPass / p.prixBillet) : 0;

    $("passKpis").innerHTML = [
      ["Par visite", eur(parVisite)],
      ["Par spectacle", eur(parSeance)],
      ["Sans le pass", eur(sansPass)],
      [economie >= 0 ? "Économie" : "Reste à amortir", eur(Math.abs(economie))],
    ].map(function (kv) {
      return '<div class="stat-tile"><div class="stat-label">' + kv[0] + '</div><div class="stat-value" style="font-size:1.3rem">' + kv[1] + "</div></div>";
    }).join("");

    var pct = seuil ? Math.min(100, nv / seuil * 100) : 0;
    var msg;
    if (!seuil) {
      msg = "Indiquez le prix d'un billet 1 jour pour calculer le seuil de rentabilité.";
    } else if (nv >= seuil) {
      msg = "Pass rentabilisé depuis la " + seuil + "ᵉ visite (" + PDF.formatDateFR(st.vs[seuil - 1].date) + "). Les " +
        (nv - seuil) + " visite(s) suivante(s) sont « offertes », soit " + eur((nv - seuil) * p.prixBillet) + " d'entrées.";
    } else {
      msg = "Il faut " + seuil + " visites pour rentabiliser le pass à " + eur(p.prixPass) + ". Vous en êtes à " +
        nv + " — encore " + (seuil - nv) + ".";
    }
    $("passRenta").innerHTML =
      '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
      "<p style=\"margin:0\">" + PDF.escapeHtml(msg) + "</p>" +
      '<p class="text-muted" style="margin:0.6rem 0 0">La Cinéscénie (comptée si un ajout manuel nommé exactement « Cinéscénie » figure dans vos visites) et les frais par visite s\'ajoutent au pass mais ne comptent pas dans le seuil : ils seraient payés dans tous les cas.</p>';

    var lignes = st.vs.map(function (v, i) {
      return { nom: PDF.formatDateFR(v.date) + " — " + eur(p.prixPass / (i + 1)) + " la visite", n: +(p.prixPass / (i + 1)).toFixed(2) };
    });
    $("passAmorti").innerHTML = lignes.length ? renderBarsHtml(lignes) : '<p class="text-muted">Ajoutez des visites pour voir le coût baisser.</p>';
  }

  /* ----------------------------------------------------------------------
   * Import / export / reset
   * -------------------------------------------------------------------- */

  function refreshAll() {
    initPlanUI();
    renderVisites();
    renderBilan();
    renderPass();
  }

  // Numéro de version du format exporté — permet de distinguer, à l'import,
  // un futur format incompatible d'un ancien export. Les exports déjà en
  // circulation n'ont pas ce champ : acceptés quand même (traités comme la
  // version 1).
  // v2 : les items de plan peuvent porter `estimated`/`confidence`
  // (séance ajoutée depuis un "programme probable", voir
  // PDF.scheduleStats.probableProgramme) et `unconfirmed` (confrontée
  // depuis au programme officiel, sans correspondance exacte — voir
  // reconcileEstimatedItems). Purement additif : un export v1 importé tel
  // quel a simplement ces champs absents, ce qui équivaut déjà à "jamais
  // estimée" — aucune migration de données n'est donc nécessaire, seul le
  // numéro de version progresse pour documenter le changement de forme.
  var EXPORT_VERSION = 2;

  function initIoListeners() {
    $("btnExport").addEventListener("click", function () {
      var payload = Object.assign({ version: EXPORT_VERSION }, S);
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "mon-carnet-puy-du-fou-" + PDF.isoDateToday() + ".json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
      toast("Fichier exporté.");
    });

    $("btnImport").addEventListener("click", function () { $("fileImport").click(); });
    $("fileImport").addEventListener("change", function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var d;
        try {
          d = JSON.parse(reader.result);
          if (!d || !Array.isArray(d.visites)) throw new Error("format");
        } catch (err) {
          toast('Fichier illisible : il doit venir du bouton « Exporter ».');
          $("fileImport").value = "";
          return;
        }
        // version absente = ancien export, accepté tel quel (voir
        // EXPORT_VERSION ci-dessus) — seule une version future et
        // incompatible serait à rejeter, pas encore le cas aujourd'hui.
        confirmDialog(
          "Importer ce fichier remplacera TOUTES vos données actuelles (plans, visites, réglages). Continuer ?",
          "Importer"
        ).then(function (ok) {
          if (!ok) { $("fileImport").value = ""; return; }
          S = d;
          delete S.version;
          if (!S.pass) S.pass = etatInitial().pass;
          if (S.gate == null) S.gate = 30;
          if (!S.plans) S.plans = {};
          sauver();
          refreshAll();
          toast("Données importées.");
          $("fileImport").value = "";
        });
      };
      reader.readAsText(f);
    });

    $("btnResetAll").addEventListener("click", function () {
      // Confirmation bloquante (pas un toast "Annuler") : contrairement aux
      // suppressions ponctuelles, ceci efface TOUT sans filet de rattrapage
      // possible après coup (pas d'état précédent à restaurer partiellement).
      confirmDialog("Vider le carnet et repartir de zéro ? Toutes vos données seront perdues.", "Tout vider").then(function (ok) {
        if (!ok) return;
        S = etatInitial();
        sauver();
        refreshAll();
        toast("Carnet vidé.");
      });
    });
  }

  /* ----------------------------------------------------------------------
   * Démarrage
   * -------------------------------------------------------------------- */

  function init() {
    document.querySelectorAll("#carnet-tabs .tab").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.getAttribute("data-tab")); });
    });
    initTabKeyboardNav();
    initTabRouting();
    syncStickyOffsets();
    window.addEventListener("resize", syncStickyOffsets);

    initJourListeners();
    initDayActionsMenu();
    initShareButton();
    initVisitesListeners();
    initPassInputs();
    initIoListeners();

    Promise.all([fetchCatalogue(), fetchDatesMap()])
      .then(function () { populerDatesConnues(); initPlanUI(); applyInitialHashTab(); })
      .catch(function (err) {
        PDF.renderErrorMessage($("jourTimeline"), "Impossible de charger le catalogue de spectacles (" + err.message + "). Le programme officiel ne pourra pas être proposé, mais l'ajout manuel reste disponible.");
      });
  }

  document.addEventListener("DOMContentLoaded", init);

  // Exposé pour les tests (tests/frontend/) — no-op dans un navigateur.
  // Le reste (conflits, planning auto, export .ics, calendrier) vit
  // maintenant dans site/js/day-plan.js, voir tests/frontend/day-plan.test.js.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { cycleSeen: cycleSeen };
  }
})();
