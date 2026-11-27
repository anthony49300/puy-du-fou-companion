/* =========================================================================
   spectacles.js — logique de la page "Spectacles"
   Liste + recherche + filtre catégorie + panneau détail avec mini-graphique
   Chart.js (historique du nombre de représentations par jour).
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  var state = {
    data: null,
    query: "",
    category: "",
    sort: "name",
    selectedSlug: null,
    years: [],
    year: null,
    todayClosed: false, // voir fetchTodayStatus : "Aujourd'hui : 0" ne veut rien dire un jour de fermeture
    currentHistory: null, // historique du spectacle actuellement affiché (voir loadSpectacleHistory) — pour un redessin sans refetch (ex: pdf:themechange)
    scheduleDayType: "all", // "all" | "weekday" | "weekend" — filtre "Horaires habituels"
    schedulePeriod: "all", // "all" | "holidays" | "school" | "month:N"
    calendar: null, // data/json/calendar.json, chargé une fois (voir fetchCalendarOnce) — null si absent/non chargé
    calendarLoaded: false,
    otherSeasonFreqCache: {}, // "slug:year" -> PDF.scheduleStats.startFrequencies(...).items[0], pour la comparaison 2025 vs 2026
  };

  var chartInstance = null;

  function filteredSpectacles() {
    var list = (state.data.spectacles || []).filter(function (s) {
      if (state.category && s.category !== state.category) return false;
      if (state.query && !PDF.matchesSearch(s.name, state.query)) return false;
      return true;
    });
    if (state.sort === "most") {
      list = list.slice().sort(function (a, b) {
        return ((b.stats && b.stats.total_representations) || 0) - ((a.stats && a.stats.total_representations) || 0);
      });
    } else {
      list = list.slice().sort(function (a, b) { return a.name.localeCompare(b.name, "fr"); });
    }
    return list;
  }

  function renderCard(s) {
    var stats = s.stats || {};
    var selectedCls = s.slug === state.selectedSlug ? " is-selected" : "";
    var inactiveCls = s.active === false ? " is-inactive" : "";
    // Un jour de fermeture, "Aujourd'hui : 0" ne veut rien dire (0 partout,
    // sans rapport avec la popularité du spectacle) : on masque la ligne
    // plutôt que d'afficher un remplaçant ("Fermé") qui prendrait quand
    // même la place d'une vraie donnée.
    var todayLabel = state.todayClosed
      ? ""
      : "<span>Aujourd'hui : <strong>" + (stats.today_count != null ? stats.today_count : "—") + "</strong></span>";
    return (
      '<div class="card spectacle-card' + selectedCls + inactiveCls + '" data-slug="' + PDF.escapeHtml(s.slug) + '" tabindex="0" role="button" aria-pressed="' + (s.slug === state.selectedSlug) + '">' +
      '<div class="spectacle-card-head"><h3>' + PDF.escapeHtml(s.name) + "</h3>" +
      PDF.categoryBadgeHtml(s.category) +
      "</div>" +
      (s.active === false ? '<span class="badge badge-default">Inactif</span>' : "") +
      '<div class="spectacle-stats-mini">' +
      todayLabel +
      '<span>Moyenne/jour : <strong>' + PDF.formatNumberFR(stats.avg_per_day) + "</strong></span>" +
      '<span>Jours présents : <strong>' + (stats.days_present != null ? stats.days_present : "—") + "</strong></span>" +
      '<span>Jours absents : <strong>' + (stats.days_absent != null ? stats.days_absent : "—") + "</strong></span>" +
      "</div>" +
      "</div>"
    );
  }

  function renderGrid() {
    var grid = document.getElementById("spectacles-grid");
    var list = filteredSpectacles();
    if (list.length === 0) {
      grid.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1;"><div class="empty-icon" aria-hidden="true">🔍</div>' +
        "<p>Aucun spectacle ne correspond à votre recherche.</p></div>";
      return;
    }
    grid.innerHTML = list.map(renderCard).join("");
    grid.querySelectorAll(".spectacle-card").forEach(function (card) {
      card.addEventListener("click", function () {
        selectSpectacle(card.getAttribute("data-slug"));
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectSpectacle(card.getAttribute("data-slug"));
        }
      });
    });
  }

  // L'ancre reflète la sélection (lien partageable vers un spectacle précis)
  // via replaceState plutôt qu'un simple location.hash = ... : ce dernier
  // déclenche un saut natif du navigateur qui romprait le scroll "smooth"
  // juste en dessous, et empilerait une entrée d'historique à chaque clic.
  function selectSpectacle(slug) {
    state.selectedSlug = slug;
    renderGrid();
    renderDetail();
    history.replaceState(null, "", slug ? "#" + slug : location.pathname + location.search);
    var panel = document.getElementById("detail-panel");
    if (panel && !panel.hidden) {
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function findSpectacle(slug) {
    return (state.data.spectacles || []).find(function (s) { return s.slug === slug; });
  }

  // Spectacle éphémère (Toussaint, Noël...) : badge avec sa plage de dates
  // pour la saison affichée (voir active_periods, src/statistics.py).
  // Permanent (aucune période configurée) : pas de badge.
  function activePeriodsBadgeHtml(periods) {
    if (!periods || !periods.length) return "";
    return periods.map(function (p) {
      return (
        '<span class="badge badge-default">' + PDF.icon("calendar") + " " +
        PDF.escapeHtml(PDF.formatDateFR(p.from)) + " → " + PDF.escapeHtml(PDF.formatDateFR(p.to)) +
        "</span>"
      );
    }).join("");
  }

  // data/json/history/{year}/spectacle-history/{slug}.json (ou
  // data/json/spectacle-history/{slug}.json sans sélecteur d'année) : voir
  // src/exporter.py:export_spectacles — l'historique détaillé (un point
  // par jour) n'est plus embarqué dans la liste principale des spectacles,
  // chargé seulement ici, à l'ouverture du panneau d'UN spectacle.
  function spectacleHistoryPath(slug) {
    return state.year
      ? "history/" + state.year + "/spectacle-history/" + slug + ".json"
      : "spectacle-history/" + slug + ".json";
  }

  // Chargé une seule fois pour toute la session (pas par spectacle) :
  // dégrade sans erreur si le fichier est absent (saison sans calendrier
  // renseigné) — voir §5 de la fonctionnalité "distribution horaire".
  function fetchCalendarOnce() {
    if (state.calendarLoaded) return Promise.resolve(state.calendar);
    return PDF.fetchJSON("calendar.json")
      .then(function (data) { state.calendar = data; return data; })
      .catch(function () { state.calendar = null; return null; })
      .then(function (data) { state.calendarLoaded = true; return data; });
  }

  function renderDetail() {
    var panel = document.getElementById("detail-panel");
    var s = state.selectedSlug ? findSpectacle(state.selectedSlug) : null;
    state.currentHistory = null; // voir le listener pdf:themechange plus bas

    if (!s) {
      panel.hidden = true;
      panel.innerHTML = "";
      if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
      return;
    }

    panel.hidden = false;
    var stats = s.stats || {};
    panel.innerHTML =
      '<div class="detail-panel-head">' +
      "<div><h2>" + PDF.escapeHtml(s.name) + "</h2>" + PDF.categoryBadgeHtml(s.category) +
      activePeriodsBadgeHtml(s.active_periods) + "</div>" +
      '<button type="button" class="btn btn-outline" id="close-detail">Fermer ✕</button>' +
      "</div>" +
      '<div class="stat-grid">' +
      '<div class="stat-tile"><div class="stat-label">Représentations totales</div><div class="stat-value">' + (stats.total_representations != null ? stats.total_representations : "—") + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Moyenne / jour</div><div class="stat-value">' + PDF.formatNumberFR(stats.avg_per_day) + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Jours présents</div><div class="stat-value">' + (stats.days_present != null ? stats.days_present : "—") + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Jours absents</div><div class="stat-value">' + (stats.days_absent != null ? stats.days_absent : "—") + "</div></div>" +
      "</div>" +
      '<div id="spectacle-history-slot"><div class="empty-state"><div class="skeleton" style="height:14rem;"></div></div></div>';

    var closeBtn = document.getElementById("close-detail");
    if (closeBtn) closeBtn.addEventListener("click", function () { selectSpectacle(null); });

    loadSpectacleHistory(s);
  }

  // Charge l'historique détaillé d'UN spectacle à la demande (voir
  // spectacleHistoryPath) plutôt que de compter sur `s.history`, qui
  // n'existe plus dans la liste principale (voir spectacleHistoryPath).
  function loadSpectacleHistory(s) {
    var slot = document.getElementById("spectacle-history-slot");
    Promise.all([PDF.fetchJSON(spectacleHistoryPath(s.slug)), fetchCalendarOnce()])
      .then(function (results) {
        var data = results[0];
        // La sélection a pu changer pendant le chargement (clic rapide sur
        // une autre carte) : ne pas écraser le panneau d'un AUTRE spectacle.
        if (state.selectedSlug !== s.slug || !slot.isConnected) return;
        var history = data.history || [];
        if (!history.length) {
          slot.innerHTML = '<p class="text-muted">Aucun historique disponible pour ce spectacle.</p>';
          return;
        }
        state.currentHistory = history;
        slot.innerHTML =
          '<div class="chart-wrap"><canvas id="spectacle-history-chart" role="img" aria-label="Historique du nombre de représentations par jour pour ' + PDF.escapeHtml(s.name) + '"></canvas></div>' +
          '<details class="chart-table-details"><summary>Voir les données en tableau</summary>' +
          '<div class="table-wrap"><table class="data-table" id="spectacle-history-table"></table></div></details>' +
          '<div id="schedule-section-slot"></div>';
        drawHistoryChart(history);
        renderScheduleSection(s);
      })
      .catch(function (err) {
        if (state.selectedSlug !== s.slug || !slot.isConnected) return;
        PDF.renderErrorMessage(slot, "Impossible de charger l'historique de ce spectacle (" + err.message + ").");
      });
  }

  /* ----------------------------------------------------------------------
   * "Horaires habituels" : distribution par créneau, régularité, heatmap,
   * chronologie des créneaux, comparaison inter-saisons (voir
   * site/js/schedule-stats.js pour les calculs purs, ici seulement le rendu).
   * ---------------------------------------------------------------------- */
  var PERIOD_LABELS = { all: "Toute la saison", holidays: "Vacances scolaires", school: "Hors vacances" };

  function monthOptionsFromHistory(history) {
    var seen = {};
    var months = [];
    history.forEach(function (h) {
      var m = +h.date.slice(5, 7);
      if (!seen[m]) { seen[m] = true; months.push(m); }
    });
    months.sort(function (a, b) { return a - b; });
    return months;
  }

  function renderScheduleFilters(s, history) {
    var hasCalendar = !!state.calendar;
    var months = monthOptionsFromHistory(history);
    var periodOptions = ["all"].concat(hasCalendar ? ["holidays", "school"] : []).concat(
      months.map(function (m) { return "month:" + m; })
    );
    var segmented =
      '<div class="segmented schedule-daytype">' +
      ["all", "weekday", "weekend"].map(function (key) {
        var label = key === "all" ? "Tous" : key === "weekday" ? "Semaine" : "Week-end";
        var active = state.scheduleDayType === key;
        return '<button type="button" class="segment' + (active ? " active" : "") + '" data-daytype="' + key + '" aria-pressed="' + active + '"><span>' + label + "</span></button>";
      }).join("") +
      "</div>";
    var select =
      '<select class="filter-select" id="schedule-period-select" aria-label="Période">' +
      periodOptions.map(function (key) {
        var label = PERIOD_LABELS[key] || PDF.MONTH_LABELS[+key.slice(6) - 1];
        return '<option value="' + key + '"' + (state.schedulePeriod === key ? " selected" : "") + ">" + label + "</option>";
      }).join("") +
      "</select>";
    return '<div class="schedule-filters">' + segmented + select + "</div>";
  }

  function slotChipsHtml(freq, unit) {
    if (!freq.items.length) return '<p class="text-muted">Aucune séance pour ce filtre.</p>';
    var html = '<div class="chip-row">' + freq.items.map(function (item) {
      var label = unit === "range" ? item.time.replace("-", "–") : PDF.formatTimeFR(item.time);
      return (
        '<span class="chip slot-chip' + (item.fixed ? " is-fixed" : "") + '">' +
        PDF.escapeHtml(label) + " · " + Math.round(item.share * 100) + " %" +
        (item.fixed ? " · Créneau fixe" : "") +
        "</span>"
      );
    }).join("") + "</div>";
    if (freq.sample < 10) {
      html += '<p class="text-muted schedule-low-sample">Peu de données (' + freq.sample + " jour" + (freq.sample > 1 ? "s" : "") + " comparable" + (freq.sample > 1 ? "s" : "") + ").</p>";
    }
    return html;
  }

  function regularityBadgeHtml(reg) {
    var level = reg.share >= 0.7 ? "high" : reg.share >= 0.4 ? "medium" : reg.sample === 0 ? "none" : "low";
    var patternLabel = reg.pattern.length
      ? reg.pattern.map(function (p) { return p.indexOf("-") !== -1 ? p.replace("-", "–") : PDF.formatTimeFR(p); }).join(" · ")
      : null;
    return (
      '<div class="regularity-badge regularity-' + level + '">' +
      "<strong>" + PDF.escapeHtml(reg.label) + "</strong>" +
      (patternLabel ? "<span> — Le plus souvent : " + PDF.escapeHtml(patternLabel) + "</span>" : "") +
      "</div>"
    );
  }

  function heatmapHtml(heatmap) {
    if (!heatmap.hours.length) return "";
    var cols = heatmap.hours.length;
    var header = '<div class="heatmap-corner"></div>' + heatmap.hours.map(function (h) {
      return '<div class="heatmap-hour-label">' + h + "h</div>";
    }).join("");
    var rows = heatmap.rows.map(function (row) {
      var label = '<div class="heatmap-row-label">' + PDF.DOW_LABELS[row.weekday] + "</div>";
      var cells = row.cells.map(function (cell) {
        var pct = Math.round(cell.share * 100);
        var title = PDF.DOW_LABELS[row.weekday] + ", " + cell.hour + " h : " + pct + "% des jours (" + cell.count + "/" + cell.total + ")";
        return (
          '<div class="heatmap-cell" style="--cell-share:' + cell.share + '" title="' + PDF.escapeHtml(title) + '" ' +
          'tabindex="0" aria-label="' + PDF.escapeHtml(title) + '"></div>'
        );
      }).join("");
      return label + cells;
    }).join("");
    var table =
      '<table class="data-table"><thead><tr><th></th>' +
      heatmap.hours.map(function (h) { return "<th>" + h + "h</th>"; }).join("") + "</tr></thead><tbody>" +
      heatmap.rows.map(function (row) {
        return "<tr><th>" + PDF.DOW_LABELS[row.weekday] + "</th>" +
          row.cells.map(function (c) { return "<td>" + Math.round(c.share * 100) + "%</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
    return (
      '<div class="heatmap-wrap">' +
      '<div class="heatmap-grid" style="grid-template-columns:auto repeat(' + cols + ',1fr)">' + header + rows + "</div>" +
      '<div class="heatmap-legend"><span class="heatmap-legend-swatch"></span> Part des jours avec une séance à cette heure</div>' +
      '<details class="chart-table-details"><summary>Voir en tableau</summary><div class="table-wrap">' + table + "</div></details>" +
      "</div>"
    );
  }

  function sparklineHtml(series) {
    return '<span class="sparkline">' + series.map(function (w) {
      return '<span class="sparkline-dot' + (w.present ? " is-on" : "") + '"></span>';
    }).join("") + "</span>";
  }

  function slotTimelineHtml(timeline, unit) {
    if (!timeline.length) return "";
    return (
      '<div class="slot-timeline">' +
      timeline.map(function (t) {
        var label = unit === "range" ? t.time.replace("-", "–") : PDF.formatTimeFR(t.time);
        return (
          '<div class="slot-timeline-row">' +
          '<span class="slot-timeline-time">' + PDF.escapeHtml(label) + "</span>" +
          sparklineHtml(t.series) +
          '<span class="slot-timeline-dates text-muted">' +
          (t.firstSeen ? PDF.formatDateFR(t.firstSeen) : "—") + " → " + (t.lastSeen ? PDF.formatDateFR(t.lastSeen) : "—") +
          "</span></div>"
        );
      }).join("") +
      "</div>"
    );
  }

  // Comparaison "2025 vs 2026" du créneau principal : chargée à la demande
  // (une seule requête par saison/slug, mise en cache) — jamais bloquante
  // pour le reste du panneau.
  function renderSeasonComparison(s) {
    var el = document.getElementById("schedule-compare-slot");
    if (!el || state.years.length < 2) return;
    var otherYear = state.years.find(function (y) { return y !== state.year; });
    if (!otherYear) return;
    var cacheKey = s.slug + ":" + otherYear;
    var cached = state.otherSeasonFreqCache[cacheKey];
    if (cached !== undefined) {
      renderComparisonRow(el, otherYear, cached);
      return;
    }
    PDF.fetchJSON("history/" + otherYear + "/spectacle-history/" + s.slug + ".json")
      .then(function (data) {
        var history = data.history || [];
        var freq = PDF.scheduleStats.startFrequencies(history);
        var top = freq.items[0] || null;
        state.otherSeasonFreqCache[cacheKey] = top;
        if (state.selectedSlug === s.slug) renderComparisonRow(el, otherYear, top);
      })
      .catch(function () {
        state.otherSeasonFreqCache[cacheKey] = null;
        if (state.selectedSlug === s.slug) renderComparisonRow(el, otherYear, null);
      });
  }

  function renderComparisonRow(el, otherYear, otherTop) {
    var currentFreq = PDF.scheduleStats.startFrequencies(state.currentHistory || []);
    var currentTop = currentFreq.items[0];
    if (!currentTop && !otherTop) { el.innerHTML = ""; return; }
    el.innerHTML =
      '<div class="section-label">' + state.year + " vs " + otherYear + "</div>" +
      '<div class="season-compare-row">' +
      '<span class="season-compare-chip">' + state.year + " : " + (currentTop ? PDF.formatTimeFR(currentTop.time) + " (" + Math.round(currentTop.share * 100) + "%)" : "—") + "</span>" +
      '<span class="season-compare-chip">' + otherYear + " : " + (otherTop ? PDF.formatTimeFR(otherTop.time) + " (" + Math.round(otherTop.share * 100) + "%)" : "—") + "</span>" +
      "</div>";
  }

  function renderScheduleSection(s) {
    var el = document.getElementById("schedule-section-slot");
    if (!el) return;
    var history = state.currentHistory || [];
    if (!PDF.scheduleStats) { el.innerHTML = ""; return; }

    var filtered = PDF.scheduleStats.filterDays(history, state.calendar, { dayType: state.scheduleDayType, period: state.schedulePeriod });
    var hasRanges = history.some(function (h) { return h.ranges && h.ranges.length; });
    var hasStarts = history.some(function (h) { return h.starts && h.starts.length; });
    var isContinuous = hasRanges && !hasStarts;
    var freq = isContinuous ? PDF.scheduleStats.rangeFrequencies(filtered) : PDF.scheduleStats.startFrequencies(filtered);
    var reg = PDF.scheduleStats.regularity(filtered);
    var heatmap = isContinuous ? { hours: [], rows: [] } : PDF.scheduleStats.weekdayHourHeatmap(filtered);
    var timeline = isContinuous ? [] : PDF.scheduleStats.slotTimeline(filtered);

    el.innerHTML =
      '<div class="section schedule-section">' +
      "<h3>Horaires habituels</h3>" +
      renderScheduleFilters(s, history) +
      '<div class="section-label">' + (isContinuous ? "Plages d'accès habituelles" : "Créneaux habituels") + "</div>" +
      slotChipsHtml(freq, isContinuous ? "range" : "start") +
      regularityBadgeHtml(reg) +
      (heatmap.hours.length ? '<div class="section-label">Répartition par jour et heure</div>' + heatmapHtml(heatmap) : "") +
      (timeline.length ? '<div class="section-label">Chronologie des créneaux</div>' + slotTimelineHtml(timeline, isContinuous ? "range" : "start") : "") +
      '<div id="schedule-compare-slot"></div>' +
      "</div>";

    var daytypeButtons = el.querySelectorAll(".schedule-daytype .segment");
    daytypeButtons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.scheduleDayType = btn.getAttribute("data-daytype");
        renderScheduleSection(s);
      });
    });
    var periodSelect = document.getElementById("schedule-period-select");
    if (periodSelect) {
      periodSelect.addEventListener("change", function () {
        state.schedulePeriod = periodSelect.value;
        renderScheduleSection(s);
      });
    }

    renderSeasonComparison(s);
  }

  // Rempli dans tous les cas (voir drawHistoryChart) : seule vue possible
  // si Chart.js ne s'est pas chargé (CDN hors service, bloqueur de script...).
  function renderHistoryTable(history) {
    var table = document.getElementById("spectacle-history-table");
    if (!table) return;
    table.innerHTML =
      "<thead><tr><th>Date</th><th>Représentations</th></tr></thead><tbody>" +
      history.map(function (h) {
        return "<tr><td>" + PDF.escapeHtml(PDF.formatDateFR(h.date)) + "</td><td>" + h.count + "</td></tr>";
      }).join("") +
      "</tbody>";
  }

  function drawHistoryChart(history) {
    var canvas = document.getElementById("spectacle-history-chart");
    if (!canvas) return;
    renderHistoryTable(history);

    if (typeof Chart === "undefined") {
      var panel = document.getElementById("detail-panel");
      var details = panel && panel.querySelector(".chart-table-details");
      if (details) details.open = true;
      var chartWrap = canvas.closest(".chart-wrap");
      if (chartWrap) {
        chartWrap.innerHTML = '<div class="empty-state"><p>Graphique indisponible (bibliothèque non chargée) — voir le tableau ci-dessous.</p></div>';
      }
      return;
    }

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    var theme = PDF.getChartTheme();
    var labels = history.map(function (h) { return PDF.formatDateFR(h.date); });
    var values = history.map(function (h) { return h.count; });

    chartInstance = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: labels,
        datasets: [{
          label: "Représentations / jour",
          data: values,
          borderColor: theme.bordeaux,
          backgroundColor: theme.bordeaux + "33",
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: theme.bordeaux,
          fill: true,
          tension: 0.25,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: theme.surface,
            titleColor: theme.text,
            bodyColor: theme.text,
            borderColor: theme.border,
            borderWidth: 1,
          },
        },
        scales: {
          x: { ticks: { color: theme.textSoft }, grid: { color: theme.grid } },
          y: {
            beginAtZero: true,
            ticks: { color: theme.textSoft, precision: 0 },
            grid: { color: theme.grid },
          },
        },
      },
    });
  }

  // Charge la liste des spectacles d'UNE saison (ou le fichier global si
  // year est absent/inconnu) — data/json/history/{year}/spectacles.json,
  // même forme que spectacles.json (voir src/exporter.py:export_spectacles).
  function loadYear(year) {
    var path = year ? "history/" + year + "/spectacles.json" : "spectacles.json";
    return PDF.fetchJSON(path).then(function (data) {
      state.data = data;
      state.selectedSlug = null; // la sélection ne survit pas à un changement de saison
      renderGrid();
      renderDetail();
    });
  }

  function renderYearSelect() {
    var wrap = document.getElementById("spectacles-year-select");
    if (!wrap) return;
    if (state.years.length <= 1) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.innerHTML = state.years.map(function (y) {
      return '<button type="button" class="chip' + (y === state.year ? " active" : "") + '" data-year="' + y + '">' + y + "</button>";
    }).join("");
    wrap.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.year = +btn.getAttribute("data-year");
        renderYearSelect();
        loadYear(state.year).catch(function (err) {
          PDF.renderErrorMessage(
            document.getElementById("spectacles-grid"),
            "Impossible de charger les spectacles de " + state.year + " (" + err.message + ")."
          );
        });
      });
    });
  }

  function populateCategoryFilter() {
    var select = document.getElementById("category-filter");
    var cats = state.data.categories || [];
    cats.forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = PDF.categoryLabel(cat);
      select.appendChild(opt);
    });
    select.addEventListener("change", function () {
      state.category = select.value;
      renderGrid();
    });
  }

  // "Aujourd'hui : 0" sur chaque carte n'a aucun sens un jour de fermeture
  // (0 partout, sans rapport avec la popularité du spectacle) : on vérifie
  // le statut du jour une fois, à part du reste (indépendant de la saison
  // affichée par le sélecteur d'année).
  function fetchTodayClosedStatus() {
    return PDF.fetchJSON("today.json")
      .then(function (today) { state.todayClosed = today.status === "closed_day" || today.status === "out_of_season"; })
      .catch(function () { state.todayClosed = false; });
  }

  // Ouvre directement le spectacle désigné par l'ancre de l'URL (lien
  // partagé) une fois les données chargées — sans ça, un lien vers
  // "#les-vikings" n'ouvrirait rien de plus qu'un chargement normal.
  function openFromHash() {
    var slug = location.hash.replace(/^#/, "");
    if (slug && findSpectacle(slug)) selectSpectacle(slug);
  }

  function init() {
    PDF.createSearchBar(document.getElementById("search-slot"), {
      placeholder: "Rechercher un spectacle (ex: Vikings)…",
      onChange: function (value) {
        state.query = value;
        renderGrid();
      },
    });
    document.getElementById("sort-select").addEventListener("change", function (e) {
      state.sort = e.target.value;
      renderGrid();
    });

    Promise.all([
      PDF.fetchJSON("dates.json").then(function (datesData) {
        state.years = Array.from(new Set((datesData.dates || []).map(function (d) { return d.season_year; }).filter(Boolean)))
          .sort(function (a, b) { return b - a; });
        state.year = state.years[0] || null;
        renderYearSelect();
        return loadYear(state.year);
      }),
      fetchTodayClosedStatus(),
    ])
      .then(function () {
        populateCategoryFilter(); // catégories identiques quelle que soit la saison : une seule fois suffit
        renderGrid(); // re-rendu : fetchTodayClosedStatus peut avoir résolu après le premier rendu de loadYear
        openFromHash();
      })
      .catch(function (err) {
        PDF.renderErrorMessage(
          document.getElementById("spectacles-grid"),
          "Impossible de charger la liste des spectacles (" + err.message + ")."
        );
      });

    window.addEventListener("pdf:themechange", function () {
      // Redessine avec l'historique déjà en mémoire (voir
      // loadSpectacleHistory) plutôt que de le recharger pour rien.
      if (state.selectedSlug && state.currentHistory) drawHistoryChart(state.currentHistory);
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
