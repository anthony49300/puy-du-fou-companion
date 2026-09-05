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

test("buildAutoPlan (mode précis) never adds an unrequested show as filler", () => {
  const carnet = loadModule("carnet.js");
  const slots = [
    slot("Demandé", "10:00", "10:30", { slug: "demande" }),
    slot("Pas demandé", "14:00", "14:30", { slug: "pas-demande" }), // parfaitement compatible mais pas coché
  ];
  const plan = carnet.buildAutoPlan(slots, 30, ["demande"]);
  assert.deepStrictEqual(plan.map((s) => s.slug), ["demande"]);
});

test("buildAutoPlan (mode précis) casts aside a conflicting show, not the mandatory one", () => {
  const carnet = loadModule("carnet.js");
  const slots = [
    slot("Immersif", "14:00", "14:45", { slug: "immersif" }),
    slot("Autre demandé", "14:30", "15:00", { slug: "autre" }), // chevauche l'immersif
  ];
  const plan = carnet.buildAutoPlan(slots, 30, ["immersif", "autre"]);
  assert.deepStrictEqual(plan.map((s) => s.slug), ["immersif"]);
});

test("buildAutoPlan (mode précis) case deux spectacles demandés même si les portes de l'un ouvrent avant la fin de l'autre", () => {
  const carnet = loadModule("carnet.js");
  // A finit à 10h50, les portes de B (11h00 - 30min) ouvrent à 10h30 : la
  // marge n'est pas respectée, mais les deux séances ne se chevauchent pas
  // réellement (10h50 < 11h00) — un ajout manuel ne bloquerait pas non
  // plus ce cas (juste le badge "Portes justes"), le planning auto non plus.
  const slots = [slot("A", "10:00", "10:50", { slug: "a" }), slot("B", "11:00", "11:30", { slug: "b" })];
  const plan = carnet.buildAutoPlan(slots, 30, ["a", "b"]);
  assert.deepStrictEqual(plan.map((s) => s.slug).sort(), ["a", "b"]);
});

test("buildAutoPlan (mode précis) traite le spectacle le plus contraint en premier pour ne pas le sacrifier inutilement", () => {
  const carnet = loadModule("carnet.js");
  // A n'a qu'une seule séance, qui chevauche la première séance de B ; B a
  // une seconde séance plus tard, totalement libre. Un tri naïf par heure
  // de fin caserait la première séance de B (elle finit avant celle de A)
  // et perdrait A pour de bon, alors que les deux peuvent être casés.
  const slots = [
    slot("A", "09:15", "09:45", { slug: "a" }),
    slot("B", "09:00", "09:30", { slug: "b" }),
    slot("B (plus tard)", "14:00", "14:30", { slug: "b" }),
  ];
  const plan = carnet.buildAutoPlan(slots, 30, ["a", "b"]);
  assert.deepStrictEqual(plan.map((s) => s.slug).sort(), ["a", "b"]);
});

test("buildAutoPlan (mode précis) laisse de côté un spectacle vraiment impossible à caser, sans en perdre un autre", () => {
  const carnet = loadModule("carnet.js");
  const slots = [slot("A", "10:00", "10:30", { slug: "a" }), slot("B", "10:15", "10:45", { slug: "b" })];
  const plan = carnet.buildAutoPlan(slots, 30, ["a", "b"]);
  assert.strictEqual(plan.length, 1);
});

function planItem(name, start, end, opts) {
  return Object.assign({ uid: name, slug: name, name: name, start: start, end: end, is_continuous: false }, opts || {});
}

test("optionsPourManquant lists each possible slot with the show(s) blocking it", () => {
  const carnet = loadModule("carnet.js");
  const slots = [
    slot("Manquant 10h", "10:00", "10:30", { slug: "manquant" }),
    slot("Manquant 15h", "15:00", "15:30", { slug: "manquant" }),
  ];
  const planItems = [planItem("Bloqueur", "10:15", "10:45")]; // ne gêne que le créneau de 10h
  const options = carnet.optionsPourManquant("manquant", slots, 30, planItems);
  assert.strictEqual(options.length, 2);
  assert.deepStrictEqual(options[0].blockers.map((b) => b.name), ["Bloqueur"]);
  assert.deepStrictEqual(options[1].blockers, []);
});

test("optionsPourManquant does not report a tight-but-non-overlapping show as a blocker", () => {
  const carnet = loadModule("carnet.js");
  const slots = [slot("Manquant", "11:00", "11:30", { slug: "manquant" })];
  // Le bloqueur potentiel finit à 10h50, avant le début du manquant (11h00) :
  // pas de chevauchement réel, même si la marge des portes (30 min) n'est
  // pas respectée — ne doit donc plus apparaître comme un blocage.
  const planItems = [planItem("Pas un vrai bloqueur", "10:00", "10:50")];
  const options = carnet.optionsPourManquant("manquant", slots, 30, planItems);
  assert.deepStrictEqual(options[0].blockers, []);
});

test("optionsPourManquant reports no possible slot when the show isn't scheduled that day", () => {
  const carnet = loadModule("carnet.js");
  const slots = [slot("Autre chose", "10:00", "10:30", { slug: "autre" })];
  const options = carnet.optionsPourManquant("absent", slots, 30, []);
  assert.deepStrictEqual(options, []);
});

test("buildAutoPlan guarantees at least one representation of a mandatory show with several per day", () => {
  const carnet = loadModule("carnet.js");
  // Un spectacle répété (ex : fontaines) peut apparaître plusieurs fois dans
  // la proposition, comme n'importe quel spectacle optionnel répété — seule
  // la présence d'AU MOINS une séance est garantie par le mécanisme "incontournable".
  const slots = [
    slot("Fontaines 10h", "10:00", "10:20", { slug: "fontaines" }),
    slot("Fontaines 15h", "15:00", "15:20", { slug: "fontaines" }),
  ];
  const plan = carnet.buildAutoPlan(slots, 30, ["fontaines"]);
  assert.ok(plan.some((s) => s.slug === "fontaines"));
});

test("buildAutoPlan without mandatorySlugs behaves exactly as before (backward compatible)", () => {
  const carnet = loadModule("carnet.js");
  const slots = [slot("A", "10:00", "11:15"), slot("B", "11:00", "11:30"), slot("C", "12:00", "12:30")];
  assert.deepStrictEqual(carnet.buildAutoPlan(slots, 30).map((s) => s.name), carnet.buildAutoPlan(slots, 30, []).map((s) => s.name));
});

test("planDayCellInfo: no record -> just a plain, clickable day", () => {
  const carnet = loadModule("carnet.js");
  const info = carnet.planDayCellInfo(undefined, false, "2026-09-10");
  assert.strictEqual(info.disabled, false);
  assert.strictEqual(info.cls, "cal-day");
});

test("planDayCellInfo: a normal collected day gets has-data, stays clickable", () => {
  const carnet = loadModule("carnet.js");
  const info = carnet.planDayCellInfo({ status: "ok" }, false, "2026-09-05");
  assert.strictEqual(info.cls, "cal-day has-data");
  assert.strictEqual(info.disabled, false);
});

test("planDayCellInfo: closed_day gets is-closed and an explicit 'fermé' title, stays clickable", () => {
  const carnet = loadModule("carnet.js");
  const info = carnet.planDayCellInfo({ status: "closed_day" }, false, "2026-09-07");
  assert.strictEqual(info.cls, "cal-day has-data is-closed");
  assert.strictEqual(info.disabled, false);
  assert.ok(info.title.includes("fermé"));
});

test("planDayCellInfo: out_of_season is treated the same as closed_day", () => {
  const carnet = loadModule("carnet.js");
  const info = carnet.planDayCellInfo({ status: "out_of_season" }, false, "2027-02-01");
  assert.ok(info.cls.includes("is-closed"));
});

test("icsEscape escapes backslash, semicolon, comma and newline per RFC 5545", () => {
  const carnet = loadModule("carnet.js");
  assert.strictEqual(carnet.icsEscape("A, B; C\\D\nE"), "A\\, B\\; C\\\\D\\nE");
});

test("icsEscape treats null/undefined as an empty string", () => {
  const carnet = loadModule("carnet.js");
  assert.strictEqual(carnet.icsEscape(null), "");
  assert.strictEqual(carnet.icsEscape(undefined), "");
});

function planItemIcs(name, start, end, opts) {
  return Object.assign({ uid: "u-" + name, name: name, slug: name, start: start, end: end, is_continuous: false }, opts || {});
}

test("buildIcs wraps events in a valid VCALENDAR with one VEVENT per item", () => {
  const carnet = loadModule("carnet.js");
  const items = [planItemIcs("Les Vikings", "10:45", "11:11")];
  const ics = carnet.buildIcs("2026-09-05", items, 30, new Date("2026-09-01T12:00:00Z"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR$/);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /DTSTART:20260905T104500/);
  assert.match(ics, /DTEND:20260905T111100/);
  assert.match(ics, /SUMMARY:Les Vikings/);
});

test("buildIcs adds a gate-opening VALARM for a fixed-time show, matching the gate margin", () => {
  const carnet = loadModule("carnet.js");
  const items = [planItemIcs("Les Vikings", "10:45", "11:11")];
  const ics = carnet.buildIcs("2026-09-05", items, 30, new Date());
  assert.match(ics, /BEGIN:VALARM[\s\S]*TRIGGER:-PT30M[\s\S]*END:VALARM/);
});

test("buildIcs adds no VALARM for a continuous (no queue) attraction", () => {
  const carnet = loadModule("carnet.js");
  const items = [planItemIcs("Le Mystère de la Pérouse", "12:00", "20:15", { is_continuous: true })];
  const ics = carnet.buildIcs("2026-09-05", items, 30, new Date());
  assert.ok(!ics.includes("BEGIN:VALARM"));
  assert.match(ics, /DESCRIPTION:Accès en continu\./);
});

test("buildIcs defaults DTEND to start+30min when the item has no end time", () => {
  const carnet = loadModule("carnet.js");
  const items = [planItemIcs("Ajout manuel", "22:00", null)];
  const ics = carnet.buildIcs("2026-09-05", items, 30, new Date());
  assert.match(ics, /DTSTART:20260905T220000/);
  assert.match(ics, /DTEND:20260905T223000/);
});

test("buildIcs skips items without a start time", () => {
  const carnet = loadModule("carnet.js");
  const items = [planItemIcs("Sans horaire", null, null)];
  const ics = carnet.buildIcs("2026-09-05", items, 30, new Date());
  assert.ok(!ics.includes("BEGIN:VEVENT"));
});
