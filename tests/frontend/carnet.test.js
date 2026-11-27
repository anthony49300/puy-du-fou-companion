const test = require("node:test");
const assert = require("node:assert");
const { loadModule } = require("./helpers");

// Conflict detection, auto-plan generation, ICS export and the day-picker
// calendar helper moved to site/js/day-plan.js (shared with journee.js, the
// day-editor rework) — see tests/frontend/day-plan.test.js. What remains
// here (Visites/Bilan/Pass tabs) is carnet.js's own logic.

test("cycleSeen counts up 0 -> 1 -> 2 then clears the entry", () => {
  const carnet = loadModule("carnet.js");
  const seen = {};
  carnet.cycleSeen(seen, "les-vikings");
  assert.strictEqual(seen["les-vikings"], 1);
  carnet.cycleSeen(seen, "les-vikings");
  assert.strictEqual(seen["les-vikings"], 2);
  carnet.cycleSeen(seen, "les-vikings");
  assert.strictEqual("les-vikings" in seen, false);
});

test("cycleSeen only touches the given key", () => {
  const carnet = loadModule("carnet.js");
  const seen = { autre: 1 };
  carnet.cycleSeen(seen, "les-vikings");
  assert.deepStrictEqual(seen, { autre: 1, "les-vikings": 1 });
});
