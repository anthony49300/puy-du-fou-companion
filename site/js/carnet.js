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
    currentVisit: null, // visite actuellement ouverte dans le panneau de détail (onglet Visites)
  };

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


  /* ----------------------------------------------------------------------
   * Onglets
   * -------------------------------------------------------------------- */

  // La barre de nav du site pointe vers carnet.html#visites/#bilan/#pass
  // pour cibler directement un onglet ("Ma journée" vit désormais sur sa
  // propre page, voir journee.html/journee.js) — doit elle-même rester en
  // phase quand on change d'onglet ICI, d'où la mise à jour du hash ci-dessous.
  var TAB_TO_HASH = { visites: "visites", bilan: "bilan", pass: "pass" };

  function switchTab(tab) {
    document.querySelectorAll("#carnet-tabs .tab").forEach(function (b) {
      var active = b.getAttribute("data-tab") === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      // Roving tabindex (pattern ARIA tablist) : seul l'onglet actif est
      // atteignable par Tab, les flèches gauche/droite font le reste.
      b.setAttribute("tabindex", active ? "0" : "-1");
    });
    ["visites", "bilan", "pass"].forEach(function (name) {
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
  // onglet précis via carnet.html#visites|bilan|pass. "#journee"/"#jour"
  // (ancres de l'ancien onglet Journée) redirigent vers journee.html — voir
  // le petit script en tête de carnet.html, avant même le chargement de ce
  // fichier : rien à faire ici pour ces deux-là.
  var HASH_TO_TAB = { visites: "visites", bilan: "bilan", pass: "pass" };

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
      var d = PDF.isoDateToday();
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

    initVisitesListeners();
    initPassInputs();
    initIoListeners();

    fetchCatalogue()
      .then(applyInitialHashTab)
      .catch(function (err) {
        PDF.toast("Impossible de charger le catalogue de spectacles (" + err.message + ").");
        applyInitialHashTab();
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
