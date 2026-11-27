const test = require("node:test");
const assert = require("node:assert");
const { loadModule } = require("./helpers");

function rep(start, end) {
  return { start: start, end: end };
}

test("detecterConflits finds no conflict when shows are well spaced", () => {
  const dayPlan = loadModule("day-plan.js");
  const fixes = [rep("10:00", "10:30"), rep("11:00", "11:30")];
  assert.deepStrictEqual(dayPlan.detecterConflits(fixes, 30), []);
});

test("detecterConflits flags a real overlap (chevauchement: true)", () => {
  const dayPlan = loadModule("day-plan.js");
  const fixes = [rep("10:00", "11:15"), rep("11:00", "11:30")];
  const conflits = dayPlan.detecterConflits(fixes, 30);
  assert.strictEqual(conflits.length, 1);
  assert.strictEqual(conflits[0].chevauchement, true);
});

test("detecterConflits flags a tight-but-not-overlapping gate (chevauchement: false)", () => {
  const dayPlan = loadModule("day-plan.js");
  // Fin à 10:50, portes du suivant (11:00 - 30min gate) = 10:30 : 10:50 > 10:30 mais pas > 11:00.
  const fixes = [rep("10:00", "10:50"), rep("11:00", "11:30")];
  const conflits = dayPlan.detecterConflits(fixes, 30);
  assert.strictEqual(conflits.length, 1);
  assert.strictEqual(conflits[0].chevauchement, false);
});

test("severiteConflit reports the worst severity an item is involved in", () => {
  const dayPlan = loadModule("day-plan.js");
  const a = rep("10:00", "11:15");
  const b = rep("11:00", "11:30");
  const c = rep("12:00", "12:30");
  const conflits = [{ a: a, b: b, chevauchement: true }];
  assert.strictEqual(dayPlan.severiteConflit(a, conflits), "error");
  assert.strictEqual(dayPlan.severiteConflit(b, conflits), "error");
  assert.strictEqual(dayPlan.severiteConflit(c, conflits), null);
});

test("conflitChevauchementAvec returns the other show in a real overlap", () => {
  const dayPlan = loadModule("day-plan.js");
  const a = rep("10:00", "11:15");
  const b = rep("11:00", "11:30");
  const conflits = [{ a: a, b: b, chevauchement: true }];
  assert.strictEqual(dayPlan.conflitChevauchementAvec(a, conflits), b);
  assert.strictEqual(dayPlan.conflitChevauchementAvec(b, conflits), a);
});

test("conflitChevauchementAvec ignores a tight-but-not-overlapping pair", () => {
  const dayPlan = loadModule("day-plan.js");
  const a = rep("10:00", "10:50");
  const b = rep("11:00", "11:30");
  const conflits = [{ a: a, b: b, chevauchement: false }];
  assert.strictEqual(dayPlan.conflitChevauchementAvec(a, conflits), null);
});

test("compterSeveriteConflits splits real overlaps from tight transfers", () => {
  const dayPlan = loadModule("day-plan.js");
  const conflits = [
    { a: rep("10:00", "11:15"), b: rep("11:00", "11:30"), chevauchement: true },
    { a: rep("12:00", "12:50"), b: rep("13:00", "13:30"), chevauchement: false },
    { a: rep("14:00", "14:50"), b: rep("15:00", "15:30"), chevauchement: false },
  ];
  assert.deepStrictEqual(dayPlan.compterSeveriteConflits(conflits), { overlaps: 1, tight: 2 });
});

test("compterSeveriteConflits returns zeros for an empty list", () => {
  const dayPlan = loadModule("day-plan.js");
  assert.deepStrictEqual(dayPlan.compterSeveriteConflits([]), { overlaps: 0, tight: 0 });
});

test("minutesToHHMM converts minutes-since-midnight back to HH:MM", () => {
  const dayPlan = loadModule("day-plan.js");
  assert.strictEqual(dayPlan.minutesToHHMM(90), "01:30");
  assert.strictEqual(dayPlan.minutesToHHMM(645), "10:45");
});

test("minutesToHHMM wraps around before midnight (defensive edge case)", () => {
  const dayPlan = loadModule("day-plan.js");
  assert.strictEqual(dayPlan.minutesToHHMM(-15), "23:45");
});

function slot(name, start, end, opts) {
  return Object.assign({ name: name, slug: name, start: start, end: end, is_continuous: false, status: "scheduled" }, opts || {});
}

test("buildAutoPlan keeps every continuous show regardless of overlaps", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [slot("Continu A", "10:00", "18:00", { is_continuous: true }), slot("Continu B", "09:00", "19:00", { is_continuous: true })];
  const plan = dayPlan.buildAutoPlan(slots, 30);
  assert.strictEqual(plan.length, 2);
});

test("buildAutoPlan picks the maximum compatible set of fixed shows (drops the one blocking two others)", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [
    slot("A", "10:00", "11:15"),
    slot("B", "11:00", "11:30"), // chevauche A
    slot("C", "12:00", "12:30"), // compatible avec A, pas avec B
  ];
  const plan = dayPlan.buildAutoPlan(slots, 30);
  assert.deepStrictEqual(plan.map((s) => s.name), ["A", "C"]);
});

test("buildAutoPlan respects the gate margin, not just literal overlap", () => {
  const dayPlan = loadModule("day-plan.js");
  // Pas de chevauchement littéral (10:50 < 11:00) mais portes de B = 11:00 - 30 = 10:30 < fin de A.
  const slots = [slot("A", "10:00", "10:50"), slot("B", "11:00", "11:30")];
  const plan = dayPlan.buildAutoPlan(slots, 30);
  assert.deepStrictEqual(plan.map((s) => s.name), ["A"]);
});

test("buildAutoPlan excludes sold-out ('complet') shows", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [slot("A", "10:00", "10:30", { status: "complet" }), slot("B", "14:00", "14:30")];
  const plan = dayPlan.buildAutoPlan(slots, 30);
  assert.deepStrictEqual(plan.map((s) => s.name), ["B"]);
});

test("buildAutoPlan (mode précis) never adds an unrequested show as filler", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [
    slot("Demandé", "10:00", "10:30", { slug: "demande" }),
    slot("Pas demandé", "14:00", "14:30", { slug: "pas-demande" }), // parfaitement compatible mais pas coché
  ];
  const plan = dayPlan.buildAutoPlan(slots, 30, ["demande"]);
  assert.deepStrictEqual(plan.map((s) => s.slug), ["demande"]);
});

test("buildAutoPlan (mode précis) casts aside a conflicting show, not the mandatory one", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [
    slot("Immersif", "14:00", "14:45", { slug: "immersif" }),
    slot("Autre demandé", "14:30", "15:00", { slug: "autre" }), // chevauche l'immersif
  ];
  const plan = dayPlan.buildAutoPlan(slots, 30, ["immersif", "autre"]);
  assert.deepStrictEqual(plan.map((s) => s.slug), ["immersif"]);
});

test("buildAutoPlan (mode précis) case deux spectacles demandés même si les portes de l'un ouvrent avant la fin de l'autre", () => {
  const dayPlan = loadModule("day-plan.js");
  // A finit à 10h50, les portes de B (11h00 - 30min) ouvrent à 10h30 : la
  // marge n'est pas respectée, mais les deux séances ne se chevauchent pas
  // réellement (10h50 < 11h00) — un ajout manuel ne bloquerait pas non
  // plus ce cas (juste le badge "Portes justes"), le planning auto non plus.
  const slots = [slot("A", "10:00", "10:50", { slug: "a" }), slot("B", "11:00", "11:30", { slug: "b" })];
  const plan = dayPlan.buildAutoPlan(slots, 30, ["a", "b"]);
  assert.deepStrictEqual(plan.map((s) => s.slug).sort(), ["a", "b"]);
});

test("buildAutoPlan (mode précis) traite le spectacle le plus contraint en premier pour ne pas le sacrifier inutilement", () => {
  const dayPlan = loadModule("day-plan.js");
  // A n'a qu'une seule séance, qui chevauche la première séance de B ; B a
  // une seconde séance plus tard, totalement libre. Un tri naïf par heure
  // de fin caserait la première séance de B (elle finit avant celle de A)
  // et perdrait A pour de bon, alors que les deux peuvent être casés.
  const slots = [
    slot("A", "09:15", "09:45", { slug: "a" }),
    slot("B", "09:00", "09:30", { slug: "b" }),
    slot("B (plus tard)", "14:00", "14:30", { slug: "b" }),
  ];
  const plan = dayPlan.buildAutoPlan(slots, 30, ["a", "b"]);
  assert.deepStrictEqual(plan.map((s) => s.slug).sort(), ["a", "b"]);
});

test("buildAutoPlan (mode précis) laisse de côté un spectacle vraiment impossible à caser, sans en perdre un autre", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [slot("A", "10:00", "10:30", { slug: "a" }), slot("B", "10:15", "10:45", { slug: "b" })];
  const plan = dayPlan.buildAutoPlan(slots, 30, ["a", "b"]);
  assert.strictEqual(plan.length, 1);
});

function planItem(name, start, end, opts) {
  return Object.assign({ uid: name, slug: name, name: name, start: start, end: end, is_continuous: false }, opts || {});
}

test("optionsPourManquant lists each possible slot with the show(s) blocking it", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [
    slot("Manquant 10h", "10:00", "10:30", { slug: "manquant" }),
    slot("Manquant 15h", "15:00", "15:30", { slug: "manquant" }),
  ];
  const planItems = [planItem("Bloqueur", "10:15", "10:45")]; // ne gêne que le créneau de 10h
  const options = dayPlan.optionsPourManquant("manquant", slots, 30, planItems);
  assert.strictEqual(options.length, 2);
  assert.deepStrictEqual(options[0].blockers.map((b) => b.name), ["Bloqueur"]);
  assert.deepStrictEqual(options[1].blockers, []);
});

test("optionsPourManquant does not report a tight-but-non-overlapping show as a blocker", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [slot("Manquant", "11:00", "11:30", { slug: "manquant" })];
  // Le bloqueur potentiel finit à 10h50, avant le début du manquant (11h00) :
  // pas de chevauchement réel, même si la marge des portes (30 min) n'est
  // pas respectée — ne doit donc plus apparaître comme un blocage.
  const planItems = [planItem("Pas un vrai bloqueur", "10:00", "10:50")];
  const options = dayPlan.optionsPourManquant("manquant", slots, 30, planItems);
  assert.deepStrictEqual(options[0].blockers, []);
});

test("optionsPourManquant reports no possible slot when the show isn't scheduled that day", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [slot("Autre chose", "10:00", "10:30", { slug: "autre" })];
  const options = dayPlan.optionsPourManquant("absent", slots, 30, []);
  assert.deepStrictEqual(options, []);
});

test("analyserManques lists only the requested shows missing from the plan, with a display name", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [slot("Manquant", "10:00", "10:30", { slug: "manquant" })];
  const planItems = [planItem("Déjà casé", "14:00", "14:30", { slug: "deja-case" })];
  const catalogueBySlug = { manquant: { name: "Le Spectacle Manquant" } };
  const manques = dayPlan.analyserManques(["deja-case", "manquant"], slots, 30, planItems, catalogueBySlug);
  assert.deepStrictEqual(manques.map((m) => m.slug), ["manquant"]);
  assert.strictEqual(manques[0].name, "Le Spectacle Manquant");
});

test("buildAutoPlan guarantees at least one representation of a mandatory show with several per day", () => {
  const dayPlan = loadModule("day-plan.js");
  // Un spectacle répété (ex : fontaines) peut apparaître plusieurs fois dans
  // la proposition, comme n'importe quel spectacle optionnel répété — seule
  // la présence d'AU MOINS une séance est garantie par le mécanisme "incontournable".
  const slots = [
    slot("Fontaines 10h", "10:00", "10:20", { slug: "fontaines" }),
    slot("Fontaines 15h", "15:00", "15:20", { slug: "fontaines" }),
  ];
  const plan = dayPlan.buildAutoPlan(slots, 30, ["fontaines"]);
  assert.ok(plan.some((s) => s.slug === "fontaines"));
});

test("buildAutoPlan without mandatorySlugs behaves exactly as before (backward compatible)", () => {
  const dayPlan = loadModule("day-plan.js");
  const slots = [slot("A", "10:00", "11:15"), slot("B", "11:00", "11:30"), slot("C", "12:00", "12:30")];
  assert.deepStrictEqual(dayPlan.buildAutoPlan(slots, 30).map((s) => s.name), dayPlan.buildAutoPlan(slots, 30, []).map((s) => s.name));
});

test("planDayCellInfo: no record -> just a plain, clickable day", () => {
  const dayPlan = loadModule("day-plan.js");
  const info = dayPlan.planDayCellInfo(undefined, false, "2026-09-10");
  assert.strictEqual(info.disabled, false);
  assert.strictEqual(info.cls, "cal-day");
});

test("planDayCellInfo: a normal collected day gets has-data, stays clickable", () => {
  const dayPlan = loadModule("day-plan.js");
  const info = dayPlan.planDayCellInfo({ status: "ok" }, false, "2026-09-05");
  assert.strictEqual(info.cls, "cal-day has-data");
  assert.strictEqual(info.disabled, false);
});

test("planDayCellInfo: closed_day gets is-closed and an explicit 'fermé' title, stays clickable", () => {
  const dayPlan = loadModule("day-plan.js");
  const info = dayPlan.planDayCellInfo({ status: "closed_day" }, false, "2026-09-07");
  assert.strictEqual(info.cls, "cal-day has-data is-closed");
  assert.strictEqual(info.disabled, false);
  assert.ok(info.title.includes("fermé"));
});

test("planDayCellInfo: out_of_season is treated the same as closed_day", () => {
  const dayPlan = loadModule("day-plan.js");
  const info = dayPlan.planDayCellInfo({ status: "out_of_season" }, false, "2027-02-01");
  assert.ok(info.cls.includes("is-closed"));
});

function planItemIcs(name, start, end, opts) {
  return Object.assign({ uid: "u-" + name, name: name, slug: name, start: start, end: end, is_continuous: false }, opts || {});
}

test("buildIcs wraps events in a valid VCALENDAR with one VEVENT per item", () => {
  const dayPlan = loadModule("day-plan.js");
  const items = [planItemIcs("Les Vikings", "10:45", "11:11")];
  const ics = dayPlan.buildIcs("2026-09-05", items, 30, new Date("2026-09-01T12:00:00Z"));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR$/);
  assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /DTSTART:20260905T104500/);
  assert.match(ics, /DTEND:20260905T111100/);
  assert.match(ics, /SUMMARY:Les Vikings/);
});

test("buildIcs adds a gate-opening VALARM for a fixed-time show, matching the gate margin", () => {
  const dayPlan = loadModule("day-plan.js");
  const items = [planItemIcs("Les Vikings", "10:45", "11:11")];
  const ics = dayPlan.buildIcs("2026-09-05", items, 30, new Date());
  assert.match(ics, /BEGIN:VALARM[\s\S]*TRIGGER:-PT30M[\s\S]*END:VALARM/);
});

test("buildIcs adds no VALARM for a continuous (no queue) attraction", () => {
  const dayPlan = loadModule("day-plan.js");
  const items = [planItemIcs("Le Mystère de la Pérouse", "12:00", "20:15", { is_continuous: true })];
  const ics = dayPlan.buildIcs("2026-09-05", items, 30, new Date());
  assert.ok(!ics.includes("BEGIN:VALARM"));
  assert.match(ics, /DESCRIPTION:Accès en continu\./);
});

test("buildIcs defaults DTEND to start+30min when the item has no end time", () => {
  const dayPlan = loadModule("day-plan.js");
  const items = [planItemIcs("Ajout manuel", "22:00", null)];
  const ics = dayPlan.buildIcs("2026-09-05", items, 30, new Date());
  assert.match(ics, /DTSTART:20260905T220000/);
  assert.match(ics, /DTEND:20260905T223000/);
});

test("buildIcs skips items without a start time", () => {
  const dayPlan = loadModule("day-plan.js");
  const items = [planItemIcs("Sans horaire", null, null)];
  const ics = dayPlan.buildIcs("2026-09-05", items, 30, new Date());
  assert.ok(!ics.includes("BEGIN:VEVENT"));
});
