/* =========================================================================
   programme.js — logique de la page "Programme du jour"
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;
  var dayPlan = PDF.dayPlan;

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
      PDF.icon(already ? "check" : "plus") +
      "</button>"
    );
  }

  // Un seul horaire affiché par groupe de lignes consécutives qui partagent
  // le même horaire (plutôt qu'un en-tête "14h00" par heure) : `starts` est
  // déjà trié par heure croissante. Pure et testée indépendamment du DOM
  // (voir tests/frontend/programme.test.js).
  function groupConsecutiveByStart(starts) {
    return starts.map(function (s, i) { return i === 0 || s !== starts[i - 1]; });
  }

  // Un spectacle "en continu" avec plusieurs plages (ex: deux créneaux
  // d'ouverture) ne doit apparaître qu'UNE fois dans le mini-Gantt "Accès
  // continu", avec toutes ses plages sur la même piste — pas une ligne par
  // plage (voir maquette "Programme", section Mobile, point 2).
  function mergeContinuousByShow(continuousSlots) {
    var groups = [];
    var bySlug = {};
    continuousSlots.forEach(function (s) {
      var key = s.spectacle.slug || s.spectacle.name;
      if (!bySlug[key]) { bySlug[key] = { spectacle: s.spectacle, ranges: [] }; groups.push(bySlug[key]); }
      if (s.rep.start && s.rep.end) bySlug[key].ranges.push({ start: s.rep.start, end: s.rep.end });
    });
    return groups;
  }

  // Une ligne par séance (pas une carte, voir maquette "Programme") : l'heure
  // n'est répétée que sur la première ligne d'un groupe de même horaire
  // (opts.showTime, voir groupConsecutiveByStart) ; une seule ligne de méta
  // (délai/durée/dernière séance, puis badges de statut éventuels).
  function renderProgRow(slot, opts) {
    opts = opts || {};
    var rep = slot.rep;
    var spectacle = slot.spectacle;
    var isNight = spectacle.category === "spectacle_nocturne" || PDF.isLateHour(rep.start);
    var duration = durationMinutes(rep.start, rep.end);

    var metaParts = [];
    var metaCls = "";
    if (opts.isLastShowing) {
      metaParts.push("Dernière séance" + (duration != null ? " · " + duration + " min" : ""));
      metaCls = "is-last";
    } else if (opts.isNextUpcoming) {
      metaParts.push((opts.minutesUntil <= 0 ? "maintenant" : "dans " + opts.minutesUntil + " min") + (duration != null ? " · " + duration + " min" : ""));
      metaCls = "is-next";
    } else if (duration != null) {
      metaParts.push(duration + " min");
    }
    var badgesHtml = PDF.representationBadges(rep, spectacle.category);
    var metaRowHtml = metaParts.length || badgesHtml
      ? '<div class="prog-row-meta-row">' +
        (metaParts.length ? '<span class="prog-row-meta' + (metaCls ? " " + metaCls : "") + '">' + PDF.escapeHtml(metaParts.join("")) + "</span>" : "") +
        badgesHtml +
        "</div>"
      : "";

    var classes = "prog-row";
    if (isNight) classes += " is-night";
    if (opts.isPast) classes += " is-past";
    if (opts.isNewTime) classes += " is-new-time";

    return (
      '<div class="' + classes + '">' +
      '<span class="prog-row-time tnum">' + (opts.showTime ? PDF.escapeHtml(PDF.formatTimeFR(rep.start)) : "") + "</span>" +
      '<span class="prog-row-main"><span class="prog-row-name">' + PDF.escapeHtml(spectacle.name) + "</span>" + metaRowHtml + "</span>" +
      '<span class="prog-row-actions">' + starButtonHtml(spectacle.slug) + (opts.isPast ? "" : addButtonHtml(slot)) + "</span>" +
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
    var groups = mergeContinuousByShow(continuousSlots);
    var rows = groups.map(function (group) {
      var bars = group.ranges.map(function (r) {
        var a = PDF.timeToMinutes(r.start), b = PDF.timeToMinutes(r.end);
        if (a == null || b == null) return "";
        var left = ((a - bounds.min) / span) * 100;
        var width = Math.max(1, ((b - a) / span) * 100);
        var isPast = isToday && nowMinutes != null && b <= nowMinutes;
        return '<div class="mini-gantt-bar' + (isPast ? " is-past" : "") + '" style="left:' + left + "%;width:" + width + '%"></div>';
      }).join("");
      return (
        '<div class="mini-gantt-row">' +
        '<div class="mini-gantt-label">' + PDF.escapeHtml(group.spectacle.name) + "</div>" +
        '<div class="mini-gantt-track">' + bars +
        (nowPct != null ? '<div class="mini-gantt-now" style="left:' + nowPct + '%"></div>' : "") +
        "</div></div>"
      );
    }).join("");
    var boundsLabel = String(Math.floor(bounds.min / 60)).padStart(2, "0") + "h — " + String(Math.floor(bounds.max / 60)).padStart(2, "0") + "h";
    slot.innerHTML =
      '<div class="card"><div class="mini-gantt-card-head"><div class="section-label">Accès continu</div>' +
      '<span class="mini-gantt-bounds tnum">' + boundsLabel + "</span></div>" +
      '<div class="mini-gantt">' + rows + "</div></div>";
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

  // Texte/teinte de la ligne de catégorie sous le nom du spectacle, et
  // classe de teinte par défaut du bloc (avant tout état "ma journée"/
  // "conflit"/"passé", voir hgridBlockClasses) — propres à cette grille,
  // pas PDF.categoryLabel() (libellés génériques réutilisés ailleurs).
  function hgridCategoryInfo(category) {
    if (category === "spectacle_nocturne") return { label: "Nocturne", cls: "is-night", block: "hgrid-block--night" };
    if (category === "spectacle_immersif") return { label: "Immersif · accès continu", cls: "is-immersive", block: "hgrid-block--immersive" };
    return { label: "Spectacle", cls: "is-muted", block: "hgrid-block--neutral" };
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
    var nowLabelText = nowPct != null
      ? String(Math.floor(nowMinutes / 60)).padStart(2, "0") + "h" + String(nowMinutes % 60).padStart(2, "0")
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
    var legend =
      '<div class="hgrid-legend">' +
      '<span class="hgrid-legend-item"><span class="hgrid-legend-swatch hgrid-legend-swatch--myday"></span>Ma journée</span>' +
      '<span class="hgrid-legend-item"><span class="hgrid-legend-swatch hgrid-legend-swatch--conflict"></span>Conflit</span>' +
      "</div>";
    // L'axe horaire EN HAUT de la grille (pas en bas, voir maquette
    // "Programme") : premier/dernier libellé clampés pour rester entièrement
    // visibles (hgrid-tick--first/--last), pas juste centrés sur leur tick.
    var axisRow =
      '<div class="hgrid-row hgrid-axis"><div class="hgrid-label">' + legend + '</div><div class="hgrid-track">' +
      ticks.map(function (tk, i) {
        var edgeCls = i === 0 ? " hgrid-tick--first" : i === ticks.length - 1 ? " hgrid-tick--last" : "";
        return '<div class="hgrid-tick' + edgeCls + '" style="left:' + (((tk - axisStart) / span) * 100) + '%">' + String(Math.floor(tk / 60)).padStart(2, "0") + "h</div>";
      }).join("") +
      (nowPct != null ? '<div class="hgrid-now-line" style="left:' + nowPct + '%"></div>' : "") +
      "</div></div>";

    var rows = groups.map(function (group, gi) {
      var info = hgridCategoryInfo(group.spectacle.category);
      var isLastRow = gi === groups.length - 1;
      var blocks = group.slots.map(function (s) {
        var a = PDF.timeToMinutes(s.rep.start);
        if (a == null) return "";
        var b = PDF.timeToMinutes(s.rep.end);
        var bb = b == null ? a + 20 : b;
        var left = ((Math.max(a, axisStart) - axisStart) / span) * 100;
        var width = Math.max(1.2, ((Math.min(bb, axisEnd) - Math.max(a, axisStart)) / span) * 100);
        var overlay = gridBlockState(s, planItems, isToday, nowMinutes);
        var cls = "hgrid-block " + (overlay === "neutral" ? info.block : "hgrid-block--" + overlay);
        var label = s.spectacle.name + ", " + PDF.formatTimeFR(s.rep.start) + (s.rep.end ? "–" + PDF.formatTimeFR(s.rep.end) : "");
        return (
          '<button type="button" class="' + cls + '" style="left:' + left + "%;width:" + width + '%" ' +
          'title="' + PDF.escapeHtml(label) + '" aria-label="' + PDF.escapeHtml(label) + '" ' +
          'data-slug="' + PDF.escapeHtml(s.spectacle.slug || "") + '" data-name="' + PDF.escapeHtml(s.spectacle.name) + '" ' +
          'data-category="' + PDF.escapeHtml(s.spectacle.category || "") + '" data-start="' + s.rep.start + '" data-end="' + (s.rep.end || "") + '"></button>'
        );
      }).join("");
      // Étiquette "14h20" de la ligne "maintenant" sous la DERNIÈRE ligne
      // seulement (jamais sur l'axe, voir maquette) : la ligne verticale,
      // elle, traverse bien chaque ligne.
      var nowLineHtml = nowPct != null
        ? '<div class="hgrid-now-line' + (isLastRow ? " hgrid-now-line--labeled" : "") + '" style="left:' + nowPct + '%">' +
          (isLastRow ? '<span class="hgrid-now-label">' + PDF.escapeHtml(nowLabelText) + "</span>" : "") +
          "</div>"
        : "";
      return (
        '<div class="hgrid-row"><div class="hgrid-label"><span class="hgrid-show-name">' + PDF.escapeHtml(group.spectacle.name) + "</span>" +
        '<span class="hgrid-show-cat ' + info.cls + '">' + PDF.escapeHtml(info.label) + "</span></div>" +
        '<div class="hgrid-track">' + blocks + nowLineHtml + "</div></div>"
      );
    }).join("");

    el.innerHTML = axisRow + rows;
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

  // Marge "portes" du planificateur (Ma journée/Carnet, voir S.gate) : même
  // réglage partagé, pas une valeur propre à cette page. 30 min par défaut,
  // comme PDF.carnetEtatInitial().
  function planGate() {
    try {
      var s = PDF.loadCarnetState();
      return s && s.gate != null ? s.gate : 30;
    } catch (e) { return 30; }
  }

  // Autres horaires officiels connus du même spectacle aujourd'hui (hors
  // celui-ci) — pour la note "Chevauche ... — autres séances" et une
  // résolution de conflit qui DÉPLACE plutôt que supprime (voir resolveConflict).
  function officialStartsForSlug(allSlots, slug, excludeStart) {
    if (!slug) return [];
    var seen = {};
    var out = [];
    allSlots.forEach(function (s) {
      if (s.rep.is_continuous || !s.rep.start) return;
      if ((s.spectacle.slug || s.spectacle.name) !== slug) return;
      if (s.rep.start === excludeStart || seen[s.rep.start]) return;
      seen[s.rep.start] = true;
      out.push({ start: s.rep.start, end: s.rep.end });
    });
    return out.sort(function (a, b) { return a.start.localeCompare(b.start); });
  }

  // Note affichée sous chaque séance à heure fixe de "Ma journée" — un seul
  // message par séance, dans l'ordre de priorité du plus important au moins
  // important : chevauchement réel > nocturne > portes (1ère séance) >
  // marge avec la précédente. Reprend PDF.dayPlan (conflits/marge), partagé
  // avec Ma journée (site/js/journee.js) plutôt qu'une logique propre à
  // cette page.
  function fixedItemNotes(fixes, conflits, gate, allSlots) {
    return fixes.map(function (it, i) {
      var autreConflit = dayPlan.conflitChevauchementAvec(it, conflits);
      if (autreConflit) {
        var alternatives = officialStartsForSlug(allSlots, it.slug || it.name, it.start).slice(0, 2);
        var altText = alternatives.length
          ? " — autres séances " + alternatives.map(function (a) { return PDF.formatTimeFR(a.start); }).join(", ")
          : "";
        return { kind: "conflict", text: "Chevauche " + autreConflit.name + altText };
      }
      if (it.category === "spectacle_nocturne") return { kind: "night", text: "Spectacle nocturne" };
      if (i === 0) return { kind: "ok", text: "Portes " + gate + " min avant" };
      var marge = dayPlan.margeMinutes(fixes[i - 1], it);
      var tendu = marge < gate;
      return { kind: tendu ? "warn" : "ok", text: marge + " min " + (tendu ? "pour rejoindre — serré" : "de marge") };
    });
  }

  // Prochaine séance à heure fixe toutes représentations confondues (pas
  // seulement celles déjà dans "Ma journée") — pour le repli "Prochain
  // spectacle" de la carte héros quand le plan du jour est vide.
  function nextOverallSlot(allSlots, isToday, nowMinutes) {
    var timed = allSlots.filter(function (s) { return !s.rep.is_continuous && s.rep.start; });
    var upcoming = isToday && nowMinutes != null
      ? timed.filter(function (s) { return PDF.timeToMinutes(s.rep.start) >= nowMinutes; })
      : timed;
    if (!upcoming.length) return null;
    return upcoming.slice().sort(function (a, b) { return PDF.timeToMinutes(a.rep.start) - PDF.timeToMinutes(b.rep.start); })[0];
  }

  function renderAside(dateStr, isToday, nowMinutes, allSlots) {
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

    if (next) {
      var untilMin = isToday && nowMinutes != null ? PDF.timeToMinutes(next.start) - nowMinutes : null;
      var dur = durationMinutes(next.start, next.end);
      var metaBits = [];
      if (untilMin != null) metaBits.push(untilMin <= 0 ? "maintenant" : "dans " + untilMin + " min");
      if (dur != null) metaBits.push(dur + " min");
      nextSlot.innerHTML =
        '<div class="card hero-card"><div class="hero-label">Prochain dans ma journée</div><h2>' + PDF.escapeHtml(next.name) + "</h2>" +
        '<div class="hero-meta"><span class="hero-time">' + PDF.formatTimeFR(next.start) + "</span>" +
        (metaBits.length ? '<span class="hero-duration">' + PDF.escapeHtml(metaBits.join(" · ")) + "</span>" : "") +
        "</div></div>";
    } else {
      var overall = nextOverallSlot(allSlots, isToday, nowMinutes);
      if (overall) {
        nextSlot.innerHTML =
          '<div class="card hero-card"><div class="hero-label">Prochain spectacle</div><h2>' + PDF.escapeHtml(overall.spectacle.name) + "</h2>" +
          '<div class="hero-meta"><span class="hero-time">' + PDF.formatTimeFR(overall.rep.start) + '</span></div>' +
          '<div class="hero-actions"><button type="button" class="btn btn-on-primary" id="btn-add-hero" ' +
          'data-slug="' + PDF.escapeHtml(overall.spectacle.slug || "") + '" data-name="' + PDF.escapeHtml(overall.spectacle.name) + '" ' +
          'data-category="' + PDF.escapeHtml(overall.spectacle.category || "") + '" data-start="' + overall.rep.start + '" ' +
          'data-end="' + (overall.rep.end || "") + '">Ajouter à ma journée</button></div></div>';
        var addHeroBtn = document.getElementById("btn-add-hero");
        if (addHeroBtn) {
          addHeroBtn.addEventListener("click", function () {
            try {
              PDF.addToPlan(dateStr, {
                slug: addHeroBtn.getAttribute("data-slug") || null,
                name: addHeroBtn.getAttribute("data-name"),
                category: addHeroBtn.getAttribute("data-category") || null,
                start: addHeroBtn.getAttribute("data-start"),
                end: addHeroBtn.getAttribute("data-end") || null,
                is_continuous: false,
              });
            } catch (e) { /* stockage indisponible : ignoré */ }
            renderProgramme();
          });
        }
      } else {
        nextSlot.innerHTML = '<div class="card"><p class="text-muted" style="margin:0">Rien de prévu dans votre journée pour l\'instant.</p></div>';
      }
    }

    if (!items.length) {
      dayListSlot.innerHTML =
        '<div class="card"><h3 class="mt-0">Ma journée</h3><p class="text-muted" style="margin:0 0 0.75rem">Aucun spectacle pour l\'instant.</p>' +
        '<a class="link-button" href="journee.html?date=' + encodeURIComponent(dateStr) + '&assistant=1">' + PDF.icon("wand") + "Composer automatiquement</a>" +
        '<p class="text-muted" style="margin:0.6rem 0 0;font-size:0.82rem">Cliquez un créneau dans la grille pour l\'ajouter.</p></div>';
      return;
    }

    var gate = planGate();
    var fixes = dayPlan.itemsFixesTries(items);
    var conflits = dayPlan.detecterConflits(fixes, gate);
    var notes = fixedItemNotes(fixes, conflits, gate, allSlots);
    var noteByUid = {};
    fixes.forEach(function (it, i) { noteByUid[it.uid] = notes[i]; });
    var hasOverlap = conflits.some(function (c) { return c.chevauchement; });

    dayListSlot.innerHTML =
      '<div class="card"><div class="flex-between"><h3 class="mt-0">Ma journée</h3>' +
      '<span class="text-muted" style="font-size:0.8rem">' + items.length + " spectacle" + (items.length > 1 ? "s" : "") +
      (fixes.length ? " · " + dayPlan.formatDureeHeuresMinutes(dayPlan.dureeTotaleMinutes(fixes)) : "") + "</span></div>" +
      '<ol class="list-card">' +
      items.map(function (it) {
        var note = it.is_continuous ? null : noteByUid[it.uid];
        var rowCls = note && note.kind === "conflict" ? " is-conflict-row" : "";
        return (
          '<li class="list-row' + rowCls + '">' +
          '<span class="list-row-time">' + (it.is_continuous ? "Continu" : PDF.formatTimeFR(it.start)) + "</span>" +
          '<span class="list-row-main"><span class="list-row-name">' + PDF.escapeHtml(it.name) + "</span>" +
          (note ? '<span class="list-row-meta is-' + note.kind + '">' + PDF.escapeHtml(note.text) + "</span>" : "") +
          "</span></li>"
        );
      }).join("") +
      "</ol>" +
      (hasOverlap ? '<button type="button" class="btn" id="btn-resolve-conflict" style="margin-top:0.75rem;width:100%">Résoudre le conflit</button>' : "") +
      '<a class="btn btn-outline" id="btn-open-journee" href="journee.html?date=' + encodeURIComponent(dateStr) + '" style="margin-top:0.6rem;width:100%;justify-content:center">Ouvrir Ma journée</a>' +
      "</div>";

    var resolveBtn = document.getElementById("btn-resolve-conflict");
    if (resolveBtn) {
      resolveBtn.addEventListener("click", function () { resolveConflict(dateStr, fixes, conflits, allSlots); });
    }
  }

  // "Résoudre le conflit" : DÉPLACE une des deux séances en chevauchement
  // vers une autre séance officielle du même spectacle qui ne crée plus
  // aucun conflit avec le reste du plan (jamais une suppression silencieuse
  // — voir le point soulevé sur la version précédente de ce bouton).
  // Annulable, comme toute action destructive de ce site.
  function resolveConflict(dateStr, fixes, conflits, allSlots) {
    var pair = conflits.filter(function (c) { return c.chevauchement; })[0];
    if (!pair) return;
    var gate = planGate();

    function essaieDeplacer(cible, autres) {
      var alternatives = officialStartsForSlug(allSlots, cible.slug || cible.name, cible.start);
      return alternatives.filter(function (alt) {
        return autres.every(function (other) {
          return !dayPlan.seancesSeChevauchent({ start: alt.start, end: alt.end }, other);
        });
      })[0] || null;
    }

    var autresQueA = fixes.filter(function (it) { return it !== pair.a; });
    var autresQueB = fixes.filter(function (it) { return it !== pair.b; });
    var altB = essaieDeplacer(pair.b, autresQueB);
    var altA = essaieDeplacer(pair.a, autresQueA);
    var choix = altB ? { cible: pair.b, alt: altB } : altA ? { cible: pair.a, alt: altA } : null;

    if (!choix) {
      asideToast("Aucun autre horaire de ces deux séances ne lève le chevauchement.");
      return;
    }
    var cible = choix.cible, alt = choix.alt;
    var previousStart = cible.start, previousEnd = cible.end;
    try {
      PDF.removeFromPlan(dateStr, cible.slug || cible.name, previousStart);
      PDF.addToPlan(dateStr, { slug: cible.slug, name: cible.name, category: cible.category, start: alt.start, end: alt.end, is_continuous: false });
    } catch (e) { /* stockage indisponible : ignoré */ }
    renderProgramme();
    PDF.toastUndo(cible.name + " déplacé à " + PDF.formatTimeFR(alt.start) + " pour lever le chevauchement.", function () {
      try {
        PDF.removeFromPlan(dateStr, cible.slug || cible.name, alt.start);
        PDF.addToPlan(dateStr, { slug: cible.slug, name: cible.name, category: cible.category, start: previousStart, end: previousEnd, is_continuous: false });
      } catch (e) { /* stockage indisponible : ignoré */ }
      renderProgramme();
    });
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
    renderAside(state.today.date, isToday, nowMinutes, allSlots);

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

    // Spectacles "en continu" : uniquement dans le mini-Gantt "Accès continu"
    // ci-dessus, jamais aussi dans cette liste (voir maquette "Programme").
    var html = "";

    if (cat.past.length) {
      var n = cat.past.length;
      var pastStarts = cat.past.map(function (s) { return s.rep.start; });
      var pastShowTime = groupConsecutiveByStart(pastStarts);
      html +=
        '<details class="past-sessions"><summary>' + PDF.icon("chevron-down") +
        "Afficher " + (n > 1 ? "les " + n + " séances passées" : "la séance passée") + "</summary>" +
        '<div class="prog-list">';
      cat.past.forEach(function (s, i) {
        html += renderProgRow(s, { isPast: true, showTime: pastShowTime[i], isNewTime: pastShowTime[i] });
      });
      html += "</div></details>";
    }

    if (isToday) {
      html += '<div class="now-divider"><span class="now-divider-dot" aria-hidden="true"></span>Maintenant · ' + PDF.escapeHtml(PDF.formatTimeFR(
        (String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0"))
      )) + "</div>";
    }

    var upcomingSorted = cat.upcoming.slice().sort(function (a, b) { return sortKeyMinutes(a.rep.start) - sortKeyMinutes(b.rep.start); });
    var upcomingShowTime = groupConsecutiveByStart(upcomingSorted.map(function (s) { return s.rep.start; }));
    var navEntries = [];
    var lastHourLabel = null;
    html += '<div class="prog-list">';
    upcomingSorted.forEach(function (slot, i) {
      var hourLabel = slot.rep.start ? PDF.formatTimeFR(slot.rep.start).replace(/h\d+$/, "h00") : "Horaire inconnu";
      if (hourLabel !== lastHourLabel) {
        lastHourLabel = hourLabel;
        if (hourLabel !== "Horaire inconnu") {
          var anchorId = "hour-group-" + hourLabel.replace(/[^0-9]/g, "");
          html += '<span class="hour-anchor" id="' + anchorId + '" aria-hidden="true"></span>';
          navEntries.push({ label: hourLabel, id: anchorId });
        }
      }
      var isNextUpcoming = slot === nextUpcomingSlot;
      var minutesUntil = isNextUpcoming && nowMinutes != null ? PDF.timeToMinutes(slot.rep.start) - nowMinutes : null;
      var isLastShowing = lastShowingSlugs.indexOf(slot.spectacle.slug) !== -1;
      html += renderProgRow(slot, {
        isNextUpcoming: isNextUpcoming,
        minutesUntil: minutesUntil,
        isLastShowing: isLastShowing,
        showTime: upcomingShowTime[i],
        isNewTime: upcomingShowTime[i],
      });
    });
    html += "</div>";

    container.innerHTML = html;
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
    renderCustomDateChip();
  }

  // "Sam. 18 déc." — étiquette courte de la puce de date libre (voir
  // #custom-date-chip, remplace le vieux bouton "Choisir une date").
  function customDateChipLabel(dateStr) {
    var d = PDF.parseISODate(dateStr);
    if (!d) return "";
    var s = d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function renderCustomDateChip() {
    var chip = document.getElementById("custom-date-chip");
    if (!chip) return;
    if (!state.customDate) { chip.hidden = true; chip.innerHTML = ""; return; }
    chip.hidden = false;
    chip.innerHTML = "<span>" + PDF.escapeHtml(customDateChipLabel(state.customDate)) + "</span>" + PDF.icon("x");
  }

  // Quitte le mode "date libre" (ré-affiche/réactive les 3 onglets Aujourd'hui/
  // Demain/Après-demain) — appelé en cliquant un de ces onglets directement.
  function exitCustomDateMode() {
    state.customDate = null;
    var input = document.getElementById("custom-date-input");
    if (input) { input.value = ""; input.hidden = true; }
  }

  // Clic sur la puce de date libre (voir renderCustomDateChip) : revient à
  // "Aujourd'hui" plutôt que de simplement fermer la puce sans rien montrer.
  function clearCustomDate() {
    exitCustomDateMode();
    state.dayOffset = 0;
    renderDaySelect();
    loadDay(0);
  }

  // "26/08/2026T08:15:00" -> "26/08 à 08:15" (pas d'année, voir maquette
  // "Programme" : note de fraîcheur courte sous le titre).
  function shortDateTimeFR(isoStr) {
    if (!isoStr) return "";
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return "";
    var dd = String(d.getDate()).padStart(2, "0");
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var hh = String(d.getHours()).padStart(2, "0");
    var min = String(d.getMinutes()).padStart(2, "0");
    return dd + "/" + mm + " à " + hh + ":" + min;
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
    // Pas de grand encart vert "Collecte à jour" tant que tout va bien (voir
    // maquette "Programme") : une simple ligne discrète sous le titre.
    // Les bannières existantes (erreur, périmé, fermé…) restent inchangées —
    // seul le cas "ok"/"partial" ET réellement à jour est remplacé ici.
    var seasonBanner = PDF.seasonClosedBannerHtml(payload);
    var isStaleToday = offset === 0 && (payload.status === "ok" || payload.status === "partial") && !PDF.isDataForToday(payload.date);
    var showBigBanner = !!seasonBanner || !(payload.status === "ok" || payload.status === "partial") || isStaleToday;
    document.getElementById("status-banner-slot").innerHTML = showBigBanner
      ? (seasonBanner || PDF.statusBannerHtml(payload.status, payload.date, (payload.representation_count || 0) > 0, offset === 0))
      : "";
    var freshnessEl = document.getElementById("programme-freshness");
    if (freshnessEl) freshnessEl.textContent = showBigBanner ? "" : "Données du " + shortDateTimeFR(payload.updated_at) + ".";
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
    document.getElementById("programme-freshness").textContent = "";
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
    document.getElementById("programme-freshness").textContent = "";
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
    var metaRowHtml =
      '<div class="prog-row-meta-row"><span class="prog-row-meta' + (low ? " is-last" : "") + '">' +
      (low ? PDF.icon("alert-triangle") + " " : "") + "probable " + pct + "%</span>" +
      PDF.categoryBadgeHtml(item.category) + "</div>";
    return (
      '<div class="prog-row is-probable">' +
      '<span class="prog-row-time tnum">' + PDF.escapeHtml(probableRowTimeLabel(item)) + "</span>" +
      '<span class="prog-row-main"><span class="prog-row-name">' + PDF.escapeHtml(item.name) + "</span>" + metaRowHtml + "</span>" +
      '<span class="prog-row-actions">' +
      (start
        ? '<button type="button" class="add-to-day-btn add-to-day-trigger' + (already ? " is-added" : "") + '" ' +
          'data-slug="' + PDF.escapeHtml(item.slug) + '" data-name="' + PDF.escapeHtml(item.name) + '" ' +
          'data-category="' + PDF.escapeHtml(item.category || "") + '" data-start="' + start + '" data-end="" data-estimated="true" ' +
          'aria-label="' + (already ? "Déjà dans ma journée" : "Ajouter à ma journée (estimation)") + '" aria-pressed="' + already + '">' +
          PDF.icon(already ? "check" : "plus") + "</button>"
        : "") +
      "</span></div>"
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
      '<div class="prog-list">' + probable.spectacles.map(function (item) { return renderProbableRow(dateStr, item); }).join("") + "</div>";
  }

  function initCustomDatePicker() {
    var toggle = document.getElementById("custom-date-toggle");
    var input = document.getElementById("custom-date-input");
    var chip = document.getElementById("custom-date-chip");
    if (!toggle || !input) return;
    toggle.innerHTML = PDF.icon("calendar");
    toggle.addEventListener("click", function () {
      var willOpen = input.hidden;
      input.hidden = !willOpen;
      toggle.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) input.focus();
    });
    input.addEventListener("change", function () {
      if (!input.value) return;
      state.customDate = input.value;
      state.dayOffset = null;
      renderDaySelect();
      loadCustomDate(input.value);
    });
    if (chip) chip.addEventListener("click", clearCustomDate);
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
    module.exports = {
      buildSlots: buildSlots,
      durationMinutes: durationMinutes,
      sortKeyMinutes: sortKeyMinutes,
      categorizeSlots: categorizeSlots,
      groupConsecutiveByStart: groupConsecutiveByStart,
      mergeContinuousByShow: mergeContinuousByShow,
    };
  }
})();
