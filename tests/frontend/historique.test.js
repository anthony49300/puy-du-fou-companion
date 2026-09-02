const test = require("node:test");
const assert = require("node:assert");
const { loadModule } = require("./helpers");

test("dayCellInfo: no record -> disabled, no data classes", () => {
  const hist = loadModule("historique.js");
  const info = hist.dayCellInfo(undefined, false, "2026-04-01");
  assert.strictEqual(info.disabled, true);
  assert.strictEqual(info.cls, "cal-day");
  assert.strictEqual(info.title, "Aucune donnée");
});

test("dayCellInfo: a normal collected day gets has-data, not disabled", () => {
  const hist = loadModule("historique.js");
  const info = hist.dayCellInfo({ status: "ok" }, false, "2026-08-26");
  assert.strictEqual(info.disabled, false);
  assert.strictEqual(info.cls, "cal-day has-data");
});

test("dayCellInfo: closed_day gets the is-closed class but stays clickable", () => {
  const hist = loadModule("historique.js");
  const info = hist.dayCellInfo({ status: "closed_day" }, false, "2026-08-28");
  assert.strictEqual(info.disabled, false);
  assert.strictEqual(info.cls, "cal-day has-data is-closed");
  assert.match(info.title, /Parc fermé/);
});

test("dayCellInfo: out_of_season is treated the same as closed_day", () => {
  const hist = loadModule("historique.js");
  const info = hist.dayCellInfo({ status: "out_of_season" }, false, "2027-02-01");
  assert.match(info.cls, /is-closed/);
});

test("dayCellInfo: selected day gets is-selected", () => {
  const hist = loadModule("historique.js");
  const info = hist.dayCellInfo({ status: "ok" }, true, "2026-08-26");
  assert.match(info.cls, /is-selected/);
});
