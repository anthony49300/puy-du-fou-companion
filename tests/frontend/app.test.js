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
