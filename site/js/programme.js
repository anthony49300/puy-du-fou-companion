/* =========================================================================
   programme.js — logique de la page "Programme du jour"
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  var state = {
    today: null,
    query: "",
    filter: "tout", // "tout" | "spectacle" | "spectacle_immersif" | "spectacle_nocturne" | "favoris"
    dayOffset: 0, // 0 = aujourd'hui, 1 = demain, 2 = après-demain
    refreshTimer: null,
  };

  var searchBar = null; // affecté dans init() ; utilisé pour vider le champ au changement de jour

  var DAY_LABELS = ["Aujourd'hui", "Demain", "Après-demain"];
  var FILTERS = [
    { key: "tout", label: "Tout" },
    { key: "spectacle", label: "Spectacles" },
    { key: "spectacle_immersif", label: "Immersifs" },
    { key: "spectacle_nocturne", label: "Nocturne" },
    { key: "favoris", label: "Favoris" },
  ];

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

  // Sépare les créneaux À HEURE FIXE (pas "en continu") en deux groupes
  // selon `nowMinutes` : passés / à venir. `nowMinutes` nul (page ne
  // représentant pas le vrai aujourd'hui du visiteur) => tout "à venir",
  // rien à griser (jamais de notion de passé/futur hors du vrai jour).
  function categorizeSlots(timedSlots, nowMinutes) {
    if (nowMinutes == null) return { past: [], upcoming: timedSlots.slice() };
    var past = [], upcoming = [];
    timedSlots.forEach(function (s) {
      var mins = PDF.timeToMinutes(s.rep.start);
      if (mins == null) { upcoming.push(s); return; }
      if (mins < nowMinutes) past.push(s); else upcoming.push(s);
    });
    return { past: past, upcoming: upcoming };
  }

  function isFavorite(slug) {
    try { return !!slug && PDF.isFavorite(slug); } catch (e) { return false; }
  }

  function slotMatchesFilters(slot) {
    if (state.filter === "favoris") {
      if (!isFavorite(slot.spectacle.slug)) return false;
    } else if (state.filter && state.filter !== "tout") {
      if (slot.spectacle.category !== state.filter) return false;
    }
    if (state.query && !PDF.matchesSearch(slot.spectacle.name, state.query)) return false;
    return true;
  }

  function starButtonHtml(slug) {
    if (!slug) return "";
    var fav = isFavorite(slug);
    return (
      '<button type="button" class="star-btn' + (fav ? " is-fav" : "") + '" data-fav-slug="' + PDF.escapeHtml(slug) + '" ' +
      'aria-label="' + (fav ? "Retirer des favoris" : "Ajouter aux favoris") + '" aria-pressed="' + fav + '">' +
      PDF.icon(fav ? "star-filled" : "star") +
      "</button>"
    );
  }

  function addButtonHtml(slot) {
    if (slot.rep.is_continuous || !slot.rep.start || !state.today) return "";
    var already = false;
    try { already = PDF.isInPlan(state.today.date, slot.spectacle.slug || slot.spectacle.name, slot.rep.start); } catch (e) { /* ignore */ }
    return (
      '<button type="button" class="add-to-day-btn add-to-day-trigger' + (already ? " is-added" : "") + '" ' +
      'data-slug="' + PDF.escapeHtml(slot.spectacle.slug || "") + '" data-name="' + PDF.escapeHtml(slot.spectacle.name) + '" ' +
      'data-category="' + PDF.escapeHtml(slot.spectacle.category || "") + '" data-start="' + slot.rep.start + '" data-end="' + (slot.rep.end || "") + '" ' +
      'aria-label="' + (already ? "Déjà dans ma journée" : "Ajouter à ma journée") + '" aria-pressed="' + already + '">' +
      (already ? "✓" : "+") +
      "</button>"
    );
  }

  function renderSlot(slot, opts) {
    opts = opts || {};
    var rep = slot.rep;
    var spectacle = slot.spectacle;
    var timeLabel = rep.is_continuous
      ? (rep.end ? PDF.formatTimeFR(rep.start) + "–" + PDF.formatTimeFR(rep.end) : "En continu")
      : PDF.formatTimeFR(rep.start);
    var duration = !rep.is_continuous ? durationMinutes(rep.start, rep.end) : null;
    var classes = "rep-card";
    if (spectacle.category === "spectacle_nocturne" || PDF.isLateHour(rep.start)) classes += " is-nocturne";
    if (opts.isPast) classes += " is-past";

    var metaParts = [];
    if (opts.isLastShowing) metaParts.push("Dernière séance");
    else if (duration != null) metaParts.push(duration + " min");
    if (opts.isNextUpcoming) metaParts.push(opts.minutesUntil <= 0 ? "maintenant" : "dans " + opts.minutesUntil + " min");
    var metaHtml = metaParts.length
      ? '<div class="rep-duration' + (opts.isLastShowing ? " is-warn" : "") + '">' + PDF.escapeHtml(metaParts.join(" · ")) + "</div>"
      : "";

    return (
      '<div class="' + classes + '">' +
      '<div class="rep-time-wrap">' +
      '<div class="rep-time tnum">' + PDF.escapeHtml(timeLabel) + "</div>" +
      metaHtml +
      "</div>" +
      '<div class="rep-name">' + PDF.escapeHtml(spectacle.name) + "</div>" +
      '<div class="rep-badges">' +
      PDF.representationBadges(rep, spectacle.category) +
      "</div>" +
      starButtonHtml(spectacle.slug) +
      addButtonHtml(slot) +
      "</div>"
    );
  }

  function renderHourNav(entries) {
    var nav = document.getElementById("hour-nav");
    if (!nav) return;
    if (entries.length < 2) { nav.hidden = true; nav.innerHTML = ""; return; }
    nav.hidden = false;
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

  /* ------------------------------------------------------------------
   * Mini-Gantt "Accès continu"
   * ---------------------------------------------------------------- */
  function dayBounds(allSlots) {
    var min = null, max = null;
    allSlots.forEach(function (s) {
      [PDF.timeToMinutes(s.rep.start), PDF.timeToMinutes(s.rep.end)].forEach(function (v) {
        if (v == null) return;
        if (min == null || v < min) min = v;
        if (max == null || v > max) max = v;
      });
    });
    return { min: min, max: max };
  }

  function renderContinuousGantt(continuousSlots, bounds, isToday, nowMinutes) {
    var slot = document.getElementById("continuous-gantt-slot");
    if (!slot) return;
    var span = bounds.max != null && bounds.min != null ? bounds.max - bounds.min : 0;
    if (!continuousSlots.length || span <= 0) { slot.innerHTML = ""; return; }
    var nowPct = isToday && nowMinutes != null ? Math.min(100, Math.max(0, ((nowMinutes - bounds.min) / span) * 100)) : null;
    var rows = continuousSlots.map(function (s) {
      var a = PDF.timeToMinutes(s.rep.start), b = PDF.timeToMinutes(s.rep.end);
      if (a == null || b == null) return "";
      var left = ((a - bounds.min) / span) * 100;
      var width = Math.max(1, ((b - a) / span) * 100);
      var isPast = isToday && nowMinutes != null && b <= nowMinutes;
      return (
        '<div class="mini-gantt-row">' +
        '<div class="mini-gantt-label">' + PDF.escapeHtml(s.spectacle.name) + "</div>" +
        '<div class="mini-gantt-track">' +
        '<div class="mini-gantt-bar' + (isPast ? " is-past" : "") + '" style="left:' + left + "%;width:" + width + '%"></div>' +
        (nowPct != null ? '<div class="mini-gantt-now" style="left:' + nowPct + '%"></div>' : "") +
        "</div></div>"
      );
    }).join("");
    slot.innerHTML = '<div class="card"><div class="section-label">Accès continu</div><div class="mini-gantt">' + rows + "</div></div>";
  }

  /* ------------------------------------------------------------------
   * Rendu principal
   * ---------------------------------------------------------------- */
  function renderProgramme() {
    var container = document.getElementById("programme-content");
    var allSlots = buildSlots(state.today);
    var slots = allSlots.filter(slotMatchesFilters);

    var isToday = PDF.isDataForToday(state.today.date);
    var now = new Date();
    var nowMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : null;

    var continuousAll = allSlots.filter(function (s) { return s.rep.is_continuous; });
    renderContinuousGantt(continuousAll.filter(slotMatchesFilters), dayBounds(allSlots), isToday, nowMinutes);

    if (allSlots.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🌙</div>' +
        "<p>Aucun spectacle programmé ce jour-là.</p></div>";
      renderHourNav([]);
      return;
    }
    if (slots.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🔍</div>' +
        "<p>Aucune représentation ne correspond à votre recherche ou à ce filtre.</p></div>";
      renderHourNav([]);
      return;
    }

    var continuousSlots = slots.filter(function (s) { return s.rep.is_continuous; });
    var timedSlots = slots.filter(function (s) { return !s.rep.is_continuous; });
    var cat = categorizeSlots(timedSlots, nowMinutes);

    // lastShowingSlugs réutilise exactement la même règle que l'accueil
    // (voir PDF.computeUpcoming, site/js/app.js) plutôt que de la
    // réécrire ici — seule la liste nous intéresse, pas next/inProgress.
    var lastShowingSlugs = isToday ? PDF.computeUpcoming(state.today, now).lastShowingSlugs : [];
    var nextUpcomingSlot = cat.upcoming.length
      ? cat.upcoming.slice().sort(function (a, b) { return sortKeyMinutes(a.rep.start) - sortKeyMinutes(b.rep.start); })[0]
      : null;

    var html = "";

    if (continuousSlots.length) {
      html += '<div class="timeline-hour-group"><div class="timeline-hour-label">En continu</div>';
      continuousSlots.forEach(function (s) { html += renderSlot(s); });
      html += "</div>";
    }

    if (cat.past.length) {
      var n = cat.past.length;
      html +=
        '<details class="past-sessions"><summary>Afficher ' + (n > 1 ? "les " + n + " séances passées" : "la séance passée") + "</summary>" +
        '<div class="timeline-hour-group">';
      cat.past.forEach(function (s) { html += renderSlot(s, { isPast: true }); });
      html += "</div></details>";
    }

    if (isToday) {
      html += '<div class="now-divider">Maintenant · ' + PDF.escapeHtml(PDF.formatTimeFR(
        (String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0"))
      )) + "</div>";
    }

    var navEntries = [];
    var lastGroupLabel = null;
    cat.upcoming
      .slice()
      .sort(function (a, b) { return sortKeyMinutes(a.rep.start) - sortKeyMinutes(b.rep.start); })
      .forEach(function (slot) {
        var groupLabel = slot.rep.start ? PDF.formatTimeFR(slot.rep.start).replace(/h\d+$/, "h00") : "Horaire inconnu";
        if (groupLabel !== lastGroupLabel) {
          if (lastGroupLabel !== null) html += "</div>";
          var anchorId = "hour-group-" + groupLabel.replace(/[^0-9]/g, "");
          html += '<div class="timeline-hour-group" id="' + anchorId + '"><div class="timeline-hour-label">' + PDF.escapeHtml(groupLabel) + "</div>";
          lastGroupLabel = groupLabel;
          if (groupLabel !== "Horaire inconnu") navEntries.push({ label: groupLabel, id: anchorId });
        }
        var isNextUpcoming = slot === nextUpcomingSlot;
        var minutesUntil = isNextUpcoming && nowMinutes != null ? PDF.timeToMinutes(slot.rep.start) - nowMinutes : null;
        var isLastShowing = lastShowingSlugs.indexOf(slot.spectacle.slug) !== -1;
        html += renderSlot(slot, { isNextUpcoming: isNextUpcoming, minutesUntil: minutesUntil, isLastShowing: isLastShowing });
      });
    if (lastGroupLabel !== null) html += "</div>";

    container.innerHTML = '<div class="timeline">' + html + "</div>";
    renderHourNav(navEntries);
  }

  function renderFilterChips() {
    var wrap = document.getElementById("category-filter-chips");
    if (!wrap) return;
    wrap.innerHTML = FILTERS.map(function (f) {
      return (
        '<button type="button" class="chip' + (f.key === state.filter ? " active" : "") + '" data-filter="' + f.key + '" ' +
        'aria-pressed="' + (f.key === state.filter) + '">' + f.label + "</button>"
      );
    }).join("");
    wrap.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filter = btn.getAttribute("data-filter");
        renderFilterChips();
        renderProgramme();
      });
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

  function dayShortDateLabel(offset) {
    var d = PDF.parseISODate(dateForOffset(offset));
    return d ? String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") : "";
  }

  function renderDaySelect() {
    var wrap = document.getElementById("day-select");
    if (!wrap) return;
    wrap.innerHTML = DAY_LABELS.map(function (label, i) {
      return (
        '<button type="button" class="segment' + (i === state.dayOffset ? " active" : "") + '" data-offset="' + i + '" ' +
        'aria-pressed="' + (i === state.dayOffset) + '"><span>' + label + '</span><span class="segment-date tnum">' + dayShortDateLabel(i) + "</span></button>"
      );
    }).join("");
    wrap.querySelectorAll(".segment").forEach(function (btn) {
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
    if (searchBar) searchBar.inputEl.value = "";
    document.getElementById("programme-meta").textContent =
      (payload.representation_count != null ? payload.representation_count : "?") + " représentations · " +
      (payload.spectacle_count != null ? payload.spectacle_count : "?") + " spectacles";
    document.getElementById("status-banner-slot").innerHTML =
      PDF.seasonClosedBannerHtml(payload) ||
      PDF.statusBannerHtml(payload.status, payload.date, (payload.representation_count || 0) > 0, offset === 0);
    var hasSlots = (payload.spectacles || []).length > 0;
    var filterChips = document.getElementById("category-filter-chips");
    if (filterChips) filterChips.hidden = !hasSlots;
    renderProgramme();
    scheduleAutoRefresh();
  }

  function loadDay(offset) {
    document.getElementById("programme-content").innerHTML =
      '<div class="empty-state"><div class="skeleton" style="height:2.4rem;max-width:420px;margin:0 auto;"></div></div>';
    document.getElementById("status-banner-slot").innerHTML = "";
    document.getElementById("continuous-gantt-slot").innerHTML = "";
    var promise = offset === 0
      ? PDF.fetchJSON("today.json")
      : PDF.fetchJSON(PDF.historyJsonPath(dateForOffset(offset)));

    return promise
      .then(function (payload) { applyPayload(payload, offset); })
      .catch(function (err) {
        if (err.notFound && offset > 0) {
          document.getElementById("programme-meta").textContent = "";
          document.getElementById("programme-content").innerHTML =
            '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🌙</div>' +
            "<p>Programme pas encore publié pour ce jour.</p></div>";
          var filterChips = document.getElementById("category-filter-chips");
          if (filterChips) filterChips.hidden = true;
          renderHourNav([]);
          return;
        }
        document.getElementById("programme-meta").textContent = "";
        PDF.renderErrorMessage(
          document.getElementById("programme-content"),
          "Impossible de charger le programme (" + err.message + "). Vérifiez votre connexion ou réessayez plus tard."
        );
      });
  }

  function initSearchToggle() {
    var toggle = document.getElementById("search-toggle");
    var wrap = document.getElementById("search-bar-wrap");
    if (!toggle || !wrap) return;
    toggle.innerHTML = PDF.icon("search");
    toggle.addEventListener("click", function () {
      var willOpen = wrap.hidden;
      wrap.hidden = !willOpen;
      toggle.setAttribute("aria-expanded", String(willOpen));
      if (willOpen && searchBar) searchBar.inputEl.focus();
    });
  }

  // Un clic sur une étoile (favori) ou un "+" (ajouter à ma journée) dans la
  // liste : délégation sur le conteneur plutôt qu'un listener par ligne,
  // le contenu étant régénéré à chaque rendu/rafraîchissement.
  function initListClickDelegation() {
    document.getElementById("programme-content").addEventListener("click", function (e) {
      var favBtn = e.target.closest(".star-btn");
      if (favBtn) {
        var slug = favBtn.getAttribute("data-fav-slug");
        try { PDF.toggleFavorite(slug); } catch (err) { /* stockage indisponible : ignoré */ }
        renderProgramme();
        return;
      }
      var addBtn = e.target.closest(".add-to-day-trigger");
      if (addBtn && state.today) {
        var item = {
          slug: addBtn.getAttribute("data-slug") || null,
          name: addBtn.getAttribute("data-name"),
          category: addBtn.getAttribute("data-category") || null,
          start: addBtn.getAttribute("data-start"),
          end: addBtn.getAttribute("data-end") || null,
          is_continuous: false,
        };
        try {
          if (PDF.addToPlan(state.today.date, item)) renderProgramme();
        } catch (err) { /* stockage indisponible : ignoré, rien à afficher ici */ }
      }
    });
  }

  function init() {
    searchBar = PDF.createSearchBar(document.getElementById("search-slot"), {
      placeholder: "Rechercher…",
      onChange: function (value) {
        state.query = value;
        renderProgramme();
      },
    });
    initSearchToggle();
    initListClickDelegation();

    renderDaySelect();
    renderFilterChips();
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

  // Exposé pour les tests (tests/frontend/) — no-op dans un navigateur.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildSlots: buildSlots, durationMinutes: durationMinutes, sortKeyMinutes: sortKeyMinutes, categorizeSlots: categorizeSlots };
  }
})();
