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
  };

  function timeToMinutes(t) {
    if (!t) return 99999; // "en continu" ou sans heure -> en fin de liste
    var m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return 99999;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  // Construit une liste plate de "créneaux" { time, spectacle, rep }
  function buildSlots(today) {
    var slots = [];
    (today.spectacles || []).forEach(function (spectacle) {
      (spectacle.representations || []).forEach(function (rep) {
        slots.push({
          spectacle: spectacle,
          rep: rep,
          sortKey: rep.is_continuous ? -1 : timeToMinutes(rep.start),
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

  function renderSlot(slot) {
    var rep = slot.rep;
    var spectacle = slot.spectacle;
    var timeLabel = rep.is_continuous
      ? (rep.end ? "En continu " + PDF.formatTimeFR(rep.start) + "–" + PDF.formatTimeFR(rep.end) : "En continu")
      : PDF.formatTimeFR(rep.start);
    var classes = "rep-card";
    if (spectacle.category === "spectacle_nocturne" || PDF.isLateHour(rep.start)) classes += " is-nocturne";

    return (
      '<div class="' + classes + '">' +
      '<div class="rep-time">' + PDF.escapeHtml(timeLabel) + "</div>" +
      '<div class="rep-name">' + PDF.escapeHtml(spectacle.name) + "</div>" +
      '<div class="rep-badges">' +
      PDF.representationBadges(rep, spectacle.category) +
      "</div>" +
      "</div>"
    );
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
      return;
    }
    if (slots.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🔍</div>' +
        "<p>Aucune représentation ne correspond à votre recherche.</p></div>";
      return;
    }

    // Groupement par heure ("HH:00" à minima ; on garde le libellé exact HH:MM)
    var html = '<div class="timeline">';
    var lastGroupLabel = null;
    var continuousSlots = slots.filter(function (s) { return s.rep.is_continuous; });
    var timedSlots = slots.filter(function (s) { return !s.rep.is_continuous; });

    if (continuousSlots.length) {
      html += '<div class="timeline-hour-group">';
      html += '<div class="timeline-hour-label">En continu</div>';
      continuousSlots.forEach(function (s) { html += renderSlot(s); });
      html += "</div>";
    }

    timedSlots.forEach(function (slot) {
      var groupLabel = slot.rep.start ? PDF.formatTimeFR(slot.rep.start).replace(/h\d+$/, "h00") : "Horaire inconnu";
      if (groupLabel !== lastGroupLabel) {
        if (lastGroupLabel !== null) html += "</div>";
        html += '<div class="timeline-hour-group"><div class="timeline-hour-label">' + PDF.escapeHtml(groupLabel) + "</div>";
        lastGroupLabel = groupLabel;
      }
      html += renderSlot(slot);
    });
    if (lastGroupLabel !== null) html += "</div>";
    html += "</div>";

    container.innerHTML = html;
  }

  function populateCategoryFilter(today) {
    var select = document.getElementById("category-filter");
    var categories = {};
    (today.spectacles || []).forEach(function (s) {
      categories[s.category] = true;
    });
    Object.keys(categories).sort().forEach(function (cat) {
      var opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = PDF.categoryLabel(cat);
      select.appendChild(opt);
    });
    select.addEventListener("change", function () {
      state.category = select.value;
      renderProgramme();
    });
  }

  function init() {
    PDF.createSearchBar(document.getElementById("search-slot"), {
      placeholder: "Rechercher un spectacle (ex: Vikings)…",
      onChange: function (value) {
        state.query = value;
        renderProgramme();
      },
    });

    PDF.fetchJSON("today.json")
      .then(function (today) {
        state.today = today;
        document.getElementById("programme-date").textContent =
          "Programme du " + PDF.formatDateLongFR(today.date) +
          " — " + (today.spectacle_count != null ? today.spectacle_count : "?") + " spectacles, " +
          (today.representation_count != null ? today.representation_count : "?") + " représentations.";
        document.getElementById("status-banner-slot").innerHTML =
          PDF.seasonClosedBannerHtml(today) ||
          PDF.statusBannerHtml(today.status, today.date, (today.representation_count || 0) > 0, true);
        populateCategoryFilter(today);
        renderProgramme();
      })
      .catch(function (err) {
        document.getElementById("programme-date").textContent = "";
        PDF.renderErrorMessage(
          document.getElementById("programme-content"),
          "Impossible de charger le programme du jour (" + err.message + "). Vérifiez votre connexion ou réessayez plus tard."
        );
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
