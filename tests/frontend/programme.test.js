const test = require("node:test");
const assert = require("node:assert");
const { loadModule } = require("./helpers");

function rep(start, end, opts) {
  return Object.assign({ start: start, end: end, is_continuous: false }, opts || {});
}

function slot(name, start, end, opts) {
  return { spectacle: { name: name, slug: name, category: "spectacle" }, rep: rep(start, end, opts) };
}

test("durationMinutes computes the gap between start and end", () => {
  const programme = loadModule("programme.js");
  assert.strictEqual(programme.durationMinutes("10:00", "10:30"), 30);
});

test("durationMinutes handles a representation crossing midnight", () => {
  const programme = loadModule("programme.js");
  assert.strictEqual(programme.durationMinutes("23:45", "00:15"), 30);
});

test("durationMinutes returns null when start or end is missing", () => {
  const programme = loadModule("programme.js");
  assert.strictEqual(programme.durationMinutes(null, "10:30"), null);
  assert.strictEqual(programme.durationMinutes("10:00", null), null);
});

test("sortKeyMinutes sorts a missing time to the very end", () => {
  const programme = loadModule("programme.js");
  assert.ok(programme.sortKeyMinutes(null) > programme.sortKeyMinutes("23:59"));
});

test("categorizeSlots splits past vs upcoming around the given clock", () => {
  const programme = loadModule("programme.js");
  const slots = [slot("A", "10:00", "10:30"), slot("B", "14:00", "14:30"), slot("C", "16:00", "16:30")];
  const result = programme.categorizeSlots(slots, 14 * 60 + 15); // 14h15
  assert.deepStrictEqual(result.past.map((s) => s.spectacle.name), ["A", "B"]);
  assert.deepStrictEqual(result.upcoming.map((s) => s.spectacle.name), ["C"]);
});

test("categorizeSlots treats a slot starting exactly now as upcoming, not past", () => {
  const programme = loadModule("programme.js");
  const slots = [slot("A", "14:00", "14:30")];
  const result = programme.categorizeSlots(slots, 14 * 60);
  assert.strictEqual(result.past.length, 0);
  assert.strictEqual(result.upcoming.length, 1);
});

test("categorizeSlots puts everything in 'upcoming' when nowMinutes is null (not really today)", () => {
  const programme = loadModule("programme.js");
  const slots = [slot("A", "10:00", "10:30"), slot("B", "14:00", "14:30")];
  const result = programme.categorizeSlots(slots, null);
  assert.strictEqual(result.past.length, 0);
  assert.strictEqual(result.upcoming.length, 2);
});

test("buildSlots sorts continuous shows first, then by start time", () => {
  const programme = loadModule("programme.js");
  const today = {
    spectacles: [
      { name: "B", slug: "b", category: "spectacle", representations: [rep("11:00", "11:30")] },
      { name: "A", slug: "a", category: "spectacle_immersif", representations: [rep("09:00", "18:00", { is_continuous: true })] },
      { name: "C", slug: "c", category: "spectacle", representations: [rep("10:00", "10:30")] },
    ],
  };
  const slots = programme.buildSlots(today);
  assert.deepStrictEqual(slots.map((s) => s.spectacle.name), ["A", "C", "B"]);
});
