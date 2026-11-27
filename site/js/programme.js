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
    dayOffset: 0, // 0 = aujourd'hui, 1 = demain, 2 = après-demain ; null si une date libre est choisie
    customDate: null, // date ISO choisie via "Choisir une date", ou null si on suit un des 3 onglets
    refreshTimer: null,
    calendar: null, // résolu une fois (voir PDF.fetchCalendarOnce), null si absent
    isProbable: false, // la vue actuelle montre-t-elle une estimation (voir tryProbableProgramme) ?
    probable: null, // dernier résultat de PDF.scheduleStats.probableProgramme (pour re-rendre après un ajout, sans refetch)
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
   * Vue desktop (>= 1100px) : grille horaire + volet "Ma journée"
   * ---------------------------------------------------------------- */
  function timeRangesOverlap(aStart, aEnd, bStart, bEnd) {
    var as = PDF.timeToMinutes(aStart), ae = PDF.timeToMinutes(aEnd);
    var bs = PDF.timeToMinutes(bStart), be = PDF.timeToMinutes(bEnd);
    if (as == null || ae == null || bs == null || be == null) return false;
    return as < be && bs < ae;
  }

  function planItemsForDay(dateStr) {
    var state;
    try { state = PDF.loadCarnetState(); } catch (e) { return []; }
    var plan = state && state.plans && state.plans[dateStr];
    return plan ? plan.items.slice() : [];
  }

  // État visuel d'un créneau dans la grille : un conflit avec le plan du
  // jour prime sur "dans ma journée" (qui prime lui-même sur "passé").
  function gridBlockState(slot, planItems, isToday, nowMinutes) {
    var key = slot.spectacle.slug || slot.spectacle.name;
    var conflict = !slot.rep.is_continuous && slot.rep.start && slot.rep.end && planItems.some(function (it) {
      if ((it.slug || it.name) === key && it.start === slot.rep.start) return false; // lui-même
      return !it.is_continuous && it.start && it.end && timeRangesOverlap(slot.rep.start, slot.rep.end, it.start, it.end);
    });
    if (conflict) return "conflict";
    var inDay = planItems.some(function (it) { return (it.slug || it.name) === key && it.start === slot.rep.start; });
    if (inDay) return "myday";
    if (isToday && !slot.rep.is_continuous && nowMinutes != null) {
      var end = PDF.timeToMinutes(slot.rep.end);
      if (end != null && end <= nowMinutes) return "past";
    }
    return "neutral";
  }

  function renderDesktopGrid(slots, bounds, isToday, nowMinutes, dateStr) {
    var el = document.getElementById("hgrid");
    if (!el) return;
    if (!slots.length || bounds.min == null || bounds.max == null) { el.innerHTML = ""; return; }
    var axisStart = Math.floor(bounds.min / 60) * 60;
    var axisEnd = Math.ceil(bounds.max / 60) * 60;
    var span = axisEnd - axisStart;
    if (span <= 0) { el.innerHTML = ""; return; }

    var planItems = planItemsForDay(dateStr);
    var nowPct = isToday && nowMinutes != null && nowMinutes >= axisStart && nowMinutes <= axisEnd
      ? ((nowMinutes - axisStart) / span) * 100
      : null;

    var groups = [];
    var bySlug = {};
    slots.forEach(function (s) {
      var key = s.spectacle.slug || s.spectacle.name;
      if (!bySlug[key]) { bySlug[key] = { spectacle: s.spectacle, slots: [] }; groups.push(bySlug[key]); }
      bySlug[key].slots.push(s);
    });

    var ticks = [];
    for (var t = axisStart; t <= axisEnd; t += 60) ticks.push(t);
    var axisRow =
      '<div class="hgrid-row hgrid-axis"><div class="hgrid-label"></div><div class="hgrid-track">' +
      ticks.map(function (tk) {
        return '<div class="hgrid-tick" style="left:' + (((tk - axisStart) / span) * 100) + '%">' + String(Math.floor(tk / 60)).padStart(2, "0") + "h</div>";
      }).join("") +
      (nowPct != null
        ? '<div class="hgrid-now-line" style="left:' + nowPct + '%"><span class="hgrid-now-label">' +
          PDF.escapeHtml(String(Math.floor(nowMinutes / 60)).padStart(2, "0") + "h" + String(nowMinutes % 60).padStart(2, "0")) +
          "</span></div>"
        : "") +
      "</div></div>";

    var rows = groups.map(function (group) {
      var catClass = group.spectacle.category === "spectacle_nocturne" ? "is-night"
        : group.spectacle.category === "spectacle_immersif" ? "is-immersive" : "is-muted";
      var blocks = group.slots.map(function (s) {
        var a = PDF.timeToMinutes(s.rep.start);
        if (a == null) return "";
        var b = PDF.timeToMinutes(s.rep.end);
        var bb = b == null ? a + 20 : b;
        var left = ((Math.max(a, axisStart) - axisStart) / span) * 100;
        var width = Math.max(1.2, ((Math.min(bb, axisEnd) - Math.max(a, axisStart)) / span) * 100);
        var state = gridBlockState(s, planItems, isToday, nowMinutes);
        var label = s.spectacle.name + ", " + PDF.formatTimeFR(s.rep.start) + (s.rep.end ? "–" + PDF.formatTimeFR(s.rep.end) : "");
        return (
          '<button type="button" class="hgrid-block hgrid-block--' + state + '" style="left:' + left + "%;width:" + width + '%" ' +
          'title="' + PDF.escapeHtml(label) + '" aria-label="' + PDF.escapeHtml(label) + '" ' +
          'data-slug="' + PDF.escapeHtml(s.spectacle.slug || "") + '" data-name="' + PDF.escapeHtml(s.spectacle.name) + '" ' +
          'data-category="' + PDF.escapeHtml(s.spectacle.category || "") + '" data-start="' + s.rep.start + '" data-end="' + (s.rep.end || "") + '"></button>'
        );
      }).join("");
      return (
        '<div class="hgrid-row"><div class="hgrid-label"><span class="hgrid-show-name">' + PDF.escapeHtml(group.spectacle.name) + "</span>" +
        '<span class="hgrid-show-cat ' + catClass + '">' + PDF.escapeHtml(PDF.categoryLabel(group.spectacle.category)) + "</span></div>" +
        '<div class="hgrid-track">' + blocks +
        (nowPct != null ? '<div class="hgrid-now-line" style="left:' + nowPct + '%"></div>' : "") +
        "</div></div>"
      );
    }).join("");

    el.innerHTML = rows + axisRow;
    el.querySelectorAll(".hgrid-block").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var slug = btn.getAttribute("data-slug") || null;
        var name = btn.getAttribute("data-name");
        var start = btn.getAttribute("data-start");
        var already = false;
        try { already = PDF.isInPlan(dateStr, slug || name, start); } catch (e) { /* ignore */ }
        try {
          if (already) PDF.removeFromPlan(dateStr, slug || name, start);
          else PDF.addToPlan(dateStr, { slug: slug, name: name, category: btn.getAttribute("data-category") || null, start: start, end: btn.getAttribute("data-end") || null, is_continuous: false });
        } catch (e) { /* stockage indisponible : ignoré */ }
        renderProgramme();
      });
    });
  }

  function asideToast(msg) {
    document.querySelectorAll(".toast-msg").forEach(function (t) { t.remove(); });
    var t = document.createElement("div");
    t.className = "toast-msg";
    t.setAttribute("role", "status");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  function renderAside(dateStr, isToday, nowMinutes) {
    var nextSlot = document.getElementById("aside-next-slot");
    var dayListSlot = document.getElementById("aside-myday-slot");
    if (!nextSlot || !dayListSlot) return;

    var items = planItemsForDay(dateStr).sort(function (a, b) {
      if (a.is_continuous && b.is_continuous) return 0;
      if (a.is_continuous) return -1;
      if (b.is_continuous) return 1;
      return (a.start || "").localeCompare(b.start || "");
    });

    var upcoming = items.filter(function (it) {
      if (it.is_continuous || !it.start) return false;
      return !isToday || nowMinutes == null || PDF.timeToMinutes(it.start) >= nowMinutes;
    }).sort(function (a, b) { return PDF.timeToMinutes(a.start) - PDF.timeToMinutes(b.start); });
    var next = upcoming[0];

    nextSlot.innerHTML = next
      ? '<div class="card hero-card"><div class="hero-label">Prochain dans ma journée</div><h2>' + PDF.escapeHtml(next.name) + "</h2>" +
        '<div class="hero-meta"><span class="hero-time">' + PDF.formatTimeFR(next.start) + "</span></div></div>"
      : '<div class="card"><p class="text-muted" style="margin:0">Rien de prévu dans votre journée pour l\'instant.</p></div>';

    if (!items.length) {
      dayListSlot.innerHTML = '<div class="card"><h3 class="mt-0">Ma journée</h3><p class="text-muted" style="margin:0">Aucun spectacle ajouté — cliquez un créneau dans la grille pour l\'ajouter.</p></div>';
      return;
    }

    var fixes = items.filter(function (it) { return !it.is_continuous && it.start && it.end; });
    var conflictPairs = [];
    for (var i = 0; i < fixes.length; i++) {
      for (var j = i + 1; j < fixes.length; j++) {
        if (timeRangesOverlap(fixes[i].start, fixes[i].end, fixes[j].start, fixes[j].end)) conflictPairs.push([fixes[i], fixes[j]]);
      }
    }
    function isConflicting(it) { return conflictPairs.some(function (p) { return p[0] === it || p[1] === it; }); }

    dayListSlot.innerHTML =
      '<div class="card"><h3 class="mt-0">Ma journée</h3><div class="list-card">' +
      items.map(function (it) {
        var conflict = isConflicting(it);
        return (
          '<div class="list-row' + (conflict ? " is-conflict-row" : "") + '">' +
          '<span class="list-row-time">' + (it.is_continuous ? "Continu" : PDF.formatTimeFR(it.start)) + "</span>" +
          '<span class="list-row-main"><span class="list-row-name">' + PDF.escapeHtml(it.name) + "</span>" +
          (conflict ? '<span class="list-row-meta is-warn">Conflit</span>' : "") +
          "</span></div>"
        );
      }).join("") +
      "</div>" +
      (conflictPairs.length ? '<button type="button" class="btn btn-outline" id="btn-resolve-conflict" style="margin-top:0.75rem;width:100%">Résoudre le conflit</button>' : "") +
      '<button type="button" class="btn btn-outline" id="btn-share-aside" style="margin-top:0.6rem;width:100%">Partager</button>' +
      "</div>";

    var resolveBtn = document.getElementById("btn-resolve-conflict");
    if (resolveBtn) {
      resolveBtn.addEventListener("click", function () {
        var pair = conflictPairs[0];
        if (!pair) return;
        try { PDF.removeFromPlan(dateStr, pair[1].slug || pair[1].name, pair[1].start); } catch (e) { /* ignore */ }
        renderProgramme();
      });
    }
    var shareBtn = document.getElementById("btn-share-aside");
    if (shareBtn) {
      shareBtn.addEventListener("click", function () {
        var lignes = items.map(function (it) { return (it.is_continuous ? "En continu" : PDF.formatTimeFR(it.start)) + " — " + it.name; });
        var texte = "Ma journée au Puy du Fou :\n" + lignes.join("\n");
        if (navigator.share) {
          navigator.share({ title: "Ma journée au Puy du Fou", text: texte }).catch(function () { /* annulé : rien à faire */ });
        } else if (navigator.clipboard) {
          navigator.clipboard.writeText(texte).then(function () { asideToast("Copié dans le presse-papiers."); }, function () { asideToast("Impossible de copier."); });
        }
      });
    }
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
    renderDesktopGrid(slots, dayBounds(allSlots), isToday, nowMinutes, state.today.date);
    renderAside(state.today.date, isToday, nowMinutes);

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
        if (offset === state.dayOffset && !state.customDate) return;
        state.dayOffset = offset;
        exitCustomDateMode();
        renderDaySelect();
        loadDay(offset);
      });
    });
  }

  // Quitte le mode "date libre" (ré-affiche/réactive les 3 onglets Aujourd'hui/
  // Demain/Après-demain) — appelé en cliquant un de ces onglets directement.
  function exitCustomDateMode() {
    state.customDate = null;
    var input = document.getElementById("custom-date-input");
    if (input) { input.value = ""; input.hidden = true; }
  }

  function updateCustomDateBounds(payload) {
    var input = document.getElementById("custom-date-input");
    if (!input || !payload || !payload.season) return;
    if (payload.season.start_date) input.min = payload.season.start_date;
    if (payload.season.end_date) input.max = payload.season.end_date;
  }

  function applyPayload(payload, offset) {
    state.today = payload;
    state.query = "";
    state.isProbable = false;
    state.probable = null;
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
    updateCustomDateBounds(payload);
    renderProgramme();
    scheduleAutoRefresh();
    renderUnusualBanner(payload, offset);
  }

  // Voir §4.4 de la spec "schedule-distribution" : seulement pour le
  // programme officiel d'AUJOURD'HUI (jamais sur une estimation ni sur un
  // autre jour), et seulement si l'utilisateur ne l'a pas déjà masqué pour
  // cette date (voir PDF.dismissUnusualToday).
  function renderUnusualBanner(payload, offset) {
    var slot = document.getElementById("unusual-banner-slot");
    if (!slot) return;
    slot.innerHTML = "";
    if (offset !== 0 || !PDF.isDataForToday(payload.date) || PDF.isUnusualDismissedToday(payload.date)) return;
    Promise.all([PDF.fetchScheduleIndexOnce(), PDF.fetchCalendarOnce()])
      .then(function (results) {
        var items = PDF.unusualTodayItems(payload, results[0], results[1]).slice(0, 3);
        if (!items.length) return;
        slot.innerHTML = PDF.unusualBannerHtml(items, payload.date);
        var btn = slot.querySelector("[data-dismiss-unusual]");
        if (btn) {
          btn.addEventListener("click", function () {
            PDF.dismissUnusualToday(payload.date);
            slot.innerHTML = "";
          });
        }
      })
      .catch(function () { /* analytique secondaire : jamais bloquant pour le programme officiel */ });
  }

  function loadDay(offset) {
    document.getElementById("programme-content").innerHTML =
      '<div class="empty-state"><div class="skeleton" style="height:2.4rem;max-width:420px;margin:0 auto;"></div></div>';
    document.getElementById("status-banner-slot").innerHTML = "";
    document.getElementById("unusual-banner-slot").innerHTML = "";
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

  /* ------------------------------------------------------------------
   * Date libre : programme officiel s'il existe déjà, sinon "programme
   * probable" (voir PDF.scheduleStats.probableProgramme) — jamais pour
   * une date exclue (fermeture/privatisation) ou hors de la saison.
   * ---------------------------------------------------------------- */
  function loadCustomDate(dateStr) {
    document.getElementById("programme-content").innerHTML =
      '<div class="empty-state"><div class="skeleton" style="height:2.4rem;max-width:420px;margin:0 auto;"></div></div>';
    document.getElementById("status-banner-slot").innerHTML = "";
    document.getElementById("unusual-banner-slot").innerHTML = "";
    document.getElementById("continuous-gantt-slot").innerHTML = "";
    // La vue desktop (grille horaire + volet "Ma journée") ne sait pas
    // encore représenter un programme probable (seule la liste l'affiche,
    // voir renderProbableProgramme) : on la vide plutôt que de laisser un
    // autre jour affiché, trompeur, à côté.
    document.getElementById("hgrid").innerHTML = "";
    document.getElementById("aside-next-slot").innerHTML = "";
    document.getElementById("aside-myday-slot").innerHTML = "";
    var seasonYear = state.today && state.today.season ? state.today.season.year : null;
    PDF.fetchJSON(PDF.historyJsonPath(dateStr, seasonYear))
      .then(function (payload) { applyPayload(payload, null); })
      .catch(function (err) {
        if (err.notFound) { tryProbableProgramme(dateStr); return; }
        document.getElementById("programme-meta").textContent = "";
        PDF.renderErrorMessage(
          document.getElementById("programme-content"),
          "Impossible de charger le programme (" + err.message + ")."
        );
      });
  }

  function tryProbableProgramme(dateStr) {
    Promise.all([PDF.fetchScheduleIndexOnce(), PDF.fetchCalendarOnce()])
      .then(function (results) {
        var index = results[0];
        state.calendar = results[1];
        if (!index) { renderProbableUnavailable(); return; }
        var probable = PDF.scheduleStats.probableProgramme(index, state.calendar, dateStr);
        if (!probable) { renderClosedForDate(dateStr); return; }
        renderProbableProgramme(dateStr, probable);
      })
      .catch(function () { renderProbableUnavailable(); });
  }

  function renderProbableUnavailable() {
    document.getElementById("programme-meta").textContent = "";
    document.getElementById("programme-content").innerHTML =
      '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🌙</div>' +
      "<p>Programme pas encore publié pour ce jour, et aucune estimation n'est disponible.</p></div>";
    var filterChips = document.getElementById("category-filter-chips");
    if (filterChips) filterChips.hidden = true;
    renderHourNav([]);
  }

  // Date exclue (fermeture, privatisation…) ou hors des bornes connues de
  // l'index : même traitement visuel qu'un jour officiellement fermé,
  // sans prétendre savoir LAQUELLE de ces deux raisons s'applique ici
  // (probableProgramme ne fait pas la différence, voir schedule-stats.js).
  function renderClosedForDate(dateStr) {
    document.getElementById("programme-meta").textContent = "";
    document.getElementById("status-banner-slot").innerHTML = PDF.statusBannerHtml("closed_day", dateStr, false, false);
    document.getElementById("programme-content").innerHTML = "";
    var filterChips = document.getElementById("category-filter-chips");
    if (filterChips) filterChips.hidden = true;
    renderHourNav([]);
  }

  function probableRowTimeLabel(item) {
    if (item.starts.length) return item.starts.map(function (t) { return PDF.formatTimeFR(t); }).join(", ");
    return item.ranges.map(function (r) { return r.replace("-", "–"); }).join(", ");
  }

  // Une seule heure de référence pour le bouton "+" même si le motif prédit
  // comporte plusieurs horaires ce jour-là (cas rare) : on propose d'ajouter
  // le premier, cohérent avec le badge de confiance qui porte sur LE motif
  // dans son ensemble, pas séance par séance.
  function renderProbableRow(dateStr, item) {
    var pct = Math.round(item.confidence * 100);
    var low = item.confidence < 0.5;
    var start = item.starts[0] || null;
    var already = false;
    if (start) { try { already = PDF.isInPlan(dateStr, item.slug, start); } catch (e) { /* ignore */ } }
    return (
      '<div class="rep-card">' +
      '<div class="rep-time-wrap"><div class="rep-time tnum">' + PDF.escapeHtml(probableRowTimeLabel(item)) + "</div>" +
      '<div class="rep-duration' + (low ? " is-warn" : "") + '">' + (low ? PDF.icon("alert-triangle") + " " : "") +
      "probable " + pct + "%</div></div>" +
      '<div class="rep-name">' + PDF.escapeHtml(item.name) + "</div>" +
      '<div class="rep-badges">' + PDF.categoryBadgeHtml(item.category) + "</div>" +
      (start
        ? '<button type="button" class="add-to-day-btn add-to-day-trigger' + (already ? " is-added" : "") + '" ' +
          'data-slug="' + PDF.escapeHtml(item.slug) + '" data-name="' + PDF.escapeHtml(item.name) + '" ' +
          'data-category="' + PDF.escapeHtml(item.category || "") + '" data-start="' + start + '" data-end="" data-estimated="true" ' +
          'aria-label="' + (already ? "Déjà dans ma journée" : "Ajouter à ma journée (estimation)") + '" aria-pressed="' + already + '">' +
          (already ? "✓" : "+") + "</button>"
        : "") +
      "</div>"
    );
  }

  function renderProbableProgramme(dateStr, probable) {
    state.isProbable = true;
    state.probable = probable;
    // Repère minimal pour que le reste (bouton "+", favoris) continue de
    // fonctionner sur CETTE date, même sans vrai payload officiel.
    state.today = { date: dateStr, spectacles: [] };

    var n = probable.basis.referenceDays;
    document.getElementById("programme-meta").textContent = probable.spectacles.length + " spectacle(s) estimé(s)";
    document.getElementById("status-banner-slot").innerHTML =
      '<div class="status-banner status-probable">' + PDF.icon("alert-triangle") +
      "<span>Programme probable — estimation basée sur " + n + " journée" + (n > 1 ? "s" : "") +
      " comparable" + (n > 1 ? "s" : "") + " (" + PDF.escapeHtml(probable.basis.rule) + "). " +
      "Le programme officiel est publié environ 2 jours avant.</span></div>";

    var filterChips = document.getElementById("category-filter-chips");
    if (filterChips) filterChips.hidden = true; // recherche/filtres/favoris ne s'appliquent pas à cette vue simplifiée
    document.getElementById("continuous-gantt-slot").innerHTML = "";
    renderHourNav([]);

    if (!probable.spectacles.length) {
      document.getElementById("programme-content").innerHTML = '<div class="empty-state"><p>Aucune estimation fiable pour cette date.</p></div>';
      return;
    }
    document.getElementById("programme-content").innerHTML =
      '<div class="timeline">' + probable.spectacles.map(function (item) { return renderProbableRow(dateStr, item); }).join("") + "</div>";
  }

  function initCustomDatePicker() {
    var toggle = document.getElementById("custom-date-toggle");
    var input = document.getElementById("custom-date-input");
    if (!toggle || !input) return;
    toggle.addEventListener("click", function () {
      input.hidden = !input.hidden;
      if (!input.hidden) input.focus();
    });
    input.addEventListener("change", function () {
      if (!input.value) return;
      state.customDate = input.value;
      state.dayOffset = null;
      renderDaySelect();
      loadCustomDate(input.value);
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
        // Une séance ajoutée depuis le "programme probable" (pas encore
        // officiel) porte ce drapeau — voir PDF.addToPlan et la
        // réconciliation à l'ouverture du carnet une fois le programme
        // officiel publié (phase suivante de la fonctionnalité).
        if (addBtn.getAttribute("data-estimated") === "true") item.estimated = true;
        try {
          if (PDF.addToPlan(state.today.date, item)) {
            if (state.isProbable && state.probable) renderProbableProgramme(state.today.date, state.probable);
            else renderProgramme();
          }
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
    initCustomDatePicker();
    initListClickDelegation();

    renderDaySelect();
    renderFilterChips();

    // "programme.html?date=2026-07-22" présélectionne cette date au lieu
    // d'aujourd'hui (ex: lien "Choisir dans le programme" depuis une
    // journée vide de Ma journée, voir site/js/journee.js) — ignoré si
    // absent/invalide.
    var requestedDate = new URLSearchParams(location.search).get("date");
    if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      state.customDate = requestedDate;
      state.dayOffset = null;
      var dateInput = document.getElementById("custom-date-input");
      if (dateInput) { dateInput.value = requestedDate; dateInput.hidden = false; }
      renderDaySelect();
      loadCustomDate(requestedDate);
    } else {
      loadDay(0);
    }

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
