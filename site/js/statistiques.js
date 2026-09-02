/* =========================================================================
   statistiques.js — logique de la page "Statistiques"
   6 graphiques Chart.js + tuiles de stats globales + tableau des saisons.
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  var charts = {}; // id -> Chart instance
  var statsData = null;
  var state = { periodDays: 30 }; // 0 = toute la saison ; s'applique aux graphiques "isDate"

  var CHART_DEFS = [
    {
      id: "chart-per-spectacle",
      title: "Représentations par spectacle",
      desc: "Nombre total de représentations sur la période, par spectacle.",
      type: "bar",
      dataKey: "representations_per_spectacle",
      labelField: "name",
      valueField: "count",
      color: "bordeaux",
      labelHeader: "Spectacle",
      valueHeader: "Représentations",
    },
    {
      id: "chart-per-day",
      title: "Spectacles différents par jour",
      desc: "Nombre de spectacles distincts au programme chaque jour.",
      type: "line",
      dataKey: "spectacles_per_day",
      labelField: "date",
      valueField: "count",
      color: "forest",
      isDate: true,
      labelHeader: "Date",
      valueHeader: "Spectacles différents",
    },
    {
      id: "chart-seasonal",
      title: "Évolution saisonnière",
      desc: "Nombre total de représentations, jour après jour.",
      type: "line",
      dataKey: "seasonal_evolution",
      labelField: "date",
      valueField: "count",
      color: "amber",
      isDate: true,
      labelHeader: "Date",
      valueHeader: "Représentations",
    },
    {
      id: "chart-hourly",
      title: "Distribution des horaires",
      desc: "Nombre de représentations démarrant à chaque heure de la journée.",
      type: "bar",
      dataKey: "hourly_distribution",
      labelField: "hour",
      valueField: "count",
      color: "forest",
      labelHeader: "Heure",
      valueHeader: "Représentations",
    },
    {
      id: "chart-top",
      title: "Spectacles les plus programmés",
      desc: "Top des spectacles avec le plus grand nombre de représentations.",
      type: "bar-h",
      dataKey: "top_spectacles",
      labelField: "name",
      valueField: "count",
      color: "bordeaux",
      labelHeader: "Spectacle",
      valueHeader: "Représentations",
    },
    {
      id: "chart-bottom",
      title: "Spectacles les moins programmés",
      desc: "Spectacles avec le plus petit nombre de représentations.",
      type: "bar-h",
      dataKey: "bottom_spectacles",
      labelField: "name",
      valueField: "count",
      color: "amber",
      labelHeader: "Spectacle",
      valueHeader: "Représentations",
    },
  ];

  function buildChartCards() {
    var grid = document.getElementById("charts-grid");
    grid.innerHTML = CHART_DEFS.map(function (def) {
      return (
        '<div class="card chart-card">' +
        "<h3>" + PDF.escapeHtml(def.title) + "</h3>" +
        '<p class="chart-desc">' + PDF.escapeHtml(def.desc) + "</p>" +
        '<div class="chart-wrap"><canvas id="' + def.id + '"></canvas></div>' +
        '<details class="chart-table-details">' +
        "<summary>Voir les données en tableau</summary>" +
        '<div class="table-wrap"><table class="data-table" id="' + def.id + '-table"></table></div>' +
        "</details>" +
        "</div>"
      );
    }).join("");
  }

  function renderChartTable(def, rows) {
    var table = document.getElementById(def.id + "-table");
    if (!table) return;
    table.innerHTML =
      "<thead><tr><th>" + PDF.escapeHtml(def.labelHeader) + "</th><th>" + PDF.escapeHtml(def.valueHeader) + "</th></tr></thead>" +
      "<tbody>" +
      (rows.length
        ? rows.map(function (r) {
            var label = def.isDate ? PDF.formatDateFR(r[def.labelField]) : r[def.labelField];
            return "<tr><td>" + PDF.escapeHtml(String(label)) + "</td><td>" + PDF.escapeHtml(String(r[def.valueField])) + "</td></tr>";
          }).join("")
        : '<tr><td colspan="2" class="text-muted">Aucune donnée disponible.</td></tr>') +
      "</tbody>";
  }

  function colorFor(theme, name) {
    return { bordeaux: theme.bordeaux, amber: theme.amber, forest: theme.forest }[name] || theme.accent;
  }

  // Ne garde que les N derniers jours (ancrés sur la dernière date connue,
  // pas la date système : évite un graphique vide si la collecte a du retard).
  // 0/falsy = pas de filtre (toute la période).
  function filterByPeriod(rows) {
    if (!state.periodDays || rows.length <= state.periodDays) return rows;
    var lastDate = PDF.parseISODate(rows[rows.length - 1].date);
    var cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - state.periodDays + 1);
    return rows.filter(function (r) { return PDF.parseISODate(r.date) >= cutoff; });
  }

  // Config des ticks de l'axe x. Sur une longue période, un label par jour
  // est illisible : on n'affiche que le 1er de chaque mois (+ premier/
  // dernier point), calé sur le calendrier. Uniquement pour les graphiques
  // temporels — sur les autres (catégories : spectacles, heures...), la clé
  // callback ne doit MÊME PAS exister : un callback undefined (au lieu
  // d'absent) empêche Chart.js d'utiliser son formatage par défaut et fait
  // apparaître l'index brut (0, 1, 2...) à la place du vrai libellé.
  function buildXTicks(def, rows, textSoftColor) {
    var ticks = { color: textSoftColor, maxRotation: 45, minRotation: 0, autoSkip: !def.isDate };
    if (def.isDate) {
      ticks.callback = function (value, index) {
        var row = rows[index];
        if (!row) return "";
        if (rows.length <= 31 || index === 0 || index === rows.length - 1) return PDF.formatDateFR(row.date);
        return PDF.parseISODate(row.date).getDate() === 1 ? PDF.formatDateFR(row.date) : "";
      };
    }
    return ticks;
  }

  function renderChart(def) {
    var canvas = document.getElementById(def.id);
    if (!canvas || typeof Chart === "undefined") return;
    var rows = (statsData.charts && statsData.charts[def.dataKey]) || [];
    if (def.isDate) rows = filterByPeriod(rows);
    renderChartTable(def, rows);
    var theme = PDF.getChartTheme();
    var color = colorFor(theme, def.color);

    var labels = rows.map(function (r) {
      var v = r[def.labelField];
      return def.isDate ? PDF.formatDateFR(v) : v;
    });
    var values = rows.map(function (r) { return r[def.valueField]; });

    if (charts[def.id]) { charts[def.id].destroy(); }

    var isLine = def.type === "line";
    var isHorizontal = def.type === "bar-h";

    var dataset = {
      label: def.title,
      data: values,
      borderColor: color,
      backgroundColor: isLine ? color + "33" : color,
      borderWidth: isLine ? 2 : 0,
      borderRadius: isLine ? 0 : 4,
      pointRadius: isLine ? 2 : 0,
      pointBackgroundColor: color,
      fill: isLine,
      tension: 0.25,
      maxBarThickness: 34,
    };

    if (!rows.length) {
      var ctxEmpty = canvas.getContext("2d");
      ctxEmpty.clearRect(0, 0, canvas.width, canvas.height);
      var wrap = canvas.closest(".chart-wrap");
      if (wrap && !wrap.querySelector(".empty-state")) {
        wrap.innerHTML = '<div class="empty-state"><p>Aucune donnée disponible.</p></div>';
      }
      return;
    }

    var xTicks = buildXTicks(def, rows, theme.textSoft);

    charts[def.id] = new Chart(canvas.getContext("2d"), {
      type: isLine ? "line" : "bar",
      data: { labels: labels, datasets: [dataset] },
      options: {
        indexAxis: isHorizontal ? "y" : "x",
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
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
          x: {
            ticks: xTicks,
            grid: { color: theme.grid, display: !isHorizontal },
          },
          y: {
            beginAtZero: true,
            ticks: { color: theme.textSoft, precision: 0 },
            grid: { color: theme.grid, display: isHorizontal ? false : true },
          },
        },
      },
    });
  }

  function renderAllCharts() {
    // Un graphique en erreur ne doit pas empêcher le rendu des suivants.
    CHART_DEFS.forEach(function (def) {
      try { renderChart(def); } catch (err) { console.error("Graphique " + def.id + " :", err); }
    });
  }

  function renderGlobalStats(g) {
    var el = document.getElementById("global-stats");
    function tile(label, value, sub) {
      return (
        '<div class="stat-tile"><div class="stat-label">' + PDF.escapeHtml(label) + "</div>" +
        '<div class="stat-value">' + (value == null ? "—" : PDF.escapeHtml(String(value))) + "</div>" +
        (sub ? '<div class="stat-sub">' + sub + "</div>" : "") +
        "</div>"
      );
    }
    var minSub = g.min_per_day ? PDF.formatDateFR(g.min_per_day.date) : "";
    var maxSub = g.max_per_day ? PDF.formatDateFR(g.max_per_day.date) : "";
    el.innerHTML =
      tile("Spectacles au total", g.total_spectacles) +
      tile("Représentations au total", g.total_representations) +
      tile("Moyenne / jour", g.avg_per_day) +
      tile("Minimum / jour", g.min_per_day ? g.min_per_day.count : null, minSub) +
      tile("Maximum / jour", g.max_per_day ? g.max_per_day.count : null, maxSub) +
      tile("Représentations en continu", g.continuous_count) +
      tile("Représentations nocturnes", g.nocturnal_count);
  }

  function renderSeasonTable(bySeason) {
    var tbody = document.querySelector("#season-table tbody");
    if (!bySeason || !bySeason.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted">Aucune donnée de saison disponible.</td></tr>';
      return;
    }
    tbody.innerHTML = bySeason
      .slice()
      .sort(function (a, b) { return b.year - a.year; })
      .map(function (s) {
        return (
          "<tr><td>" + PDF.escapeHtml(String(s.year)) + "</td>" +
          "<td>" + s.total_spectacles + "</td>" +
          "<td>" + s.total_representations + "</td>" +
          "<td>" + s.days_collected + "</td></tr>"
        );
      })
      .join("");
  }

  function init() {
    buildChartCards();

    document.querySelectorAll("#period-filter .chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("#period-filter .chip").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        state.periodDays = +btn.getAttribute("data-days");
        if (statsData) renderAllCharts();
      });
    });

    PDF.fetchJSON("stats.json")
      .then(function (data) {
        statsData = data;
        renderGlobalStats(data.global || {});
        renderSeasonTable(data.by_season || []);
        renderAllCharts();
      })
      .catch(function (err) {
        PDF.renderErrorMessage(
          document.getElementById("stats-error-slot"),
          "Impossible de charger les statistiques (" + err.message + ")."
        );
      });

    window.addEventListener("pdf:themechange", function () {
      if (statsData) renderAllCharts();
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  // Exposé pour les tests (tests/frontend/) — no-op dans un navigateur.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { filterByPeriod: filterByPeriod, buildXTicks: buildXTicks, state: state };
  }
})();
