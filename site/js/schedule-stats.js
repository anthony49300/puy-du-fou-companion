/* =========================================================================
   schedule-stats.js — pure analytics over a show's schedule history.

   Exposes PDF.scheduleStats (UMD-style: attaches to window.PDF in the
   browser, exports via module.exports under Node so tests can `require`
   it — same pattern as the other site/js/*.js modules). Every function
   here is pure: it takes already-parsed JSON (spectacle-history, the
   compact schedule-index, calendar.json) and returns plain data, with no
   DOM access and no fetch — see spectacles.js/programme.js/carnet.js for
   the rendering layer that consumes these results.

   Vocabulary used throughout:
   - "history": the `history` array from spectacle-history/{slug}.json,
     one entry per day `{date, count, starts, ranges}` (see
     src/statistics.py:compute_spectacle_stats) — already restricted to
     the dates valid for THIS spectacle (closed/out-of-season/private
     days excluded, ephemeral shows limited to their active_periods).
   - "days": a FILTERED subset of `history` (see filterDays) — the
     denominator for every share/frequency below is `days.length`, i.e.
     "how many days matched this filter", not "how many days the show
     played" (a day the show didn't play still counts against its own
     slots' shares, which is the point: a show on a 2-week break should
     show diluted shares for that period, not be silently excluded).
   ========================================================================= */
(function (global) {
  "use strict";

  /* ----------------------------------------------------------------------
   * Date helpers (local, UTC-safe — same approach as PDF.parseISODate)
   * -------------------------------------------------------------------- */
  function parseISO(dateStr) {
    const parts = String(dateStr).split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function toISO(date) {
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return date.getFullYear() + "-" + mm + "-" + dd;
  }

  function addDays(dateStr, delta) {
    const d = parseISO(dateStr);
    d.setDate(d.getDate() + delta);
    return toISO(d);
  }

  function daysBetween(aStr, bStr) {
    return Math.round((parseISO(bStr) - parseISO(aStr)) / 86400000);
  }

  // Lundi = 0 ... dimanche = 6 (même convention que PDF.renderMiniCalendar).
  function mondayFirstWeekday(dateStr) {
    return (parseISO(dateStr).getDay() + 6) % 7;
  }

  /* ----------------------------------------------------------------------
   * Day classification
   * -------------------------------------------------------------------- */
  // `calendar` = parsed calendar.json ({source, school_holidays, public_holidays})
  // or null/undefined (degrades gracefully: no day is ever a holiday — see
  // §5 of the feature spec, "calendar.json missing -> holiday filters hidden").
  function isWithinSchoolHoliday(dateStr, calendar) {
    const holidays = (calendar && calendar.school_holidays) || [];
    return holidays.some((h) => h.start <= dateStr && dateStr <= h.end);
  }

  function isPublicHoliday(dateStr, calendar) {
    const list = (calendar && calendar.public_holidays) || [];
    return list.indexOf(dateStr) !== -1;
  }

  function classifyDate(dateStr, calendar) {
    const weekday = mondayFirstWeekday(dateStr);
    const publicHoliday = isPublicHoliday(dateStr, calendar);
    const holiday = isWithinSchoolHoliday(dateStr, calendar);
    // Un jour férié se comporte comme un week-end côté fréquentation,
    // même un jour de semaine (voir §3 de la spec).
    const dayType = weekday >= 5 || publicHoliday ? "weekend" : "weekday";
    return {
      weekday,
      dayType,
      holiday,
      publicHoliday,
      month: parseISO(dateStr).getMonth() + 1,
    };
  }

  /* ----------------------------------------------------------------------
   * Filtering
   * -------------------------------------------------------------------- */
  // options.dayType: "all" | "weekday" | "weekend"
  // options.period: "all" | "holidays" | "school" ("hors vacances") | "month:N"
  function filterDays(history, calendar, options) {
    options = options || {};
    const dayType = options.dayType || "all";
    const period = options.period || "all";
    let monthFilter = null;
    if (typeof period === "string" && period.indexOf("month:") === 0) {
      monthFilter = parseInt(period.slice("month:".length), 10);
    }
    return (history || []).filter((entry) => {
      const info = classifyDate(entry.date, calendar);
      if (dayType !== "all" && info.dayType !== dayType) return false;
      if (period === "holidays" && !info.holiday) return false;
      if (period === "school" && info.holiday) return false;
      if (monthFilter != null && info.month !== monthFilter) return false;
      return true;
    });
  }

  /* ----------------------------------------------------------------------
   * Start-time / continuous-range frequencies
   * -------------------------------------------------------------------- */
  function _tokenFrequencies(days, pick) {
    const counts = {};
    days.forEach((d) => {
      const tokens = pick(d) || [];
      // Un jour peut lister 2x le même horaire par erreur de collecte : on
      // ne compte chaque horaire qu'une fois par jour (Set), le dénominateur
      // étant "jours comparables", pas "occurrences".
      new Set(tokens).forEach((t) => { counts[t] = (counts[t] || 0) + 1; });
    });
    const sample = days.length;
    const items = Object.keys(counts)
      .map((time) => {
        const n = counts[time];
        const share = sample ? n / sample : 0;
        return { time, days: n, share, fixed: share >= 0.9 };
      })
      .sort((a, b) => b.share - a.share || a.time.localeCompare(b.time));
    return { items, sample };
  }

  function startFrequencies(days) {
    return _tokenFrequencies(days, (d) => d.starts);
  }

  function rangeFrequencies(days) {
    return _tokenFrequencies(days, (d) => d.ranges);
  }

  /* ----------------------------------------------------------------------
   * Weekday x hour heatmap
   * -------------------------------------------------------------------- */
  function _startHour(start) {
    return parseInt(String(start).slice(0, 2), 10);
  }

  function weekdayHourHeatmap(days) {
    const byWeekday = [[], [], [], [], [], [], []]; // 0=lundi .. 6=dimanche
    days.forEach((d) => { byWeekday[mondayFirstWeekday(d.date)].push(d); });

    let minHour = null, maxHour = null;
    days.forEach((d) => {
      (d.starts || []).forEach((s) => {
        const h = _startHour(s);
        if (minHour == null || h < minHour) minHour = h;
        if (maxHour == null || h > maxHour) maxHour = h;
      });
    });
    if (minHour == null) return { hours: [], rows: [] };

    const hours = [];
    for (let h = minHour; h <= maxHour; h++) hours.push(h);

    const rows = byWeekday.map((weekdayDays, weekday) => {
      const total = weekdayDays.length;
      const cells = hours.map((h) => {
        const count = weekdayDays.filter((d) => (d.starts || []).some((s) => _startHour(s) === h)).length;
        return { hour: h, count, total, share: total ? count / total : 0 };
      });
      return { weekday, total, cells };
    });

    return { hours, rows };
  }

  /* ----------------------------------------------------------------------
   * Regularity
   * -------------------------------------------------------------------- */
  function _patternKey(d) {
    // Les accès continus entrent aussi dans le motif (un spectacle qui
    // alterne un créneau fixe et une plage continue selon les jours reste
    // "irrégulier" à juste titre).
    return (d.starts || []).slice().sort().concat((d.ranges || []).slice().sort()).join("|");
  }

  function regularity(days) {
    const present = days.filter((d) => (d.starts && d.starts.length) || (d.ranges && d.ranges.length));
    if (!present.length) {
      return { share: 0, label: "Peu de données", pattern: [], sample: 0 };
    }
    const counts = {};
    const latestDateByPattern = {};
    present.forEach((d) => {
      const key = _patternKey(d);
      counts[key] = (counts[key] || 0) + 1;
      if (!latestDateByPattern[key] || d.date > latestDateByPattern[key]) latestDateByPattern[key] = d.date;
    });
    let bestKey = null;
    Object.keys(counts).forEach((key) => {
      if (
        bestKey == null ||
        counts[key] > counts[bestKey] ||
        (counts[key] === counts[bestKey] && latestDateByPattern[key] > latestDateByPattern[bestKey])
      ) {
        bestKey = key;
      }
    });
    const share = counts[bestKey] / present.length;
    const label = share >= 0.7 ? "Horaires très stables" : share >= 0.4 ? "Horaires assez stables" : "Horaires variables";
    const pattern = bestKey ? bestKey.split("|").filter(Boolean) : [];
    return { share, label, pattern, sample: present.length };
  }

  /* ----------------------------------------------------------------------
   * Slot timeline (first/last seen + weekly presence, for a sparkline)
   * -------------------------------------------------------------------- */
  function slotTimeline(days) {
    const freq = startFrequencies(days);
    const sorted = days.slice().sort((a, b) => a.date.localeCompare(b.date));
    return freq.items
      .filter((item) => item.share >= 0.05)
      .map((item) => {
        const datesWithSlot = sorted.filter((d) => (d.starts || []).indexOf(item.time) !== -1).map((d) => d.date);
        // Semaine ISO-ish simplifiée : regroupe par lundi de la semaine du
        // jour (suffisant pour une mini-sparkline, pas un vrai numéro ISO).
        const weeks = {};
        sorted.forEach((d) => {
          const weekStart = addDays(d.date, -mondayFirstWeekday(d.date));
          if (!weeks[weekStart]) weeks[weekStart] = false;
          if ((d.starts || []).indexOf(item.time) !== -1) weeks[weekStart] = true;
        });
        const series = Object.keys(weeks).sort().map((weekStart) => ({ weekStart, present: weeks[weekStart] }));
        return {
          time: item.time,
          share: item.share,
          firstSeen: datesWithSlot[0] || null,
          lastSeen: datesWithSlot[datesWithSlot.length - 1] || null,
          series,
        };
      });
  }

  /* ----------------------------------------------------------------------
   * Unusual today
   * -------------------------------------------------------------------- */
  // `days` doit déjà être filtré par l'appelant sur le MÊME dayType
  // qu'aujourd'hui (voir filterDays) : cette fonction ne reclassifie rien.
  function unusualToday(todayStarts, days) {
    const freq = startFrequencies(days);
    const byTime = {};
    freq.items.forEach((item) => { byTime[item.time] = item; });
    const todaySet = new Set(todayStarts || []);

    const missing = freq.items.filter((item) => item.share >= 0.8 && !todaySet.has(item.time));
    const unexpected = (todayStarts || [])
      .filter((t) => !byTime[t] || byTime[t].share < 0.1)
      .map((t) => ({ time: t, share: byTime[t] ? byTime[t].share : 0 }));

    return { missing, unexpected };
  }

  /* ----------------------------------------------------------------------
   * Probable programme (schedule-index.json level, all shows at once)
   * -------------------------------------------------------------------- */
  function _indexDateBounds(index) {
    let min = null, max = null;
    function consider(d) {
      if (min == null || d < min) min = d;
      if (max == null || d > max) max = d;
    }
    (index.excluded_dates || []).forEach(consider);
    Object.keys(index.spectacles || {}).forEach((slug) => {
      Object.keys(index.spectacles[slug].days || {}).forEach(consider);
    });
    return { min, max };
  }

  function _candidateDates(targetDate, radius) {
    const dates = [];
    for (let delta = -radius; delta <= radius; delta++) {
      if (delta === 0) continue; // le jour cible lui-même n'est pas sa propre référence
      dates.push(addDays(targetDate, delta));
    }
    return dates;
  }

  function _allDatesInRange(startStr, endStr) {
    const dates = [];
    let d = startStr;
    // Boucle bornée par la taille réelle de l'index (une saison, quelques
    // centaines de jours) : pas de risque d'emballement.
    while (d <= endStr) {
      dates.push(d);
      d = addDays(d, 1);
    }
    return dates;
  }

  function _referenceDatesFromIndex(index, calendar, targetDate, targetInfo, radius) {
    const bounds = _indexDateBounds(index);
    return _candidateDates(targetDate, radius).filter((d) => {
      if (bounds.min != null && (d < bounds.min || d > bounds.max)) return false;
      if ((index.excluded_dates || []).indexOf(d) !== -1) return false;
      const info = classifyDate(d, calendar);
      return info.dayType === targetInfo.dayType && info.holiday === targetInfo.holiday;
    });
  }

  // Repli "saison précédente" : contrairement à _referenceDatesFromIndex,
  // ne part pas d'un décalage en jours depuis targetDate (qui tomberait
  // hors de la saison précédente, ~1 an plus tôt) — parcourt plutôt TOUTE
  // la plage de dates connue de cet autre index, filtrée par même
  // dayType/vacances que la date cible.
  function _referenceDatesFromPreviousSeason(previousIndex, calendar, targetInfo) {
    const bounds = _indexDateBounds(previousIndex);
    if (bounds.min == null) return [];
    return _allDatesInRange(bounds.min, bounds.max).filter((d) => {
      if ((previousIndex.excluded_dates || []).indexOf(d) !== -1) return false;
      const info = classifyDate(d, calendar);
      return info.dayType === targetInfo.dayType && info.holiday === targetInfo.holiday;
    });
  }

  // options.previousSeasonIndex : index de la saison précédente (même
  // forme), utilisé UNIQUEMENT si même après élargissement à ±45 jours
  // l'échantillon reste < 6 jours — la spec demande ce repli mais
  // probableProgramme() ne reçoit qu'un seul index "courant" ; le fournir
  // est optionnel, le résultat reste utilisable (juste moins fiable, voir
  // `basis.rule`) sans lui. Dans ce cas, c'est l'index PRÉCÉDENT qui sert
  // à la fois de source des dates de référence ET des présences par
  // spectacle (un décalage en jours depuis targetDate tomberait hors de
  // cette autre saison, ~1 an plus tôt — voir _referenceDatesFromPreviousSeason).
  function probableProgramme(index, calendar, targetDate, options) {
    options = options || {};
    if (!index || !index.spectacles) return null;
    if ((index.excluded_dates || []).indexOf(targetDate) !== -1) return null;

    const bounds = _indexDateBounds(index);
    if (bounds.min == null || targetDate < bounds.min || targetDate > bounds.max) return null;

    const targetInfo = classifyDate(targetDate, calendar);

    let referenceDates = _referenceDatesFromIndex(index, calendar, targetDate, targetInfo, 21);
    let rule = "±21 jours";
    let sourceIndex = index;
    if (referenceDates.length < 6) {
      referenceDates = _referenceDatesFromIndex(index, calendar, targetDate, targetInfo, 45);
      rule = "±45 jours";
    }
    if (referenceDates.length < 6 && options.previousSeasonIndex) {
      const prevDates = _referenceDatesFromPreviousSeason(options.previousSeasonIndex, calendar, targetInfo);
      if (prevDates.length > referenceDates.length) {
        referenceDates = prevDates;
        sourceIndex = options.previousSeasonIndex;
        rule = "saison précédente (même période calendaire)";
      }
    }

    // Un spectacle éphémère ne doit jamais être prédit loin de sa période
    // réelle : exige une présence proche de la date cible EN PLUS du seuil
    // de 50 % ci-dessous (utile surtout quand le rayon a dû être élargi à
    // ±45 jours dans la même saison). Pour le repli "saison précédente", ce
    // filtre n'a pas de sens en ces termes (±21 jours autour d'une date
    // d'une AUTRE année) — l'exclusion par active_periods déjà appliquée
    // côté Python lors de la construction de l'index (voir
    // src/exporter.py:export_schedule_index) reste alors la seule garde,
    // et suffit : un jour hors période n'apparaît tout simplement jamais
    // dans `entry.days`, quel que soit l'index source.
    const nearDates = sourceIndex === index
      ? _referenceDatesFromIndex(index, calendar, targetDate, targetInfo, 21)
      : null;

    const spectacles = [];
    Object.keys(sourceIndex.spectacles).forEach((slug) => {
      const entry = sourceIndex.spectacles[slug];
      const presentOn = referenceDates.filter((d) => entry.days[d]);
      if (!presentOn.length) return;
      if (presentOn.length / referenceDates.length < 0.5) return;
      if (nearDates && !nearDates.some((d) => entry.days[d])) return; // respecte les périodes éphémères

      const patternCounts = {};
      const latestByPattern = {};
      presentOn.forEach((d) => {
        const key = entry.days[d];
        patternCounts[key] = (patternCounts[key] || 0) + 1;
        if (!latestByPattern[key] || d > latestByPattern[key]) latestByPattern[key] = d;
      });
      let bestKey = null;
      Object.keys(patternCounts).forEach((key) => {
        if (
          bestKey == null ||
          patternCounts[key] > patternCounts[bestKey] ||
          (patternCounts[key] === patternCounts[bestKey] && latestByPattern[key] > latestByPattern[bestKey])
        ) {
          bestKey = key;
        }
      });
      const confidence = patternCounts[bestKey] / presentOn.length;

      const tokens = bestKey.split(",");
      const starts = tokens.filter((t) => t.indexOf("-") === -1).sort();
      const ranges = tokens.filter((t) => t.indexOf("-") !== -1).sort();

      const startShares = {};
      starts.forEach((s) => {
        const withThisStart = presentOn.filter((d) => entry.days[d].split(",").indexOf(s) !== -1).length;
        startShares[s] = withThisStart / presentOn.length;
      });

      spectacles.push({
        slug,
        name: entry.name,
        category: entry.category,
        starts,
        ranges,
        confidence,
        startShares,
        durations: entry.durations || {},
      });
    });

    spectacles.sort((a, b) => {
      const aTime = a.starts[0] || (a.ranges[0] || "").split("-")[0] || "";
      const bTime = b.starts[0] || (b.ranges[0] || "").split("-")[0] || "";
      return aTime.localeCompare(bTime);
    });

    return {
      date: targetDate,
      basis: { rule, referenceDays: referenceDates.length },
      spectacles,
    };
  }

  const scheduleStats = {
    classifyDate,
    filterDays,
    startFrequencies,
    rangeFrequencies,
    weekdayHourHeatmap,
    regularity,
    slotTimeline,
    unusualToday,
    probableProgramme,
  };

  global.PDF = global.PDF || {};
  global.PDF.scheduleStats = scheduleStats;

  // Exposé pour les tests (tests/frontend/) — no-op dans un navigateur.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = scheduleStats;
  }
})(typeof window !== "undefined" ? window : global);
