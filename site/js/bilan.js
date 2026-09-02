/* =========================================================================
   bilan.js — logique de la page "Bilan de saison"
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  var state = { years: [], recaps: {}, selectedYear: null };

  function tile(label, value, sub) {
    return (
      '<div class="stat-tile"><div class="stat-label">' + PDF.escapeHtml(label) + "</div>" +
      '<div class="stat-value">' + (value == null ? "—" : PDF.escapeHtml(String(value))) + "</div>" +
      (sub ? '<div class="stat-sub">' + PDF.escapeHtml(sub) + "</div>" : "") +
      "</div>"
    );
  }

  function renderBars(entries) {
    var max = entries.reduce(function (m, e) { return Math.max(m, e.count); }, 0) || 1;
    return '<div class="bars">' + entries.map(function (e) {
      var w = e.count === 0 ? 0 : (e.count / max * 100);
      return (
        '<div class="bar"><div class="bar-label">' + PDF.escapeHtml(e.name) + "</div>" +
        '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>' +
        '<div class="bar-count">' + e.count + "</div></div>"
      );
    }).join("") + "</div>";
  }

  function renderRecap(recap) {
    var catEntries = Object.keys(recap.representations_by_category || {})
      .map(function (k) { return { name: PDF.categoryLabel(k), count: recap.representations_by_category[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
    var topEntries = (recap.most_represented || []).map(function (s) { return { name: s.name, count: s.count }; });
    var bottomEntries = (recap.least_represented || []).map(function (s) { return { name: s.name, count: s.count }; });

    var banner = recap.final
      ? '<div class="status-banner status-ok"><span aria-hidden="true">✅</span><span>Bilan final de la saison.</span></div>'
      : '<div class="status-banner status-stale"><span aria-hidden="true">🚧</span><span>Données provisoires au ' +
        PDF.formatDateFR(recap.as_of_date) + " — la saison est encore en cours, mise à jour environ une fois par mois." +
        "</span></div>";

    document.getElementById("bilan-content").innerHTML =
      "<h2>" + PDF.escapeHtml(recap.season_name || ("Saison " + recap.year)) + "</h2>" +
      '<p class="text-muted">' + PDF.formatDateFR(recap.start_date) + " → " + PDF.formatDateFR(recap.end_date) + "</p>" +
      banner +
      '<div class="stat-grid">' +
      tile("Spectacles distincts", recap.total_spectacles) +
      tile("Représentations totales", recap.total_representations) +
      tile("Jours collectés", recap.days_collected) +
      tile("Moyenne / jour", recap.avg_per_day) +
      tile("Jour le plus chargé", recap.max_per_day ? recap.max_per_day.count : null, recap.max_per_day ? PDF.formatDateFR(recap.max_per_day.date) : "") +
      tile("Jour le plus calme", recap.min_per_day ? recap.min_per_day.count : null, recap.min_per_day ? PDF.formatDateFR(recap.min_per_day.date) : "") +
      tile("Représentations en continu", recap.continuous_count) +
      tile("Représentations nocturnes", recap.nocturnal_count) +
      "</div>" +
      '<div class="charts-grid" style="margin-top:1.25rem">' +
      '<div class="card chart-card"><h3>Répartition par catégorie</h3>' + renderBars(catEntries) + "</div>" +
      '<div class="card chart-card"><h3>Les plus programmés</h3>' + renderBars(topEntries) + "</div>" +
      '<div class="card chart-card"><h3>Les moins programmés</h3>' + renderBars(bottomEntries) + "</div>" +
      "</div>";
  }

  function renderYearSelect() {
    var wrap = document.getElementById("bilan-year-select");
    if (state.years.length <= 1) { wrap.hidden = true; return; }
    wrap.hidden = false;
    wrap.innerHTML = state.years.map(function (y) {
      return '<button type="button" class="chip' + (y === state.selectedYear ? " active" : "") + '" data-year="' + y + '">' + y + "</button>";
    }).join("");
    wrap.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.selectedYear = +btn.getAttribute("data-year");
        renderYearSelect();
        renderRecap(state.recaps[state.selectedYear]);
      });
    });
  }

  function renderUnavailable(seasonInfo) {
    var msg = seasonInfo && seasonInfo.end_date
      ? "Aucun bilan disponible pour le moment : la saison en cours (" + PDF.escapeHtml(seasonInfo.name || "") +
        ") se termine le " + PDF.formatDateFR(seasonInfo.end_date) + ". Le bilan sera généré automatiquement à cette date."
      : "Aucun bilan de saison disponible pour le moment.";
    document.getElementById("bilan-content").innerHTML =
      '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🏆</div><p>' + msg + "</p></div>";
  }

  function init() {
    Promise.all([PDF.fetchJSON("dates.json"), PDF.fetchJSON("today.json").catch(function () { return null; })])
      .then(function (results) {
        var dates = results[0], today = results[1];
        var years = Array.from(new Set((dates.dates || []).map(function (d) { return d.season_year; }).filter(Boolean)))
          .sort(function (a, b) { return b - a; });

        return Promise.all(
          years.map(function (y) {
            return PDF.fetchJSON("history/" + y + "/recap.json")
              .then(function (recap) { return { year: y, recap: recap }; })
              .catch(function () { return null; });
          })
        ).then(function (results2) {
          results2.filter(Boolean).forEach(function (r) {
            state.years.push(r.year);
            state.recaps[r.year] = r.recap;
          });
          if (!state.years.length) {
            renderUnavailable(today ? today.season : null);
            return;
          }
          state.selectedYear = state.years[0];
          renderYearSelect();
          renderRecap(state.recaps[state.selectedYear]);
        });
      })
      .catch(function (err) {
        PDF.renderErrorMessage(
          document.getElementById("bilan-error-slot"),
          "Impossible de charger le bilan de saison (" + err.message + ")."
        );
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
