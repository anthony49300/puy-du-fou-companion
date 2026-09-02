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

  var STORAGE_KEY = "pdf-carnet-v1";
  var MOIS = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
  ];
  // Clé pseudo-slug utilisée pour les ajouts manuels (ex: Cinéscénie, non
  // couverte par la collecte officielle) dans le carnet de visites.
  var MANUAL_PREFIX = "manuel:";

  function etatInitial() {
    return {
      visites: [], // [{date, moment, com, seen: {slugOuCleManuelle: nombreDeFois}}]
      plans: {}, // {"2026-08-26": {moment, items: [{uid, slug, name, category, start, end, is_continuous}]}}
      gate: 30,
      pass: { prixPass: 199, prixBillet: 47, prixCine: 32, fraisVisite: 0 },
    };
  }

  var stockageOk = true;
  function charger() {
    try {
      var brut = localStorage.getItem(STORAGE_KEY);
      if (brut) return JSON.parse(brut);
    } catch (e) { stockageOk = false; }
    return null;
  }
  function sauver() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S)); }
    catch (e) { stockageOk = false; }
  }

  var S = charger() || etatInitial();
  if (!S.pass) S.pass = etatInitial().pass;
  if (S.gate == null) S.gate = 30;
  if (!S.plans) S.plans = {};
  if (!S.visites) S.visites = [];

  var state = {
    catalogue: [], // [{slug, name, category}] triés par nom
    catalogueBySlug: {},
    datesMap: {}, // "2026-08-26" -> season_year (pour construire le chemin history/)
    realDayCache: {}, // "2026-08-26" -> payload today.json/history, ou null si indisponible
    currentRealSlots: [], // options actuellement proposées dans le select "programme officiel"
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function eur(n) {
    return n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  }
  function toast(msg) {
    document.querySelectorAll(".toast-msg").forEach(function (t) { t.remove(); });
    var t = document.createElement("div");
    t.className = "toast-msg";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
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
      (data.dates || []).forEach(function (rec) { state.datesMap[rec.date] = rec.season_year; });
    });
  }

  // Toute date du calendrier (aujourd'hui, demain une fois publié...) ou de
  // l'historique (jours passés) déjà collectée peut être chargée dans
  // "Journée" — pas seulement aujourd'hui/demain. On rend ça visible via la
  // liste suggérée du champ date (list="planDates") et un texte d'aide.
  function populerDatesConnues() {
    var dates = Object.keys(state.datesMap).sort();
    var dl = $("planDates");
    if (dl) dl.innerHTML = dates.map(function (d) { return '<option value="' + d + '"></option>'; }).join("");
    var hint = $("planDatesHint");
    if (hint) {
      hint.textContent = dates.length
        ? "Programme officiel disponible du " + PDF.formatDateFR(dates[0]) + " au " + PDF.formatDateFR(dates[dates.length - 1]) +
          " (calendrier et historique — " + dates.length + " jour" + (dates.length > 1 ? "s" : "") + "). Suggestions dans le champ date."
        : "Aucun programme officiel collecté pour le moment.";
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
      promise = PDF.fetchJSON(PDF.historyJsonPath(dateStr, state.datesMap[dateStr]));
    } else {
      promise = Promise.resolve(null);
    }
    return promise.catch(function () { return null; }).then(function (data) {
      state.realDayCache[dateStr] = data;
      return data;
    });
  }

  function realDayToSlots(dayData) {
    var slots = [];
    (dayData.spectacles || []).forEach(function (sp) {
      (sp.representations || []).forEach(function (rep) {
        slots.push({
          slug: sp.slug, name: sp.name, category: sp.category,
          start: rep.start, end: rep.end, is_continuous: !!rep.is_continuous, status: rep.status,
        });
      });
    });
    slots.sort(function (a, b) {
      if (a.is_continuous && b.is_continuous) return 0;
      if (a.is_continuous) return -1;
      if (b.is_continuous) return 1;
      return (a.start || "").localeCompare(b.start || "");
    });
    return slots;
  }

  /* ----------------------------------------------------------------------
   * Onglets
   * -------------------------------------------------------------------- */

  function switchTab(tab) {
    document.querySelectorAll("#carnet-tabs .chip").forEach(function (b) {
      var active = b.getAttribute("data-tab") === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    ["jour", "visites", "bilan", "pass"].forEach(function (name) {
      $("tab-" + name).hidden = name !== tab;
    });
    if (tab === "visites") renderVisites();
    if (tab === "bilan") renderBilan();
    if (tab === "pass") renderPass();
  }

  /* ----------------------------------------------------------------------
   * Onglet Journée
   * -------------------------------------------------------------------- */

  function planCourant(dateStr) {
    if (!dateStr) return null;
    if (!S.plans[dateStr]) S.plans[dateStr] = { moment: "Jour", items: [] };
    return S.plans[dateStr];
  }

  function itemsFixesTries(plan) {
    return plan.items
      .filter(function (it) { return !it.is_continuous && it.start && it.end; })
      .sort(function (a, b) { return a.start.localeCompare(b.start); });
  }

  function detecterConflits(fixes, gate) {
    var out = [];
    for (var i = 0; i < fixes.length - 1; i++) {
      var a = fixes[i], b = fixes[i + 1];
      var finA = PDF.timeToMinutes(a.end);
      var debB = PDF.timeToMinutes(b.start);
      var portesB = debB - gate;
      if (finA > debB) out.push({ a: a, b: b, chevauchement: true });
      else if (finA > portesB) out.push({ a: a, b: b, chevauchement: false });
    }
    return out;
  }

  // Pire sévérité impliquant `it` : "error" (chevauchement réel des deux
  // séances) prime sur "warn" (juste trop juste pour les portes) ; null si
  // l'item n'est concerné par aucune alerte.
  function severiteConflit(it, conflits) {
    var pire = null;
    conflits.forEach(function (c) {
      if (c.a !== it && c.b !== it) return;
      if (c.chevauchement) pire = "error";
      else if (!pire) pire = "warn";
    });
    return pire;
  }

  // Un item "identique" (même spectacle/nom, mêmes horaires) est déjà dans
  // le plan : évite les doublons quand on clique deux fois sur "Ajouter".
  function planItemExists(plan, candidate) {
    var cle = candidate.slug || candidate.name;
    return plan.items.some(function (it) {
      return (it.slug || it.name) === cle &&
        it.start === candidate.start && it.end === candidate.end &&
        !!it.is_continuous === !!candidate.is_continuous;
    });
  }

  function renderJour() {
    var dateStr = $("planDate").value;
    var plan = planCourant(dateStr);
    $("planMoment").value = plan.moment || "Jour";
    $("planHint").textContent = stockageOk ? "" : "Stockage local indisponible : pensez à exporter vos données.";

    var tous = plan.items.slice().sort(function (a, b) {
      if (a.is_continuous && b.is_continuous) return 0;
      if (a.is_continuous) return -1;
      if (b.is_continuous) return 1;
      return (a.start || "").localeCompare(b.start || "");
    });
    var fixes = itemsFixesTries(plan);
    var conflits = detecterConflits(fixes, S.gate);

    renderTimeline(tous, conflits);
    renderAlertes(tous, conflits);
  }

  // Minutes depuis minuit -> "HH:MM" (inverse de PDF.timeToMinutes), avec
  // repli circulaire si la marge fait passer avant minuit (cas limite
  // improbable vu les horaires réels du parc, géré par prudence).
  function minutesToHHMM(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function renderTimeline(items, conflits) {
    var el = $("jourTimeline");
    if (!items.length) {
      el.innerHTML =
        '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🗓️</div>' +
        "<p>Ajoutez un spectacle pour composer cette journée — depuis le programme officiel, ou manuellement.</p></div>";
      return;
    }
    el.innerHTML =
      '<div class="timeline">' +
      items.map(function (it) {
        var sev = severiteConflit(it, conflits);
        var cls = "rep-card" +
          (it.category === "spectacle_nocturne" ? " is-nocturne" : "") +
          (sev === "error" ? " is-conflict" : sev === "warn" ? " is-conflict-warn" : "");
        var timeLabel = it.is_continuous
          ? "En continu" + (it.end ? " " + PDF.formatTimeFR(it.start) + "–" + PDF.formatTimeFR(it.end) : "")
          : PDF.formatTimeFR(it.start) + (it.end ? "–" + PDF.formatTimeFR(it.end) : "");
        // Heure d'ouverture des portes : n'a de sens que pour une séance
        // ponctuelle (file d'attente) — pas pour un accès en continu.
        var gateLabel = (!it.is_continuous && it.start)
          ? "🚪 portes " + PDF.formatTimeFR(minutesToHHMM(PDF.timeToMinutes(it.start) - S.gate))
          : "";
        var badges = it.slug
          ? PDF.representationBadges({ start: it.start, is_continuous: it.is_continuous, status: it.status || "scheduled" }, it.category)
          : '<span class="badge badge-default">Ajout manuel</span>';
        if (sev === "error") badges += '<span class="badge badge-conflict-error">⛔ Chevauchement</span>';
        else if (sev === "warn") badges += '<span class="badge badge-conflict-warn">⚠️ Portes justes</span>';
        return (
          '<div class="' + cls + '">' +
          '<div class="rep-time">' +
          '<span class="rep-time-main">' + PDF.escapeHtml(timeLabel) + "</span>" +
          (gateLabel ? '<span class="rep-time-gate">' + PDF.escapeHtml(gateLabel) + "</span>" : "") +
          "</div>" +
          '<div class="rep-name">' + PDF.escapeHtml(it.name) + "</div>" +
          '<div class="rep-badges">' + badges + "</div>" +
          '<button type="button" class="btn btn-outline no-print" data-remove="' + it.uid + '" aria-label="Retirer ' + PDF.escapeHtml(it.name) + '" style="padding:0.35rem 0.6rem;">✕</button>' +
          "</div>"
        );
      }).join("") +
      "</div>";
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
        " — " + s.name;
      return '<option value="' + i + '">' + PDF.escapeHtml(label) + "</option>";
    }).join("");
    wrap.hidden = false;
  }

  function initJourListeners() {
    $("planDate").addEventListener("change", function () {
      state.currentRealSlots = [];
      $("addFromRealWrap").hidden = true;
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
        btn.disabled = false;
        if (!dayData) {
          populerSelectReel([]);
          toast("Aucune donnée officielle pour cette date (hors saison, pas encore publiée, ou trop ancienne) : ajoutez manuellement, ou choisissez une date suggérée par le champ date.");
          return;
        }
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
      });
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
      if (confirm("Vider le programme de cette journée ?")) {
        plan.items = [];
        sauver();
        renderJour();
      }
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

    $("btnPrintDay").addEventListener("click", function () { window.print(); });
  }

  function initPlanUI() {
    $("planDate").value = PDF.isoDateToday();
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
        '<span class="visit-note" data-moment="' + vi + '" title="Cliquer pour changer la formule" style="cursor:pointer">' +
        PDF.escapeHtml(v.moment || "Jour") + "</span>" +
        (v.com ? '<span class="visit-note">' + PDF.escapeHtml(v.com) + "</span>" : "") +
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
        var v = vs[+parts[0]], key = parts[1];
        var n = v.seen[key] || 0;
        if (n >= 2) delete v.seen[key]; else v.seen[key] = n + 1;
        sauver();
        renderVisites();
      });
    });
    table.querySelectorAll("[data-delv]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var v = vs[+btn.getAttribute("data-delv")];
        if (confirm("Supprimer la visite du " + PDF.formatDateFR(v.date) + " ?")) {
          S.visites = S.visites.filter(function (x) { return x !== v; });
          sauver();
          renderVisites();
        }
      });
    });
    table.querySelectorAll("[data-moment]").forEach(function (span) {
      span.addEventListener("click", function () {
        var v = vs[+span.getAttribute("data-moment")];
        var ordre = ["Jour", "Après-midi", "Soirée"];
        var i = ordre.indexOf(v.moment || "Jour");
        v.moment = ordre[(i + 1) % ordre.length];
        sauver();
        renderVisites();
      });
    });
  }

  function initVisitesListeners() {
    $("btnAddVisit").addEventListener("click", function () {
      var d = prompt("Date de la visite (AAAA-MM-JJ) :", $("planDate").value || PDF.isoDateToday());
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      if (S.visites.some(function (v) { return v.date === d; })) return toast("Cette date est déjà au carnet.");
      var com = prompt("Commentaire (facultatif) :", "") || "";
      S.visites.push({ date: d, moment: "Jour", com: com, seen: {} });
      S.visites.sort(function (a, b) { return a.date.localeCompare(b.date); });
      sauver();
      renderVisites();
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
      ["Par visite", st.moyenne.toFixed(1)],
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

  function initIoListeners() {
    $("btnExport").addEventListener("click", function () {
      var blob = new Blob([JSON.stringify(S, null, 2)], { type: "application/json" });
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
        try {
          var d = JSON.parse(reader.result);
          if (!d || !Array.isArray(d.visites)) throw new Error("format");
          S = d;
          if (!S.pass) S.pass = etatInitial().pass;
          if (S.gate == null) S.gate = 30;
          if (!S.plans) S.plans = {};
          sauver();
          refreshAll();
          toast("Données importées.");
        } catch (err) {
          toast('Fichier illisible : il doit venir du bouton « Exporter ».');
        }
      };
      reader.readAsText(f);
      e.target.value = "";
    });

    $("btnResetAll").addEventListener("click", function () {
      if (!confirm("Vider le carnet et repartir de zéro ? Toutes vos données seront perdues.")) return;
      S = etatInitial();
      sauver();
      refreshAll();
      toast("Carnet vidé.");
    });
  }

  /* ----------------------------------------------------------------------
   * Démarrage
   * -------------------------------------------------------------------- */

  function init() {
    document.querySelectorAll("#carnet-tabs .chip").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.getAttribute("data-tab")); });
    });

    initJourListeners();
    initVisitesListeners();
    initPassInputs();
    initIoListeners();

    Promise.all([fetchCatalogue(), fetchDatesMap()])
      .then(function () { populerDatesConnues(); initPlanUI(); })
      .catch(function (err) {
        PDF.renderErrorMessage($("jourTimeline"), "Impossible de charger le catalogue de spectacles (" + err.message + "). Le programme officiel ne pourra pas être proposé, mais l'ajout manuel reste disponible.");
      });
  }

  document.addEventListener("DOMContentLoaded", init);

  // Exposé pour les tests (tests/frontend/) — no-op dans un navigateur.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      detecterConflits: detecterConflits, planItemExists: planItemExists, severiteConflit: severiteConflit,
      minutesToHHMM: minutesToHHMM,
    };
  }
})();
