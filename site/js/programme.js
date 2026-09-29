/* =========================================================================
   programme.js — logique de la page "Programme du jour"
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  var state = {
    today: null,
    query: "",
    category: "",
    dayOffset: 0, // 0 = aujourd'hui, 1 = demain, 2 = après-demain
    refreshTimer: null,
  };

  var searchBar = null; // affecté dans init() ; utilisé pour vider le champ au changement de jour

  var DAY_LABELS = ["Aujourd'hui", "Demain", "Après-demain"];

  // Sentinelle volontairement grande (pas null) : un créneau sans heure
  // exploitable doit trier en dernier, pas planter la comparaison.
  function sortKeyMinutes(t) {
    if (!t) return 99999;
    var m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return 99999;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function durationMinutes(start, end) {
    if (!start || !end) return null;
    var s = PDF.timeToMinutes(start);
    var e = PDF.timeToMinutes(end);
    if (s == null || e == null) return null;
    var diff = e - s;
    if (diff <= 0) diff += 24 * 60; // passage de minuit
    return diff;
  }

  // Date réelle du navigateur + N jours, au format ISO ("YYYY-MM-DD") — pas
  // la date du payload chargé, qui peut être un repli "stale" différent.
  function dateForOffset(offset) {
    var d = new Date();
    d.setDate(d.getDate() + offset);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // Construit une liste plate de "créneaux" { spectacle, rep, sortKey }
  function buildSlots(today) {
    var slots = [];
    (today.spectacles || []).forEach(function (spectacle) {
      (spectacle.representations || []).forEach(function (rep) {
        slots.push({
          spectacle: spectacle,
          rep: rep,
          sortKey: rep.is_continuous ? -1 : sortKeyMinutes(rep.start),
        });
      });
    });
    slots.sort(function (a, b) {
      // Les créneaux "en continu" en premier, puis par heure croissante
      if (a.sortKey === -1 && b.sortKey === -1) return 0;
      if (a.sortKey === -1) return -1;
      if (b.sortKey === -1) return 1;
      return a.sortKey - b.sortKey;
    });
    return slots;
  }

  function slotMatchesFilters(slot) {
    if (state.category && slot.spectacle.category !== state.category) return false;
    if (state.query && !PDF.matchesSearch(slot.spectacle.name, state.query)) return false;
    return true;
  }

  function renderSlot(slot, opts) {
    opts = opts || {};
    var rep = slot.rep;
    var spectacle = slot.spectacle;
    var timeLabel = rep.is_continuous
      ? (rep.end ? PDF.formatTimeFR(rep.start) + "–" + PDF.formatTimeFR(rep.end) : "En continu")
      : PDF.formatTimeFR(rep.start);
    // "En continu" est déjà porté par le badge (representationBadges) : pas
    // besoin de le répéter dans le libellé horaire.
    var duration = !rep.is_continuous ? durationMinutes(rep.start, rep.end) : null;
    var classes = "rep-card";
    if (spectacle.category === "spectacle_nocturne" || PDF.isLateHour(rep.start)) classes += " is-nocturne";
    if (opts.isPast) classes += " is-past";

    var countdownHtml = "";
    if (opts.minutesUntil != null) {
      var label = opts.minutesUntil <= 0 ? "Maintenant" : "Dans " + opts.minutesUntil + " min";
      countdownHtml = '<div class="rep-countdown">' + PDF.escapeHtml(label) + "</div>";
    }

    return (
      '<div class="' + classes + '">' +
      '<div class="rep-time-wrap">' +
      '<div class="rep-time">' + PDF.escapeHtml(timeLabel) + "</div>" +
      (duration != null ? '<div class="rep-duration">' + duration + " min</div>" : "") +
      countdownHtml +
      "</div>" +
      '<div class="rep-name">' + PDF.escapeHtml(spectacle.name) + "</div>" +
      '<div class="rep-badges">' +
      PDF.representationBadges(rep, spectacle.category) +
      "</div>" +
      "</div>"
    );
  }

  function renderHourNav(entries) {
    var nav = document.getElementById("hour-nav");
    if (!nav) return;
    if (entries.length < 2) { nav.hidden = true; nav.innerHTML = ""; return; }
    nav.hidden = false;
    // Le header du site est lui-même sticky (top:0, voir style.css) : sans
    // ce décalage, la barre d'heures se collerait dessous et disparaîtrait
    // derrière lui au défilement (même top:0, z-index plus faible).
    var header = document.getElementById("site-header");
    nav.style.top = (header ? header.offsetHeight : 0) + "px";
    nav.innerHTML = entries.map(function (e) {
      return '<button type="button" class="hour-nav-btn" data-target="' + e.id + '">' + PDF.escapeHtml(e.label) + "</button>";
    }).join("");
    nav.querySelectorAll(".hour-nav-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var target = document.getElementById(btn.getAttribute("data-target"));
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function renderProgramme() {
    var container = document.getElementById("programme-content");
    var allSlots = buildSlots(state.today);
    var slots = allSlots.filter(slotMatchesFilters);

    if (allSlots.length === 0) {
      // Aucune représentation du tout (pas juste filtrée à zéro) : le plus
      // souvent un jour de fermeture (voir le bandeau de statut au-dessus,
      // qui explique pourquoi) — jamais présenter ça comme un résultat de
      // recherche infructueux.
      container.innerHTML =
        '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🌙</div>' +
        "<p>Aucun spectacle programmé ce jour-là.</p></div>";
      renderHourNav([]);
      return;
    }
    if (slots.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🔍</div>' +
        "<p>Aucune représentation ne correspond à votre recherche.</p></div>";
      renderHourNav([]);
      return;
    }

    // Ne griser/replier les séances passées et ne calculer un "dans X min"
    // que si l'heure réelle du visiteur a un sens pour CE jour affiché
    // (le vrai "aujourd'hui", jamais demain/après-demain ni un repli
    // "stale" sur une autre date).
    var isToday = PDF.isDataForToday(state.today.date);
    var nowMinutes = isToday ? new Date().getHours() * 60 + new Date().getMinutes() : null;

    var continuousSlots = slots.filter(function (s) { return s.rep.is_continuous; });
    var timedSlots = slots.filter(function (s) { return !s.rep.is_continuous; });

    var pastSlots = [], withinHourSlots = [], upcomingSlots = [];
    if (isToday) {
      timedSlots.forEach(function (s) {
        var mins = PDF.timeToMinutes(s.rep.start);
        if (mins == null) { upcomingSlots.push(s); return; }
        var delta = mins - nowMinutes;
        if (delta < 0) pastSlots.push(s);
        else if (delta <= 60) withinHourSlots.push(s);
        else upcomingSlots.push(s);
      });
    } else {
      upcomingSlots = timedSlots;
    }

    var html = "";

    if (continuousSlots.length) {
      html += '<div class="timeline-hour-group"><div class="timeline-hour-label">En continu</div>';
      continuousSlots.forEach(function (s) { html += renderSlot(s); });
      html += "</div>";
    }

    if (pastSlots.length) {
      var n = pastSlots.length;
      html +=
        '<details class="past-sessions"><summary>Voir ' + (n > 1 ? "les " + n + " séances passées" : "la séance passée") + "</summary>" +
        '<div class="timeline-hour-group">';
      pastSlots.forEach(function (s) { html += renderSlot(s, { isPast: true }); });
      html += "</div></details>";
    }

    var navEntries = [];
    if (withinHourSlots.length) {
      html += '<div class="within-hour-group" id="hour-group-now"><div class="within-hour-label">Dans l\'heure</div>';
      withinHourSlots.forEach(function (s) {
        html += renderSlot(s, { minutesUntil: PDF.timeToMinutes(s.rep.start) - nowMinutes });
      });
      html += "</div>";
      navEntries.push({ label: "Maintenant", id: "hour-group-now" });
    }

    var lastGroupLabel = null;
    upcomingSlots.forEach(function (slot) {
      var groupLabel = slot.rep.start ? PDF.formatTimeFR(slot.rep.start).replace(/h\d+$/, "h00") : "Horaire inconnu";
      if (groupLabel !== lastGroupLabel) {
        if (lastGroupLabel !== null) html += "</div>";
        var anchorId = "hour-group-" + groupLabel.replace(/[^0-9]/g, "");
        html += '<div class="timeline-hour-group" id="' + anchorId + '"><div class="timeline-hour-label">' + PDF.escapeHtml(groupLabel) + "</div>";
        lastGroupLabel = groupLabel;
        if (groupLabel !== "Horaire inconnu") navEntries.push({ label: groupLabel, id: anchorId });
      }
      html += renderSlot(slot);
    });
    if (lastGroupLabel !== null) html += "</div>";

    container.innerHTML = '<div class="timeline">' + html + "</div>";
    renderHourNav(navEntries);
  }

  // Un changement de jour ne doit pas accumuler les <option> précédentes :
  // on ne garde que "Toutes les catégories" avant de repeupler.
  function resetCategoryFilter(today) {
    var select = document.getElementById("category-filter");
    while (select.options.length > 1) select.remove(1);
    select.value = "";
    var categories = {};
    (today.spectacles || []).forEach(function (s) { categories[s.category] = true; });
    Object.keys(categories).sort().forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = PDF.categoryLabel(cat);
      select.appendChild(opt);
    });
  }

  // Rafraîchit périodiquement l'affichage (grisé des séances passées,
  // compte à rebours "dans l'heure") uniquement quand la page montre le
  // vrai aujourd'hui — inutile et potentiellement trompeur sur demain/
  // après-demain ou un repli figé sur une autre date.
  function scheduleAutoRefresh() {
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    if (state.today && PDF.isDataForToday(state.today.date)) {
      state.refreshTimer = setInterval(renderProgramme, 60000);
    }
  }

  function renderDaySelect() {
    var wrap = document.getElementById("day-select");
    if (!wrap) return;
    wrap.innerHTML = DAY_LABELS.map(function (label, i) {
      return '<button type="button" class="chip' + (i === state.dayOffset ? " active" : "") + '" data-offset="' + i + '">' + label + "</button>";
    }).join("");
    wrap.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var offset = +btn.getAttribute("data-offset");
        if (offset === state.dayOffset) return;
        state.dayOffset = offset;
        renderDaySelect();
        loadDay(offset);
      });
    });
  }

  function applyPayload(payload, offset) {
    state.today = payload;
    state.query = "";
    state.category = "";
    if (searchBar) searchBar.inputEl.value = "";
    document.getElementById("programme-date").textContent =
      "Programme du " + PDF.formatDateLongFR(payload.date) +
      " — " + (payload.spectacle_count != null ? payload.spectacle_count : "?") + " spectacles, " +
      (payload.representation_count != null ? payload.representation_count : "?") + " représentations.";
    document.getElementById("status-banner-slot").innerHTML =
      PDF.seasonClosedBannerHtml(payload) ||
      PDF.statusBannerHtml(payload.status, payload.date, (payload.representation_count || 0) > 0, offset === 0);
    // Rien à filtrer/rechercher un jour de fermeture : la barre de
    // recherche + le sélecteur de catégorie n'ont plus de sens.
    var hasSlots = (payload.spectacles || []).length > 0;
    var searchBarWrap = document.getElementById("search-bar-wrap");
    if (searchBarWrap) searchBarWrap.hidden = !hasSlots;
    resetCategoryFilter(payload);
    renderProgramme();
    scheduleAutoRefresh();
  }

  function loadDay(offset) {
    document.getElementById("programme-content").innerHTML =
      '<div class="empty-state"><div class="skeleton" style="height:2.4rem;max-width:420px;margin:0 auto;"></div></div>';
    document.getElementById("status-banner-slot").innerHTML = "";
    var promise = offset === 0
      ? PDF.fetchJSON("today.json")
      // La source publie toujours J/J+1/J+2 en un seul chargement côté
      // collecte (voir SCHEDULE_PAGE_URL) : le fichier d'historique du
      // jour existe donc déjà dès la collecte du jour même.
      : PDF.fetchJSON(PDF.historyJsonPath(dateForOffset(offset)));

    return promise
      .then(function (payload) { applyPayload(payload, offset); })
      .catch(function (err) {
        if (err.notFound && offset > 0) {
          document.getElementById("programme-date").textContent = "";
          document.getElementById("programme-content").innerHTML =
            '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🌙</div>' +
            "<p>Programme pas encore publié pour ce jour.</p></div>";
          var searchBarWrap = document.getElementById("search-bar-wrap");
          if (searchBarWrap) searchBarWrap.hidden = true;
          renderHourNav([]);
          return;
        }
        document.getElementById("programme-date").textContent = "";
        PDF.renderErrorMessage(
          document.getElementById("programme-content"),
          "Impossible de charger le programme (" + err.message + "). Vérifiez votre connexion ou réessayez plus tard."
        );
      });
  }

  function init() {
    searchBar = PDF.createSearchBar(document.getElementById("search-slot"), {
      placeholder: "Rechercher un spectacle (ex: Vikings)…",
      onChange: function (value) {
        state.query = value;
        renderProgramme();
      },
    });
    document.getElementById("category-filter").addEventListener("change", function (e) {
      state.category = e.target.value;
      renderProgramme();
    });

    renderDaySelect();
    loadDay(0);

    // Le décalage sous le header sticky (voir renderHourNav) dépend de sa
    // hauteur, qui change au franchissement du point de rupture mobile.
    window.addEventListener("resize", function () {
      var nav = document.getElementById("hour-nav");
      var header = document.getElementById("site-header");
      if (nav && !nav.hidden && header) nav.style.top = header.offsetHeight + "px";
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
