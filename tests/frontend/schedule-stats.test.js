const test = require("node:test");
const assert = require("node:assert");
const scheduleStats = require("../../site/js/schedule-stats.js");

function day(date, starts, ranges) {
  return { date, count: (starts || []).length + (ranges || []).length, starts: starts || [], ranges: ranges || [] };
}

/* ----------------------------------------------------------------------
 * classifyDate
 * -------------------------------------------------------------------- */
test("classifyDate: a plain weekday with no calendar", () => {
  // 2026-07-21 est un mardi (vérifié via datetime.date.weekday() en Python).
  const info = scheduleStats.classifyDate("2026-07-21", null);
  assert.strictEqual(info.weekday, 1); // lundi=0 -> mardi=1
  assert.strictEqual(info.dayType, "weekday");
  assert.strictEqual(info.holiday, false);
  assert.strictEqual(info.publicHoliday, false);
  assert.strictEqual(info.month, 7);
});

test("classifyDate: Saturday/Sunday are dayType 'weekend'", () => {
  assert.strictEqual(scheduleStats.classifyDate("2026-07-25", null).dayType, "weekend"); // samedi
  assert.strictEqual(scheduleStats.classifyDate("2026-07-26", null).dayType, "weekend"); // dimanche
});

test("classifyDate: a public holiday on a weekday still counts as 'weekend'", () => {
  const calendar = { school_holidays: [], public_holidays: ["2026-07-14"] }; // mardi
  const info = scheduleStats.classifyDate("2026-07-14", calendar);
  assert.strictEqual(info.weekday, 1);
  assert.strictEqual(info.publicHoliday, true);
  assert.strictEqual(info.dayType, "weekend");
});

test("classifyDate: a date within school_holidays is flagged 'holiday'", () => {
  const calendar = { school_holidays: [{ name: "Été", start: "2026-07-20", end: "2026-08-02" }], public_holidays: [] };
  assert.strictEqual(scheduleStats.classifyDate("2026-07-21", calendar).holiday, true);
  assert.strictEqual(scheduleStats.classifyDate("2026-07-19", calendar).holiday, false);
});

/* ----------------------------------------------------------------------
 * filterDays
 * -------------------------------------------------------------------- */
test("filterDays: dayType filters weekday vs weekend", () => {
  const history = [day("2026-07-20"), day("2026-07-25"), day("2026-07-26")]; // lun, sam, dim
  assert.strictEqual(scheduleStats.filterDays(history, null, { dayType: "weekday" }).length, 1);
  assert.strictEqual(scheduleStats.filterDays(history, null, { dayType: "weekend" }).length, 2);
  assert.strictEqual(scheduleStats.filterDays(history, null, {}).length, 3);
});

test("filterDays: period 'holidays' vs 'school' (hors vacances)", () => {
  const calendar = { school_holidays: [{ name: "Été", start: "2026-07-20", end: "2026-08-02" }], public_holidays: [] };
  const history = [day("2026-07-10"), day("2026-07-22")];
  assert.deepStrictEqual(scheduleStats.filterDays(history, calendar, { period: "holidays" }).map((d) => d.date), ["2026-07-22"]);
  assert.deepStrictEqual(scheduleStats.filterDays(history, calendar, { period: "school" }).map((d) => d.date), ["2026-07-10"]);
});

test("filterDays: period 'month:N' keeps only that calendar month", () => {
  const history = [day("2026-07-10"), day("2026-08-10")];
  assert.deepStrictEqual(scheduleStats.filterDays(history, null, { period: "month:7" }).map((d) => d.date), ["2026-07-10"]);
});

/* ----------------------------------------------------------------------
 * startFrequencies / rangeFrequencies
 * -------------------------------------------------------------------- */
test("startFrequencies: computes share, sorts desc, flags 'fixed' at >= 90%", () => {
  const days = [
    day("2026-07-01", ["16:15", "11:30"]),
    day("2026-07-02", ["16:15"]),
    day("2026-07-03", ["16:15"]),
    day("2026-07-04", ["16:15"]),
    day("2026-07-05", []), // jour sans séance (absent)
  ];
  const { items, sample } = scheduleStats.startFrequencies(days);
  assert.strictEqual(sample, 5);
  assert.strictEqual(items[0].time, "16:15");
  assert.strictEqual(items[0].days, 4);
  assert.strictEqual(items[0].share, 0.8);
  assert.strictEqual(items[0].fixed, false); // < 0.90
  const slot1130 = items.find((i) => i.time === "11:30");
  assert.strictEqual(slot1130.share, 0.2);
});

test("startFrequencies: 'Peu de données' territory is just a small sample, not a crash", () => {
  const { items, sample } = scheduleStats.startFrequencies([day("2026-07-01", ["11:30"])]);
  assert.strictEqual(sample, 1);
  assert.strictEqual(items[0].share, 1);
  assert.strictEqual(items[0].fixed, true);
});

test("rangeFrequencies: same mechanics, applied to continuous-access ranges", () => {
  const days = [
    day("2026-07-01", [], ["12:00-20:45"]),
    day("2026-07-02", [], ["12:00-20:45"]),
    day("2026-07-03", [], ["09:00-18:00"]),
  ];
  const { items, sample } = scheduleStats.rangeFrequencies(days);
  assert.strictEqual(sample, 3);
  assert.strictEqual(items[0].time, "12:00-20:45");
  assert.strictEqual(items[0].days, 2);
});

/* ----------------------------------------------------------------------
 * weekdayHourHeatmap
 * -------------------------------------------------------------------- */
test("weekdayHourHeatmap: builds hour columns from min to max start hour, per weekday", () => {
  const days = [
    day("2026-07-20", ["11:30"]), // lundi
    day("2026-07-27", ["16:15"]), // un autre lundi, 16h
    day("2026-07-21", ["11:30"]), // mardi
  ];
  const heatmap = scheduleStats.weekdayHourHeatmap(days);
  assert.deepStrictEqual(heatmap.hours, [11, 12, 13, 14, 15, 16]);
  const monday = heatmap.rows[0];
  assert.strictEqual(monday.total, 2);
  const hour11 = monday.cells.find((c) => c.hour === 11);
  assert.strictEqual(hour11.count, 1);
  assert.strictEqual(hour11.share, 0.5);
});

test("weekdayHourHeatmap: empty history yields empty hours/rows, not a crash", () => {
  assert.deepStrictEqual(scheduleStats.weekdayHourHeatmap([]), { hours: [], rows: [] });
});

/* ----------------------------------------------------------------------
 * slotTimeline
 * -------------------------------------------------------------------- */
test("slotTimeline: reports first/last seen and excludes rare slots (< 5%)", () => {
  const days = [
    day("2026-07-01", ["11:30"]),
    day("2026-07-08", ["11:30"]),
    day("2026-07-15", ["11:30"]),
    day("2026-07-22", ["11:30"]),
    day("2026-07-29", ["11:30"]),
    day("2026-08-05", ["11:30"]),
    day("2026-08-12", ["11:30"]),
    day("2026-08-19", ["11:30"]),
    day("2026-08-26", ["11:30"]),
    day("2026-09-02", ["11:30"]),
    day("2026-09-09", ["11:30"]),
    day("2026-09-16", ["11:30"]),
    day("2026-09-23", ["11:30"]),
    day("2026-09-30", ["11:30"]),
    day("2026-10-07", ["11:30"]),
    day("2026-10-14", ["11:30"]),
    day("2026-10-21", ["11:30"]),
    day("2026-10-28", ["11:30"]),
    day("2026-11-04", ["11:30"]),
    day("2026-11-11", ["11:30"]),
    day("2026-11-10", ["20:00"]), // unique séance ailleurs -> en dessous de 5%
  ];
  const timeline = scheduleStats.slotTimeline(days);
  const slot1130 = timeline.find((t) => t.time === "11:30");
  assert.strictEqual(slot1130.firstSeen, "2026-07-01");
  assert.strictEqual(slot1130.lastSeen, "2026-11-11");
  assert.ok(!timeline.some((t) => t.time === "20:00"), "un créneau à moins de 5% ne doit pas apparaître");
});

/* ----------------------------------------------------------------------
 * unusualToday
 * -------------------------------------------------------------------- */
test("unusualToday: flags a usually-present slot missing today, and an unusual slot present today", () => {
  // 10 jours à 16:15 (90.9%) + 1 jour isolé à 09:00 (9.1%, < 10%) sur 11 jours.
  const days = [
    day("2026-07-01", ["16:15"]), day("2026-07-02", ["16:15"]), day("2026-07-03", ["16:15"]),
    day("2026-07-04", ["16:15"]), day("2026-07-05", ["16:15"]), day("2026-07-08", ["16:15"]),
    day("2026-07-09", ["16:15"]), day("2026-07-10", ["16:15"]), day("2026-07-11", ["16:15"]),
    day("2026-07-12", ["16:15"]), day("2026-07-06", ["09:00"]),
  ];
  const result = scheduleStats.unusualToday(["09:00"], days);
  assert.strictEqual(result.missing.length, 1);
  assert.strictEqual(result.missing[0].time, "16:15");
  assert.strictEqual(result.unexpected.length, 1);
  assert.strictEqual(result.unexpected[0].time, "09:00");
});

test("unusualToday: a normal day (today matches the usual pattern) reports nothing", () => {
  const days = [day("2026-07-01", ["16:15"]), day("2026-07-02", ["16:15"])];
  const result = scheduleStats.unusualToday(["16:15"], days);
  assert.strictEqual(result.missing.length, 0);
  assert.strictEqual(result.unexpected.length, 0);
});

/* ----------------------------------------------------------------------
 * probableProgramme
 * -------------------------------------------------------------------- */
function indexWith(spectacles, excludedDates) {
  return { season: 2026, updated_at: "now", spectacles, excluded_dates: excludedDates || [] };
}

test("probableProgramme: returns null for an excluded date", () => {
  const idx = indexWith({ "les-vikings": { name: "Les Vikings", category: "spectacle", durations: {}, days: { "2026-07-20": "11:30" } } }, ["2026-07-22"]);
  assert.strictEqual(scheduleStats.probableProgramme(idx, null, "2026-07-22"), null);
});

test("probableProgramme: returns null for a date outside the index's known range", () => {
  const idx = indexWith({ "les-vikings": { name: "Les Vikings", category: "spectacle", durations: {}, days: { "2026-07-20": "11:30" } } });
  assert.strictEqual(scheduleStats.probableProgramme(idx, null, "2027-01-01"), null);
});

test("probableProgramme: basic case, enough reference days at ±21, no widening needed", () => {
  // Tous les jours de semaine (lun-ven) entre le 1er juillet et le 2 septembre,
  // Les Vikings présent partout au même horaire -> confiance maximale.
  const spectacleDays = {};
  const d0 = new Date(2026, 5, 1);
  for (let i = 0; i < 63; i++) {
    const d = new Date(d0); d.setDate(d0.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    spectacleDays[iso] = "16:15";
  }
  const idx = indexWith({ "les-vikings": { name: "Les Vikings", category: "spectacle", durations: { "16:15": 26 }, days: spectacleDays } });

  const result = scheduleStats.probableProgramme(idx, null, "2026-07-22"); // mercredi
  assert.ok(result);
  assert.strictEqual(result.basis.rule, "±21 jours");
  assert.ok(result.basis.referenceDays >= 6);
  assert.strictEqual(result.spectacles.length, 1);
  assert.strictEqual(result.spectacles[0].slug, "les-vikings");
  assert.deepStrictEqual(result.spectacles[0].starts, ["16:15"]);
  assert.strictEqual(result.spectacles[0].confidence, 1);
  assert.strictEqual(result.spectacles[0].durations["16:15"], 26);
});

test("probableProgramme: an ephemeral show never appears outside its real period", () => {
  const spectacleDays = {};
  const d0 = new Date(2026, 5, 1);
  for (let i = 0; i < 63; i++) {
    const d = new Date(d0); d.setDate(d0.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    spectacleDays[iso] = "16:15";
  }
  const idx = indexWith({
    "les-vikings": { name: "Les Vikings", category: "spectacle", durations: {}, days: spectacleDays },
    "la-frairie-de-la-toussaint": {
      name: "La Frairie de la Toussaint", category: "spectacle", durations: {},
      days: { "2026-10-05": "14:00", "2026-10-06": "14:00", "2026-10-07": "14:00" },
    },
  });
  const result = scheduleStats.probableProgramme(idx, null, "2026-07-22");
  assert.ok(!result.spectacles.some((s) => s.slug === "la-frairie-de-la-toussaint"));
});

test("probableProgramme: widens to ±45 days when fewer than 6 reference days exist at ±21", () => {
  // Construit précisément via Python (datetime) : au ±21, seuls 3 jours
  // comparables restent (les 27 autres sont marqués "exclus", simulant des
  // fermetures) ; au ±45, 37 jours comparables existent (le spectacle y
  // joue tous les jours de semaine).
  const presentDates = [
    "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-15", "2026-06-16", "2026-06-17",
    "2026-06-18", "2026-06-19", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-29",
    "2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09",
    "2026-07-10", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21",
    "2026-07-23", "2026-07-24", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03",
    "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13",
    "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25",
    "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
  ];
  const excludedDates = [
    "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10", "2026-07-13", "2026-07-14", "2026-07-15",
    "2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21", "2026-07-23", "2026-07-24", "2026-07-27", "2026-07-28",
    "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07",
    "2026-08-10", "2026-08-11", "2026-08-12",
  ];
  const spectacleDays = {};
  presentDates.forEach((d) => { spectacleDays[d] = "11:30"; });
  const idx = indexWith(
    { "les-vikings": { name: "Les Vikings", category: "spectacle", durations: {}, days: spectacleDays } },
    excludedDates
  );

  const result = scheduleStats.probableProgramme(idx, null, "2026-07-22");
  assert.ok(result);
  assert.strictEqual(result.basis.rule, "±45 jours");
  assert.strictEqual(result.basis.referenceDays, 37);
  assert.strictEqual(result.spectacles[0].confidence, 1);
});

test("probableProgramme: a tie between two patterns is broken by the most recent one", () => {
  const idx = indexWith(
    {
      "les-vikings": {
        name: "Les Vikings", category: "spectacle", durations: {},
        days: {
          "2026-07-01": "11:30",
          "2026-07-02": "11:30",
          "2026-07-20": "11:30,16:00",
          "2026-07-21": "11:30,16:00",
        },
      },
    },
    // "2026-07-23" étend juste les bornes de l'index au-delà de la cible ;
    // les autres marquent fermés tous les autres jours de semaine du mois,
    // pour que seuls les 4 jours de données réelles restent comparables
    // (sinon noyés sous le seuil des 50% de présence par la quasi-totalité
    // des jours de semaine de juillet, sans aucune donnée pour la plupart).
    ["2026-07-23", "2026-07-03", "2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10",
     "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"]
  );
  const result = scheduleStats.probableProgramme(idx, null, "2026-07-22");
  assert.strictEqual(result.spectacles[0].confidence, 0.5);
  assert.deepStrictEqual(result.spectacles[0].starts, ["11:30", "16:00"]);
});

test("probableProgramme: falls back to the previous season's index when the current one still lacks data", () => {
  // Les bornes de l'index courant (déduites de excluded_dates faute d'un
  // seul jour de données) sont volontairement étroites — 5 jours autour de
  // la cible, dont 2 marqués fermés — pour qu'il ne reste que 2 jours
  // comparables même élargi à ±45 (les bornes, elles, ne s'élargissent pas
  // avec le rayon). Simule une saison tout juste commencée.
  const idx = indexWith(
    { "les-vikings": { name: "Les Vikings", category: "spectacle", durations: {}, days: {} } },
    ["2026-07-20", "2026-07-24"]
  );
  const previousSeasonIndex = indexWith({
    "les-vikings": {
      name: "Les Vikings", category: "spectacle", durations: {},
      days: {
        "2025-07-20": "16:15", "2025-07-21": "16:15", "2025-07-22": "16:15",
        "2025-07-23": "16:15", "2025-07-24": "16:15", "2025-07-27": "16:15",
      },
    },
  });
  const result = scheduleStats.probableProgramme(idx, null, "2026-07-22", { previousSeasonIndex });
  assert.ok(result);
  assert.strictEqual(result.basis.rule, "saison précédente (même période calendaire)");
  assert.deepStrictEqual(result.spectacles[0].starts, ["16:15"]);
});

/* -----------------------------------------------------------------------
 * indexEntryToDays
 * ------------------------------------------------------------------- */
test("indexEntryToDays: splits the compact day string into sorted starts/ranges", () => {
  const entry = {
    name: "Les Vikings",
    category: "spectacle",
    days: {
      "2026-07-22": "16:15,11:30,13:00",
      "2026-07-23": "12:00-20:45",
    },
  };
  const days = scheduleStats.indexEntryToDays(entry);
  assert.strictEqual(days.length, 2);
  const d22 = days.find((d) => d.date === "2026-07-22");
  assert.deepStrictEqual(d22.starts, ["11:30", "13:00", "16:15"]);
  assert.deepStrictEqual(d22.ranges, []);
  const d23 = days.find((d) => d.date === "2026-07-23");
  assert.deepStrictEqual(d23.starts, []);
  assert.deepStrictEqual(d23.ranges, ["12:00-20:45"]);
});

test("indexEntryToDays: empty/missing days map returns an empty array", () => {
  assert.deepStrictEqual(scheduleStats.indexEntryToDays({ name: "X", days: {} }), []);
  assert.deepStrictEqual(scheduleStats.indexEntryToDays({ name: "X" }), []);
});
