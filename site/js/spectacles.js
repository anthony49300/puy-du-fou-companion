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
    selectedSlug: null,
  };

  var chartInstance = null;

  function filteredSpectacles() {
    return (state.data.spectacles || []).filter(function (s) {
      if (state.category && s.category !== state.category) return false;
      if (state.query && !PDF.matchesSearch(s.name, state.query)) return false;
      return true;
    });
  }

  function renderCard(s) {
    var stats = s.stats || {};
    var selectedCls = s.slug === state.selectedSlug ? " is-selected" : "";
    var inactiveCls = s.active === false ? " is-inactive" : "";
    return (
      '<div class="card spectacle-card' + selectedCls + inactiveCls + '" data-slug="' + PDF.escapeHtml(s.slug) + '" tabindex="0" role="button" aria-pressed="' + (s.slug === state.selectedSlug) + '">' +
      '<div class="spectacle-card-head"><h3>' + PDF.escapeHtml(s.name) + "</h3>" +
      PDF.categoryBadgeHtml(s.category) +
      "</div>" +
      (s.active === false ? '<span class="badge badge-default">Inactif</span>' : "") +
      '<div class="spectacle-stats-mini">' +
      '<span>Aujourd\'hui : <strong>' + (stats.today_count != null ? stats.today_count : "—") + "</strong></span>" +
      '<span>Moyenne/jour : <strong>' + (stats.avg_per_day != null ? stats.avg_per_day : "—") + "</strong></span>" +
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

  function selectSpectacle(slug) {
    state.selectedSlug = slug;
    renderGrid();
    renderDetail();
    var panel = document.getElementById("detail-panel");
    if (panel && !panel.hidden) {
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function findSpectacle(slug) {
    return (state.data.spectacles || []).find(function (s) { return s.slug === slug; });
  }

  function renderDetail() {
    var panel = document.getElementById("detail-panel");
    var s = state.selectedSlug ? findSpectacle(state.selectedSlug) : null;

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
      "<div><h2>" + PDF.escapeHtml(s.name) + "</h2>" + PDF.categoryBadgeHtml(s.category) + "</div>" +
      '<button type="button" class="btn btn-outline" id="close-detail">Fermer ✕</button>' +
      "</div>" +
      '<div class="stat-grid">' +
      '<div class="stat-tile"><div class="stat-label">Représentations totales</div><div class="stat-value">' + (stats.total_representations != null ? stats.total_representations : "—") + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Moyenne / jour</div><div class="stat-value">' + (stats.avg_per_day != null ? stats.avg_per_day : "—") + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Jours présents</div><div class="stat-value">' + (stats.days_present != null ? stats.days_present : "—") + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Jours absents</div><div class="stat-value">' + (stats.days_absent != null ? stats.days_absent : "—") + "</div></div>" +
      "</div>" +
      (s.history && s.history.length
        ? '<div class="chart-wrap"><canvas id="spectacle-history-chart" role="img" aria-label="Historique du nombre de représentations par jour pour ' + PDF.escapeHtml(s.name) + '"></canvas></div>'
        : '<p class="text-muted">Aucun historique disponible pour ce spectacle.</p>');

    var closeBtn = document.getElementById("close-detail");
    if (closeBtn) closeBtn.addEventListener("click", function () { selectSpectacle(null); });

    if (s.history && s.history.length) {
      drawHistoryChart(s);
    }
  }

  function drawHistoryChart(s) {
    var canvas = document.getElementById("spectacle-history-chart");
    if (!canvas || typeof Chart === "undefined") return;
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    var theme = PDF.getChartTheme();
    var labels = s.history.map(function (h) { return PDF.formatDateFR(h.date); });
    var values = s.history.map(function (h) { return h.count; });

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

  function init() {
    PDF.createSearchBar(document.getElementById("search-slot"), {
      placeholder: "Rechercher un spectacle (ex: Vikings)…",
      onChange: function (value) {
        state.query = value;
        renderGrid();
      },
    });

    PDF.fetchJSON("spectacles.json")
      .then(function (data) {
        state.data = data;
        populateCategoryFilter();
        renderGrid();
      })
      .catch(function (err) {
        PDF.renderErrorMessage(
          document.getElementById("spectacles-grid"),
          "Impossible de charger la liste des spectacles (" + err.message + ")."
        );
      });

    window.addEventListener("pdf:themechange", function () {
      if (state.selectedSlug) {
        var s = findSpectacle(state.selectedSlug);
        if (s && s.history && s.history.length) drawHistoryChart(s);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
