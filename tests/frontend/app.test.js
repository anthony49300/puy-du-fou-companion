const test = require("node:test");
const assert = require("node:assert");
const { loadModule } = require("./helpers");

test("formatDateFR formats an ISO date as DD/MM/YYYY", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.formatDateFR("2026-08-26"), "26/08/2026");
});

test("formatDateFR returns a placeholder for an invalid date", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.formatDateFR(""), "—");
});

test("formatTimeFR converts HH:MM to HHhMM", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.formatTimeFR("09:05"), "09h05");
  assert.strictEqual(PDF.formatTimeFR(null), "—");
});

test("timeToMinutes converts HH:MM to minutes since midnight", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.timeToMinutes("01:30"), 90);
  assert.strictEqual(PDF.timeToMinutes(null), null);
});

test("matchesSearch is accent- and case-insensitive", () => {
  const PDF = loadModule("app.js");
  assert.ok(PDF.matchesSearch("L'Épée du Roi Arthur", "epee"));
  assert.ok(PDF.matchesSearch("L'Épée du Roi Arthur", "ÉPÉE"));
  assert.ok(!PDF.matchesSearch("Les Vikings", "epee"));
});

test("categoryLabel falls back to Autre for an unknown category", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.categoryLabel("spectacle_nocturne"), "Spectacle nocturne");
  assert.strictEqual(PDF.categoryLabel("n-importe-quoi"), "Autre");
});

test("isLateHour flags nocturnal hours (>=21h or <5h)", () => {
  const PDF = loadModule("app.js");
  assert.ok(PDF.isLateHour("21:45"));
  assert.ok(PDF.isLateHour("00:30"));
  assert.ok(!PDF.isLateHour("14:00"));
});

test("escapeHtml neutralizes HTML-significant characters", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.escapeHtml("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
});

test("historyJsonPath builds a year-partitioned path", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.historyJsonPath("2026-08-26", 2026), "history/2026/2026-08-26.json");
  assert.strictEqual(PDF.historyJsonPath("2026-08-26"), "history/2026/2026-08-26.json");
});

/* ----------------------------------------------------------------------
 * computeUpcoming — horloge fixée à 14h15 (2026-08-26) pour des résultats
 * déterministes : voir le detail des horaires choisis dans les commentaires
 * ci-dessous, chacun illustrant un cas différent (en cours, dans l'heure,
 * dernière séance, dernière séance ET dans l'heure, accès continu exclu).
 * -------------------------------------------------------------------- */
function sampleToday() {
  return {
    spectacles: [
      {
        name: "Les Vikings", slug: "les-vikings", category: "spectacle",
        representations: [
          { start: "10:00", end: "10:30", is_continuous: false }, // passée
          { start: "14:00", end: "14:30", is_continuous: false }, // en cours
          { start: "14:50", end: "15:20", is_continuous: false }, // dans l'heure ET dernière séance
        ],
      },
      {
        name: "Le Mime et l'Étoile", slug: "le-mime", category: "spectacle",
        representations: [
          { start: "14:20", end: "14:45", is_continuous: false }, // dans l'heure, pas la dernière
          { start: "20:00", end: "20:25", is_continuous: false }, // dernière séance, hors de l'heure
        ],
      },
      {
        name: "Le Signe du Triomphe", slug: "signe", category: "spectacle",
        representations: [
          { start: "15:00", end: "15:22", is_continuous: false }, // dans l'heure, seule séance -> aussi la dernière
        ],
      },
      {
        name: "Les Noces de Feu", slug: "les-noces-de-feu", category: "spectacle_nocturne",
        representations: [
          { start: "21:45", end: "22:10", is_continuous: false }, // prochain nocturne, loin
        ],
      },
      {
        name: "La Renaissance du Château", slug: "renaissance", category: "spectacle_immersif",
        representations: [
          { start: "09:30", end: "18:00", is_continuous: true }, // accès continu : exclu partout
        ],
      },
    ],
  };
}

function at(hh, mm) {
  return new Date(2026, 7, 26, hh, mm, 0); // 26 août 2026 (mois 0-indexé : 7 = août)
}

test("computeUpcoming picks the very next non-continuous showing as 'next'", () => {
  const PDF = loadModule("app.js");
  const upcoming = PDF.computeUpcoming(sampleToday(), at(14, 15));
  assert.strictEqual(upcoming.next.name, "Le Mime et l'Étoile");
  assert.strictEqual(upcoming.next.start, "14:20");
});

test("computeUpcoming lists currently in-progress showings, excluding continuous access", () => {
  const PDF = loadModule("app.js");
  const upcoming = PDF.computeUpcoming(sampleToday(), at(14, 15));
  assert.strictEqual(upcoming.inProgress.length, 1);
  assert.strictEqual(upcoming.inProgress[0].slug, "les-vikings");
  assert.strictEqual(upcoming.inProgress[0].start, "14:00");
});

test("computeUpcoming finds the next nocturnal showing regardless of how far it is", () => {
  const PDF = loadModule("app.js");
  const upcoming = PDF.computeUpcoming(sampleToday(), at(14, 15));
  assert.strictEqual(upcoming.nocturne.slug, "les-noces-de-feu");
  assert.strictEqual(upcoming.nocturne.start, "21:45");
});

test("computeUpcoming withinHour keeps only showings starting within 60 minutes, in order", () => {
  const PDF = loadModule("app.js");
  const upcoming = PDF.computeUpcoming(sampleToday(), at(14, 15));
  assert.deepStrictEqual(
    upcoming.withinHour.map((i) => i.slug + "@" + i.start),
    ["le-mime@14:20", "les-vikings@14:50", "signe@15:00"]
  );
});

test("computeUpcoming flags a slug as 'last of the day' only when its very next showing is also its last", () => {
  const PDF = loadModule("app.js");
  const upcoming = PDF.computeUpcoming(sampleToday(), at(14, 15));
  // les-vikings (14h50) et signe (15h00) sont chacun leur dernière séance ;
  // les-noces-de-feu (21h45) aussi (sa seule séance). le-mime, en revanche,
  // a sa PROCHAINE séance à 14h20 mais une autre suit à 20h00 : sa
  // prochaine séance n'est pas sa dernière, donc absent de la liste — même
  // si, prise isolément, sa séance de 20h00 serait bien "la dernière".
  assert.deepStrictEqual(
    upcoming.lastShowingSlugs.slice().sort(),
    ["les-noces-de-feu", "les-vikings", "signe"]
  );
  assert.ok(!upcoming.lastShowingSlugs.includes("le-mime"));
});

/* ----------------------------------------------------------------------
 * Carnet (plan du jour) : stockage partagé — mock localStorage en mémoire,
 * posé APRÈS loadModule() (qui réinitialise global.localStorage à un stub
 * no-op à chaque appel, voir helpers.js), pour obtenir un round-trip réel.
 * -------------------------------------------------------------------- */
function withMemoryLocalStorage() {
  var store = {};
  global.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
  };
}

test("addToPlan creates the day's plan and adds the representation", () => {
  const PDF = loadModule("app.js");
  withMemoryLocalStorage();
  const added = PDF.addToPlan("2026-08-26", { slug: "les-vikings", name: "Les Vikings", category: "spectacle", start: "14:00", end: "14:30", is_continuous: false });
  assert.strictEqual(added, true);
  const state = PDF.loadCarnetState();
  assert.strictEqual(state.plans["2026-08-26"].items.length, 1);
  assert.strictEqual(state.plans["2026-08-26"].items[0].slug, "les-vikings");
  assert.ok(state.plans["2026-08-26"].items[0].uid);
});

test("addToPlan does not add the same representation twice", () => {
  const PDF = loadModule("app.js");
  withMemoryLocalStorage();
  const item = { slug: "les-vikings", name: "Les Vikings", category: "spectacle", start: "14:00", end: "14:30", is_continuous: false };
  assert.strictEqual(PDF.addToPlan("2026-08-26", item), true);
  assert.strictEqual(PDF.addToPlan("2026-08-26", item), false);
  assert.strictEqual(PDF.loadCarnetState().plans["2026-08-26"].items.length, 1);
});

test("isInPlan reflects whether a specific showing was already added", () => {
  const PDF = loadModule("app.js");
  withMemoryLocalStorage();
  assert.strictEqual(PDF.isInPlan("2026-08-26", "les-vikings", "14:00"), false);
  PDF.addToPlan("2026-08-26", { slug: "les-vikings", name: "Les Vikings", category: "spectacle", start: "14:00", end: "14:30", is_continuous: false });
  assert.strictEqual(PDF.isInPlan("2026-08-26", "les-vikings", "14:00"), true);
  assert.strictEqual(PDF.isInPlan("2026-08-26", "les-vikings", "16:00"), false);
});

test("removeFromPlan removes a specific showing and reports success", () => {
  const PDF = loadModule("app.js");
  withMemoryLocalStorage();
  PDF.addToPlan("2026-08-26", { slug: "les-vikings", name: "Les Vikings", category: "spectacle", start: "14:00", end: "14:30", is_continuous: false });
  assert.strictEqual(PDF.removeFromPlan("2026-08-26", "les-vikings", "14:00"), true);
  assert.strictEqual(PDF.isInPlan("2026-08-26", "les-vikings", "14:00"), false);
});

test("removeFromPlan returns false when there is nothing to remove", () => {
  const PDF = loadModule("app.js");
  withMemoryLocalStorage();
  assert.strictEqual(PDF.removeFromPlan("2026-08-26", "les-vikings", "14:00"), false);
});

test("planItemExists detects a duplicate by slug + timing", () => {
  const PDF = loadModule("app.js");
  const plan = { items: [{ slug: "les-vikings", name: "Les Vikings", start: "10:00", end: "10:30", is_continuous: false }] };
  assert.ok(PDF.planItemExists(plan, { slug: "les-vikings", start: "10:00", end: "10:30", is_continuous: false }));
  assert.ok(!PDF.planItemExists(plan, { slug: "les-vikings", start: "16:00", end: "16:30", is_continuous: false }));
});

test("planItemExists falls back to name for manual (slug-less) entries", () => {
  const PDF = loadModule("app.js");
  const plan = { items: [{ slug: null, name: "Cinéscénie", start: "22:00", end: "23:40", is_continuous: false }] };
  assert.ok(PDF.planItemExists(plan, { slug: null, name: "Cinéscénie", start: "22:00", end: "23:40", is_continuous: false }));
});

test("icsEscape escapes backslash, semicolon, comma and newline per RFC 5545", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.icsEscape("A, B; C\\D\nE"), "A\\, B\\; C\\\\D\\nE");
});

test("icsEscape treats null/undefined as an empty string", () => {
  const PDF = loadModule("app.js");
  assert.strictEqual(PDF.icsEscape(null), "");
  assert.strictEqual(PDF.icsEscape(undefined), "");
});
