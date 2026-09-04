const test = require("node:test");
const assert = require("node:assert");
const { loadModule } = require("./helpers");

function rep(start, end) {
  return { start: start, end: end };
}

test("detecterConflits finds no conflict when shows are well spaced", () => {
  const carnet = loadModule("carnet.js");
  const fixes = [rep("10:00", "10:30"), rep("11:00", "11:30")];
  assert.deepStrictEqual(carnet.detecterConflits(fixes, 30), []);
});

test("detecterConflits flags a real overlap (chevauchement: true)", () => {
  const carnet = loadModule("carnet.js");
  const fixes = [rep("10:00", "11:15"), rep("11:00", "11:30")];
  const conflits = carnet.detecterConflits(fixes, 30);
  assert.strictEqual(conflits.length, 1);
  assert.strictEqual(conflits[0].chevauchement, true);
});

test("detecterConflits flags a tight-but-not-overlapping gate (chevauchement: false)", () => {
  const carnet = loadModule("carnet.js");
  // Fin à 10:50, portes du suivant (11:00 - 30min gate) = 10:30 : 10:50 > 10:30 mais pas > 11:00.
  const fixes = [rep("10:00", "10:50"), rep("11:00", "11:30")];
  const conflits = carnet.detecterConflits(fixes, 30);
  assert.strictEqual(conflits.length, 1);
  assert.strictEqual(conflits[0].chevauchement, false);
});

test("planItemExists detects a duplicate by slug + timing", () => {
  const carnet = loadModule("carnet.js");
  const plan = { items: [{ slug: "les-vikings", name: "Les Vikings", start: "10:00", end: "10:30", is_continuous: false }] };
  assert.ok(carnet.planItemExists(plan, { slug: "les-vikings", start: "10:00", end: "10:30", is_continuous: false }));
  assert.ok(!carnet.planItemExists(plan, { slug: "les-vikings", start: "16:00", end: "16:30", is_continuous: false }));
});

test("planItemExists falls back to name for manual (slug-less) entries", () => {
  const carnet = loadModule("carnet.js");
  const plan = { items: [{ slug: null, name: "Cinéscénie", start: "22:00", end: "23:40", is_continuous: false }] };
  assert.ok(carnet.planItemExists(plan, { slug: null, name: "Cinéscénie", start: "22:00", end: "23:40", is_continuous: false }));
});

test("severiteConflit reports the worst severity an item is involved in", () => {
  const carnet = loadModule("carnet.js");
  const a = rep("10:00", "11:15");
  const b = rep("11:00", "11:30");
  const c = rep("12:00", "12:30");
  const conflits = [{ a: a, b: b, chevauchement: true }];
  assert.strictEqual(carnet.severiteConflit(a, conflits), "error");
  assert.strictEqual(carnet.severiteConflit(b, conflits), "error");
  assert.strictEqual(carnet.severiteConflit(c, conflits), null);
});

test("minutesToHHMM converts minutes-since-midnight back to HH:MM", () => {
  const carnet = loadModule("carnet.js");
  assert.strictEqual(carnet.minutesToHHMM(90), "01:30");
  assert.strictEqual(carnet.minutesToHHMM(645), "10:45");
});

test("minutesToHHMM wraps around before midnight (defensive edge case)", () => {
  const carnet = loadModule("carnet.js");
  assert.strictEqual(carnet.minutesToHHMM(-15), "23:45");
});

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

function slot(name, start, end, opts) {
  return Object.assign({ name: name, slug: name, start: start, end: end, is_continuous: false, status: "scheduled" }, opts || {});
}

test("buildAutoPlan keeps every continuous show regardless of overlaps", () => {
  const carnet = loadModule("carnet.js");
  const slots = [slot("Continu A", "10:00", "18:00", { is_continuous: true }), slot("Continu B", "09:00", "19:00", { is_continuous: true })];
  const plan = carnet.buildAutoPlan(slots, 30);
  assert.strictEqual(plan.length, 2);
});

test("buildAutoPlan picks the maximum compatible set of fixed shows (drops the one blocking two others)", () => {
  const carnet = loadModule("carnet.js");
  const slots = [
    slot("A", "10:00", "11:15"),
    slot("B", "11:00", "11:30"), // chevauche A
    slot("C", "12:00", "12:30"), // compatible avec A, pas avec B
  ];
  const plan = carnet.buildAutoPlan(slots, 30);
  assert.deepStrictEqual(plan.map((s) => s.name), ["A", "C"]);
});

test("buildAutoPlan respects the gate margin, not just literal overlap", () => {
  const carnet = loadModule("carnet.js");
  // Pas de chevauchement littéral (10:50 < 11:00) mais portes de B = 11:00 - 30 = 10:30 < fin de A.
  const slots = [slot("A", "10:00", "10:50"), slot("B", "11:00", "11:30")];
  const plan = carnet.buildAutoPlan(slots, 30);
  assert.deepStrictEqual(plan.map((s) => s.name), ["A"]);
});

test("buildAutoPlan excludes sold-out ('complet') shows", () => {
  const carnet = loadModule("carnet.js");
  const slots = [slot("A", "10:00", "10:30", { status: "complet" }), slot("B", "14:00", "14:30")];
  const plan = carnet.buildAutoPlan(slots, 30);
  assert.deepStrictEqual(plan.map((s) => s.name), ["B"]);
});
