/* =========================================================================
   historique.js — logique de la page "Historique"
   Calendrier mensuel (CSS/JS pur) + détail d'une date + comparaison de
   deux dates. Les dates passées sont chargées depuis
   ../data/json/history/{année}/{date}.json quand ce fichier existe, avec
   repli sur le résumé de dates.json sinon.
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  var state = {
    dateMap: {}, // "2026-08-25" -> record from dates.json
    sortedDates: [], // ascending
    viewYear: null,
    viewMonth: null, // 0-11
    selectedDate: null,
    compare: {
      a: { year: null, month: null, date: null },
      b: { year: null, month: null, date: null },
    },
  };

  /* ---------------- Calendrier (composant réutilisable dans app.js) ---------------- */

  // Classes/titre d'une case de calendrier à partir de son enregistrement
  // dates.json (ou undefined si la date n'a jamais été collectée). Propre à
  // cette page : ici, un jour sans donnée reste grisé et non cliquable.
  function dayCellInfo(record, isSelected, dateStr) {
    var hasData = !!record;
    var isClosed = hasData && (record.status === "closed_day" || record.status === "out_of_season");
    var cls = "cal-day" + (hasData ? " has-data" : "") + (isClosed ? " is-closed" : "") + (isSelected ? " is-selected" : "");
    var title = !hasData ? "Aucune donnée" : isClosed ? "Parc fermé le " + PDF.formatDateFR(dateStr) : PDF.formatDateFR(dateStr);
    return { cls: cls, disabled: !hasData, title: title };
  }

  function renderCalendar() {
    PDF.renderMiniCalendar(
      "calendar-wrap", state.viewYear, state.viewMonth, state.dateMap, state.selectedDate,
      dayCellInfo, selectDate, changeMonth
    );
  }

  function changeMonth(delta) {
    var newMonth = state.viewMonth + delta;
    var newYear = state.viewYear;
    if (newMonth < 0) { newMonth = 11; newYear -= 1; }
    if (newMonth > 11) { newMonth = 0; newYear += 1; }
    state.viewMonth = newMonth;
    state.viewYear = newYear;
    renderCalendar();
  }

  /* ---------------- Détail d'une date ---------------- */

  function buildSlotsFromToday(today) {
    var slots = [];
    (today.spectacles || []).forEach(function (spectacle) {
      (spectacle.representations || []).forEach(function (rep) {
        slots.push({ spectacle: spectacle, rep: rep });
      });
    });
    slots.sort(function (a, b) {
      if (a.rep.is_continuous && b.rep.is_continuous) return 0;
      if (a.rep.is_continuous) return -1;
      if (b.rep.is_continuous) return 1;
      return (a.rep.start || "").localeCompare(b.rep.start || "");
    });
    return slots;
  }

  function renderTimelineHtml(dayData) {
    var slots = buildSlotsFromToday(dayData);
    if (!slots.length) return '<p class="text-muted">Aucune représentation enregistrée pour cette date.</p>';
    return (
      '<div class="timeline">' +
      slots.map(function (slot) {
        var rep = slot.rep, spectacle = slot.spectacle;
        var timeLabel = rep.is_continuous
          ? "En continu" + (rep.end ? " " + PDF.formatTimeFR(rep.start) + "–" + PDF.formatTimeFR(rep.end) : "")
          : PDF.formatTimeFR(rep.start);
        var cls = "rep-card" +
          (spectacle.category === "spectacle_nocturne" || PDF.isLateHour(rep.start) ? " is-nocturne" : "");
        return (
          '<div class="' + cls + '">' +
          '<div class="rep-time">' + PDF.escapeHtml(timeLabel) + "</div>" +
          '<div class="rep-name">' + PDF.escapeHtml(spectacle.name) + "</div>" +
          '<div class="rep-badges">' + PDF.representationBadges(rep, spectacle.category) + "</div>" +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function renderSummaryFallback(dateStr, record, extraMsg) {
    var panel = document.getElementById("day-detail");
    panel.innerHTML =
      "<h3>" + PDF.formatDateLongFR(dateStr) + "</h3>" +
      '<div class="status-banner status-stale"><span aria-hidden="true">ℹ️</span><span>' +
      PDF.escapeHtml(extraMsg || "Détail non disponible pour cette date dans l'export JSON, seule la vue résumée (dates.json) est affichée.") +
      "</span></div>" +
      '<div class="stat-grid">' +
      '<div class="stat-tile"><div class="stat-label">Spectacles</div><div class="stat-value">' + (record.spectacle_count != null ? record.spectacle_count : "—") + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Représentations</div><div class="stat-value">' + (record.representation_count != null ? record.representation_count : "—") + "</div></div>" +
      '<div class="stat-tile"><div class="stat-label">Statut de collecte</div><div class="stat-value" style="font-size:1rem;">' + PDF.escapeHtml(record.status || "—") + "</div></div>" +
      "</div>";
  }

  function selectDate(dateStr) {
    state.selectedDate = dateStr;
    renderCalendar();
    var panel = document.getElementById("day-detail");
    panel.innerHTML = '<div class="empty-state"><div class="skeleton" style="height:2rem;"></div><p class="text-muted">Chargement du programme du ' + PDF.formatDateFR(dateStr) + "…</p></div>";

    var seasonYear = (state.dateMap[dateStr] || {}).season_year;
    PDF.fetchJSON(PDF.historyJsonPath(dateStr, seasonYear))
      .then(function (dayData) {
        panel.innerHTML =
          "<h3>" + PDF.formatDateLongFR(dateStr) + "</h3>" +
          PDF.statusBannerHtml(dayData.status, dayData.date, (dayData.representation_count || 0) > 0) +
          '<div class="stat-grid">' +
          '<div class="stat-tile"><div class="stat-label">Spectacles</div><div class="stat-value">' + (dayData.spectacle_count != null ? dayData.spectacle_count : "—") + "</div></div>" +
          '<div class="stat-tile"><div class="stat-label">Représentations</div><div class="stat-value">' + (dayData.representation_count != null ? dayData.representation_count : "—") + "</div></div>" +
          "</div>" +
          renderTimelineHtml(dayData);
      })
      .catch(function (err) {
        var record = state.dateMap[dateStr] || {};
        if (err.notFound) {
          renderSummaryFallback(dateStr, record);
        } else {
          renderSummaryFallback(
            dateStr,
            record,
            "Erreur lors du chargement du détail (" + err.message + "). Affichage du résumé disponible."
          );
        }
      });
  }

  /* ---------------- Comparaison de deux dates ---------------- */

  function renderCompareCalendar(which) {
    var c = state.compare[which];
    PDF.renderMiniCalendar(
      "compare-cal-" + which, c.year, c.month, state.dateMap, c.date, dayCellInfo,
      function (dateStr) { pickCompareDate(which, dateStr); },
      function (delta) { changeCompareMonth(which, delta); }
    );
  }

  function changeCompareMonth(which, delta) {
    var c = state.compare[which];
    var m = c.month + delta, y = c.year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    c.month = m;
    c.year = y;
    renderCompareCalendar(which);
  }

  function pickCompareDate(which, dateStr) {
    state.compare[which].date = dateStr;
    renderCompareCalendar(which);
    document.getElementById("compare-" + which + "-label").textContent = PDF.formatDateFR(dateStr);
    document.getElementById("compare-btn").disabled = !(state.compare.a.date && state.compare.b.date);
  }

  function fetchDayOrNull(dateStr) {
    var seasonYear = (state.dateMap[dateStr] || {}).season_year;
    return PDF.fetchJSON(PDF.historyJsonPath(dateStr, seasonYear)).catch(function () { return null; });
  }

  function spectacleNameSet(dayData) {
    var names = {};
    (dayData.spectacles || []).forEach(function (s) { names[s.name] = s; });
    return names;
  }

  function formatSpectacleTimes(spectacle) {
    return (spectacle.representations || [])
      .slice()
      .sort(function (a, b) {
        if (a.is_continuous && b.is_continuous) return 0;
        if (a.is_continuous) return -1;
        if (b.is_continuous) return 1;
        return (a.start || "").localeCompare(b.start || "");
      })
      .map(function (r) {
        return r.is_continuous
          ? "En continu" + (r.end ? " " + PDF.formatTimeFR(r.start) + "–" + PDF.formatTimeFR(r.end) : "")
          : PDF.formatTimeFR(r.start);
      })
      .join(", ");
  }

  function renderCompareColumn(dateStr, dayData, record) {
    if (!dayData) {
      return (
        '<div class="compare-col"><h4>' + PDF.formatDateFR(dateStr) + "</h4>" +
        '<div class="status-banner status-stale"><span aria-hidden="true">ℹ️</span><span>Détail indisponible — résumé uniquement.</span></div>' +
        "<p>Spectacles : <strong>" + (record.spectacle_count != null ? record.spectacle_count : "—") + "</strong></p>" +
        "<p>Représentations : <strong>" + (record.representation_count != null ? record.representation_count : "—") + "</strong></p>" +
        "</div>"
      );
    }
    return (
      '<div class="compare-col"><h4>' + PDF.formatDateLongFR(dateStr) + "</h4>" +
      "<p>Spectacles : <strong>" + dayData.spectacle_count + "</strong> — Représentations : <strong>" + dayData.representation_count + "</strong></p>" +
      "</div>"
    );
  }

  function runCompare() {
    var dateA = state.compare.a.date;
    var dateB = state.compare.b.date;
    var resultEl = document.getElementById("compare-result");

    if (!dateA || !dateB) {
      resultEl.innerHTML = '<p class="text-muted">Choisissez deux dates à comparer.</p>';
      return;
    }
    if (dateA === dateB) {
      resultEl.innerHTML = '<p class="text-muted">Choisissez deux dates différentes.</p>';
      return;
    }

    resultEl.innerHTML = '<div class="empty-state"><div class="skeleton" style="height:2rem;"></div><p class="text-muted">Comparaison en cours…</p></div>';

    Promise.all([fetchDayOrNull(dateA), fetchDayOrNull(dateB)]).then(function (results) {
      var dayA = results[0], dayB = results[1];
      var recA = state.dateMap[dateA] || {};
      var recB = state.dateMap[dateB] || {};

      var html = '<div class="compare-grid">' +
        renderCompareColumn(dateA, dayA, recA) +
        renderCompareColumn(dateB, dayB, recB) +
        "</div>";

      if (dayA && dayB) {
        var namesA = spectacleNameSet(dayA);
        var namesB = spectacleNameSet(dayB);
        var onlyInA = Object.keys(namesA).filter(function (n) { return !namesB[n]; });
        var onlyInB = Object.keys(namesB).filter(function (n) { return !namesA[n]; });
        html +=
          '<div class="card" style="margin-top:1rem;"><h4>Différences</h4>' +
          "<p>Spectacles présents le " + PDF.formatDateFR(dateA) + " mais absents le " + PDF.formatDateFR(dateB) + " :</p>" +
          '<ul class="diff-list">' + (onlyInA.length ? onlyInA.map(function (n) { return "<li>➕ " + PDF.escapeHtml(n) + "</li>"; }).join("") : '<li class="text-muted">Aucun</li>') + "</ul>" +
          "<p>Spectacles présents le " + PDF.formatDateFR(dateB) + " mais absents le " + PDF.formatDateFR(dateA) + " :</p>" +
          '<ul class="diff-list">' + (onlyInB.length ? onlyInB.map(function (n) { return "<li>➕ " + PDF.escapeHtml(n) + "</li>"; }).join("") : '<li class="text-muted">Aucun</li>') + "</ul>" +
          "</div>";

        var commonNames = Object.keys(namesA).filter(function (n) { return namesB[n]; }).sort();
        var rows = commonNames.map(function (n) {
          var timesA = formatSpectacleTimes(namesA[n]);
          var timesB = formatSpectacleTimes(namesB[n]);
          var cls = timesA !== timesB ? ' class="is-changed"' : "";
          return (
            "<tr" + cls + "><td>" + PDF.escapeHtml(n) + "</td>" +
            "<td>" + PDF.escapeHtml(timesA || "—") + "</td>" +
            "<td>" + PDF.escapeHtml(timesB || "—") + "</td></tr>"
          );
        }).join("");

        html +=
          '<div class="card" style="margin-top:1rem;"><h4>Horaires des spectacles communs</h4>' +
          '<p class="text-muted">Les lignes surlignées ont un horaire différent entre les deux dates.</p>' +
          '<div class="table-wrap"><table class="data-table"><thead><tr><th>Spectacle</th><th>' +
          PDF.formatDateFR(dateA) + "</th><th>" + PDF.formatDateFR(dateB) + "</th></tr></thead><tbody>" +
          (rows || '<tr><td colspan="3" class="text-muted">Aucun spectacle commun aux deux dates.</td></tr>') +
          "</tbody></table></div></div>";
      } else {
        html +=
          '<div class="status-banner status-stale" style="margin-top:1rem;"><span aria-hidden="true">⚠️</span>' +
          "<span>Comparaison détaillée (spectacles présents/absents, horaires) limitée : le détail JSON n'est disponible que pour certaines dates. Seuls les chiffres résumés (dates.json) sont fiables pour les dates sans export détaillé.</span></div>";
      }

      resultEl.innerHTML = html;
    });
  }

  /* ---------------- Init ---------------- */

  function init() {
    PDF.fetchJSON("dates.json")
      .then(function (data) {
        var map = {};
        (data.dates || []).forEach(function (rec) { map[rec.date] = rec; });
        state.dateMap = map;
        state.sortedDates = Object.keys(map).sort();

        var latest = state.sortedDates[state.sortedDates.length - 1];
        var refDate = latest ? PDF.parseISODate(latest) : new Date();
        state.viewYear = refDate.getFullYear();
        state.viewMonth = refDate.getMonth();

        renderCalendar();

        state.compare.a.year = state.compare.b.year = refDate.getFullYear();
        state.compare.a.month = state.compare.b.month = refDate.getMonth();
        renderCompareCalendar("a");
        renderCompareCalendar("b");

        document.getElementById("compare-btn").addEventListener("click", runCompare);
      })
      .catch(function (err) {
        PDF.renderErrorMessage(
          document.getElementById("calendar-wrap"),
          "Impossible de charger la liste des dates disponibles (" + err.message + ")."
        );
        PDF.renderErrorMessage(
          document.getElementById("dates-error-slot"),
          "Le calendrier et la comparaison de dates sont indisponibles tant que dates.json ne peut pas être chargé."
        );
      });
  }

  document.addEventListener("DOMContentLoaded", init);

  // Exposé pour les tests (tests/frontend/) — no-op dans un navigateur.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { dayCellInfo: dayCellInfo };
  }
})();
