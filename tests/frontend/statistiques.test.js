const test = require("node:test");
const assert = require("node:assert");
const { loadModule } = require("./helpers");

function makeRows(n) {
  const rows = [];
  const start = new Date(2026, 3, 4); // 2026-04-04
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    rows.push({ date: iso, count: i });
  }
  return rows;
}

test("filterByPeriod keeps everything when there are fewer rows than the window", () => {
  const stats = loadModule("statistiques.js");
  stats.state.periodDays = 30;
  const rows = makeRows(10);
  assert.strictEqual(stats.filterByPeriod(rows).length, 10);
});

test("filterByPeriod keeps only the last N days, anchored on the last row", () => {
  const stats = loadModule("statistiques.js");
  stats.state.periodDays = 30;
  const rows = makeRows(144);
  const filtered = stats.filterByPeriod(rows);
  assert.strictEqual(filtered.length, 30);
  assert.strictEqual(filtered[filtered.length - 1].date, rows[rows.length - 1].date);
});

test("filterByPeriod returns everything when periodDays is 0 (toute la saison)", () => {
  const stats = loadModule("statistiques.js");
  stats.state.periodDays = 0;
  const rows = makeRows(144);
  assert.strictEqual(stats.filterByPeriod(rows).length, 144);
});

// Régression : un tick callback explicitement undefined (au lieu d'absent)
// empêche Chart.js d'utiliser son formatage par défaut sur un axe de
// catégories (spectacles, heures...) et fait apparaître l'index brut à la
// place du vrai libellé — voir le bug rapporté sur les graphiques non temporels.
test("buildXTicks omits the callback key entirely for non-date charts", () => {
  const stats = loadModule("statistiques.js");
  const ticks = stats.buildXTicks({ isDate: false }, [{ name: "Les Vikings", count: 10 }], "#000");
  assert.strictEqual("callback" in ticks, false);
  assert.strictEqual(ticks.autoSkip, true);
});

test("buildXTicks provides a calendar-aligned callback for date charts", () => {
  const stats = loadModule("statistiques.js");
  const rows = makeRows(60);
  const ticks = stats.buildXTicks({ isDate: true }, rows, "#000");
  assert.strictEqual(typeof ticks.callback, "function");
  assert.strictEqual(ticks.autoSkip, false);
  // Premier et dernier point toujours labellisés, même hors 1er du mois.
  assert.notStrictEqual(ticks.callback(null, 0), "");
  assert.notStrictEqual(ticks.callback(null, rows.length - 1), "");
});
