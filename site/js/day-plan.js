/* =========================================================================
   day-plan.js — pure logic shared by the day planner (site/js/journee.js)
   and, until the old "Journée" tab is removed (see REDESIGN_PROMPT phase 6
   of the day-editor rework), site/js/carnet.js.

   Every function here is pure: it takes plain data (plan items, official
   showings, settings) and returns plain data, with no DOM access and no
   fetch — see journee.js for the rendering/fetch layer that consumes these
   results. Kept in one place so both callers share the exact same
   conflict-detection/auto-plan/ICS-export rules rather than risking two
   copies drifting apart.
   ========================================================================= */
(function () {
  "use strict";
  var PDF = window.PDF;

  /* ----------------------------------------------------------------------
   * Programme officiel/estimé -> liste de créneaux ("slots")
   * -------------------------------------------------------------------- */

  // today.json / history/{année}/{date}.json -> une entrée par représentation,
  // triée (accès continu d'abord, puis heure de début croissante).
  function realDayToSlots(dayData) {
    var slots = [];
    (dayData.spectacles || []).forEach(function (sp) {
      (sp.representations || []).forEach(function (rep) {
        slots.push({
          slug: sp.slug, name: sp.name, category: sp.category,
          start: rep.start, end: rep.end, is_continuous: !!rep.is_continuous, status: rep.status,
        });
      });
    });
    slots.sort(function (a, b) {
      if (a.is_continuous && b.is_continuous) return 0;
      if (a.is_continuous) return -1;
      if (b.is_continuous) return 1;
      return (a.start || "").localeCompare(b.start || "");
    });
    return slots;
  }

  // Même forme que realDayToSlots, mais à partir d'une estimation (voir
  // PDF.scheduleStats.probableProgramme) : chaque entrée porte en plus
  // `estimated: true` et sa confiance.
  function probableToSlots(probable) {
    var slots = [];
    probable.spectacles.forEach(function (item) {
      var duration = null;
      item.starts.forEach(function (t) {
        duration = item.durations && item.durations[t] != null ? item.durations[t] : null;
        slots.push({
          slug: item.slug, name: item.name, category: item.category,
          start: t, end: duration != null ? minutesToHHMM(PDF.timeToMinutes(t) + duration) : null,
          is_continuous: false, status: "scheduled", estimated: true, confidence: item.confidence,
        });
      });
      item.ranges.forEach(function (r) {
        var parts = r.split("-");
        slots.push({
          slug: item.slug, name: item.name, category: item.category,
          start: parts[0], end: parts[1] || null, is_continuous: true, status: "scheduled",
          estimated: true, confidence: item.confidence,
        });
      });
    });
    slots.sort(function (a, b) {
      if (a.is_continuous && b.is_continuous) return 0;
      if (a.is_continuous) return -1;
      if (b.is_continuous) return 1;
      return (a.start || "").localeCompare(b.start || "");
    });
    return slots;
  }

  /* ----------------------------------------------------------------------
   * Plan du jour : tri, conflits
   * -------------------------------------------------------------------- */

  function itemsFixesTries(items) {
    return items
      .filter(function (it) { return !it.is_continuous && it.start && it.end; })
      .sort(function (a, b) { return a.start.localeCompare(b.start); });
  }

  // Une entrée par paire de séances consécutives À HEURE FIXE problématique :
  // chevauchement: true = recouvrement réel (impossible de voir les deux en
  // entier) ; false = pas de recouvrement mais la marge "portes" n'est pas
  // respectée (juste serré).
  function detecterConflits(fixes, gate) {
    var out = [];
    for (var i = 0; i < fixes.length - 1; i++) {
      var a = fixes[i], b = fixes[i + 1];
      var finA = PDF.timeToMinutes(a.end);
      var debB = PDF.timeToMinutes(b.start);
      var portesB = debB - gate;
      if (finA > debB) out.push({ a: a, b: b, chevauchement: true });
      else if (finA > portesB) out.push({ a: a, b: b, chevauchement: false });
    }
    return out;
  }

  // Pire sévérité impliquant `it` : "error" (chevauchement réel des deux
  // séances) prime sur "warn" (juste trop juste pour les portes) ; null si
  // l'item n'est concerné par aucune alerte.
  function severiteConflit(it, conflits) {
    var pire = null;
    conflits.forEach(function (c) {
      if (c.a !== it && c.b !== it) return;
      if (c.chevauchement) pire = "error";
      else if (!pire) pire = "warn";
    });
    return pire;
  }

  // L'AUTRE séance impliquée dans un chevauchement réel avec `it`, ou null.
  function conflitChevauchementAvec(it, conflits) {
    var trouve = conflits.filter(function (c) { return c.chevauchement && (c.a === it || c.b === it); })[0];
    if (!trouve) return null;
    return trouve.a === it ? trouve.b : trouve.a;
  }

  // Compte séparément les chevauchements réels et les enchaînements juste
  // serrés (voir §2.2 de la refonte "Ma journée v2" : un transfert tendu ne
  // doit jamais s'afficher comme un conflit/en rouge).
  function compterSeveriteConflits(conflits) {
    var overlaps = 0, tight = 0;
    conflits.forEach(function (c) { if (c.chevauchement) overlaps++; else tight++; });
    return { overlaps: overlaps, tight: tight };
  }

  // Deux séances à heure fixe sont compatibles si l'une se termine avant
  // l'ouverture des portes de l'autre (marge `gate` incluse) — peu importe
  // laquelle des deux vient en premier.
  function seancesCompatibles(a, b, gate) {
    var avant = a.start <= b.start ? a : b;
    var apres = avant === a ? b : a;
    return PDF.timeToMinutes(avant.end) <= PDF.timeToMinutes(apres.start) - gate;
  }

  // Chevauchement réel entre deux séances, indépendamment de la marge des
  // portes : contrairement à seancesCompatibles, une simple ouverture de
  // portes déjà passée (mais spectacles qui ne se recouvrent pas dans le
  // temps) n'est PAS considérée comme un vrai conflit ici — seul un
  // recouvrement effectif des deux séances l'est.
  function seancesSeChevauchent(a, b) {
    var avant = a.start <= b.start ? a : b;
    var apres = avant === a ? b : a;
    return PDF.timeToMinutes(avant.end) > PDF.timeToMinutes(apres.start);
  }

  // Marge entre deux séances consécutives À HEURE FIXE (la précédente, la
  // suivante) : négative = vrai chevauchement.
  function margeMinutes(avant, apres) {
    return PDF.timeToMinutes(apres.start) - PDF.timeToMinutes(avant.end);
  }

  /* ----------------------------------------------------------------------
   * Génération automatique d'un planning
   * -------------------------------------------------------------------- */

  // Construit une proposition de journée sans conflit à partir des horaires
  // officiels d'une date. Les attractions en continu sont toujours incluses
  // (jamais en conflit entre elles) et les séances "complet" toujours
  // écartées (impossible d'y assister). Deux modes pour les séances à
  // heure fixe, selon `mandatorySlugs` :
  //
  // - Aucun spectacle coché ("proposition libre") : on en case le plus
  //   grand nombre possible, glouton classique trié par heure de fin.
  // - Des spectacles cochés ("proposition précise") : on case UNIQUEMENT
  //   ceux-là (une séance chacune), rien d'autre — pas de remplissage avec
  //   des spectacles non demandés. La stratégie "le plus contraint
  //   d'abord" (comme pour une grille de sudoku : caser en premier le
  //   spectacle qui a le moins de séances encore possibles, puis choisir
  //   pour lui la séance qui gêne le moins les autres) donne de bien
  //   meilleurs résultats qu'un simple tri par heure de fin, qui peut
  //   sacrifier un spectacle à séance unique au profit d'un autre qui,
  //   lui, avait une séance de repli plus tard dans la journée.
  //
  //   En mode précis, une séance dont les portes sont déjà ouvertes quand
  //   la précédente n'est pas encore finie (marge `gate` non respectée)
  //   n'est PAS écartée pour autant : seul un vrai chevauchement des deux
  //   séances l'empêche. C'est exactement la même tolérance que pour un
  //   ajout manuel ou depuis le programme officiel, qui n'a jamais bloqué
  //   ce cas — juste affiché le badge "⚠️ Portes justes" une fois dans la
  //   frise. On privilégie quand même les séances bien espacées quand un
  //   choix existe (voir le calcul de `genes` ci-dessous).
  function buildAutoPlan(slots, gate, mandatorySlugs) {
    mandatorySlugs = mandatorySlugs || [];
    var continus = slots.filter(function (s) { return s.is_continuous && s.status !== "complet"; });
    var fixesAll = slots.filter(function (s) { return !s.is_continuous && s.start && s.end && s.status !== "complet"; });

    if (!mandatorySlugs.length) {
      var fixesTries = fixesAll.slice().sort(function (a, b) { return a.end.localeCompare(b.end); });
      var choisisLibre = [];
      var finPrecedente = null;
      fixesTries.forEach(function (s) {
        var portes = PDF.timeToMinutes(s.start) - gate;
        if (finPrecedente == null || PDF.timeToMinutes(finPrecedente) <= portes) {
          choisisLibre.push(s);
          finPrecedente = s.end;
        }
      });
      choisisLibre.sort(function (a, b) { return a.start.localeCompare(b.start); });
      return continus.concat(choisisLibre);
    }

    // Options encore possibles pour chaque spectacle demandé.
    var options = {};
    mandatorySlugs.forEach(function (slug) {
      options[slug] = fixesAll.filter(function (s) { return s.slug === slug; });
    });

    var choisis = [];
    var aTraiter = mandatorySlugs.slice();
    while (aTraiter.length) {
      // Le plus contraint d'abord (le moins d'options restantes).
      aTraiter.sort(function (a, b) { return options[a].length - options[b].length; });
      var slug = aTraiter.shift();
      var candidats = options[slug];
      if (!candidats.length) continue; // aucune séance ce jour-là, ou plus aucune compatible

      // Parmi ses séances encore possibles, celle qui élimine le moins
      // d'options aux autres spectacles restants (à égalité : la plus tôt,
      // pour laisser le plus de marge sur le reste de la journée).
      var meilleure = null, moinsDeGenes = Infinity;
      candidats.forEach(function (c) {
        var genes = 0;
        aTraiter.forEach(function (slug2) {
          options[slug2].forEach(function (s) { if (!seancesCompatibles(c, s, gate)) genes++; });
        });
        if (genes < moinsDeGenes || (genes === moinsDeGenes && c.end < meilleure.end)) {
          meilleure = c;
          moinsDeGenes = genes;
        }
      });

      choisis.push(meilleure);
      aTraiter.forEach(function (slug2) {
        options[slug2] = options[slug2].filter(function (s) { return !seancesSeChevauchent(meilleure, s); });
      });
    }

    choisis.sort(function (a, b) { return a.start.localeCompare(b.start); });
    return continus.concat(choisis);
  }

  // Pour un spectacle demandé qui n'a pas pu être casé : chacune de ses
  // séances possibles ce jour-là, et le(s) spectacle(s) déjà casés qu'il
  // faudrait retirer pour lui faire de la place.
  function optionsPourManquant(slug, slots, gate, planItems) {
    var candidats = slots.filter(function (s) {
      return !s.is_continuous && s.start && s.end && s.status !== "complet" && s.slug === slug;
    });
    var fixesPlan = planItems.filter(function (it) { return !it.is_continuous && it.start && it.end; });
    return candidats.map(function (c) {
      return {
        start: c.start, end: c.end,
        blockers: fixesPlan.filter(function (it) { return seancesSeChevauchent(it, c); }),
      };
    });
  }

  // Spectacles demandés absents du planning actuel, avec pour chacun les
  // choix possibles pour l'y intégrer quand même (voir optionsPourManquant).
  // `catalogueBySlug` sert juste à afficher un nom lisible.
  function analyserManques(mandatorySlugs, slots, gate, planItems, catalogueBySlug) {
    var presents = {};
    planItems.forEach(function (it) { if (it.slug) presents[it.slug] = true; });
    return mandatorySlugs
      .filter(function (slug) { return !presents[slug]; })
      .map(function (slug) {
        return {
          slug: slug,
          name: catalogueBySlug && catalogueBySlug[slug] ? catalogueBySlug[slug].name : slug,
          options: optionsPourManquant(slug, slots, gate, planItems),
        };
      });
  }

  /* ----------------------------------------------------------------------
   * Calendrier de sélection de date
   * -------------------------------------------------------------------- */

  // Classes/titre d'une case du calendrier de sélection de date : tous les
  // jours restent cliquables (un plan manuel reste possible même sans
  // programme officiel connu) ; seul un badge visuel distingue ceux pour
  // lesquels un programme officiel est disponible.
  function planDayCellInfo(record, isSelected, dateStr) {
    var hasData = !!record;
    var isClosed = hasData && (record.status === "closed_day" || record.status === "out_of_season");
    var isPrivate = hasData && record.status === "private_event";
    var cls = "cal-day" + (hasData ? " has-data" : "") + (isClosed ? " is-closed" : "") + (isPrivate ? " is-private" : "") + (isSelected ? " is-selected" : "");
    var title = isClosed
      ? "Puy du Fou fermé le " + PDF.formatDateFR(dateStr)
      : isPrivate
      ? "Privatisation probable le " + PDF.formatDateFR(dateStr) + " — programme réel disponible, hors statistiques"
      : PDF.formatDateFR(dateStr) + (hasData ? " — programme officiel disponible" : " — pas de programme officiel connu (ajout manuel possible)");
    return { cls: cls, disabled: false, title: title };
  }

  /* ----------------------------------------------------------------------
   * Durées
   * -------------------------------------------------------------------- */

  // Minutes depuis minuit -> "HH:MM" (inverse de PDF.timeToMinutes), avec
  // repli circulaire si la marge fait passer avant minuit (cas limite
  // improbable vu les horaires réels du parc, géré par prudence).
  function minutesToHHMM(mins) {
    mins = ((mins % 1440) + 1440) % 1440;
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  // Durée totale des séances à heure fixe (les attractions en continu n'ont
  // pas de "temps de spectacle" ponctuel à additionner).
  function dureeTotaleMinutes(fixes) {
    return fixes.reduce(function (sum, it) {
      var d = PDF.timeToMinutes(it.end) - PDF.timeToMinutes(it.start);
      if (d < 0) d += 24 * 60;
      return sum + d;
    }, 0);
  }

  function formatDureeHeuresMinutes(totalMin) {
    var h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? h + " h " + String(m).padStart(2, "0") : m + " min";
  }

  /* ----------------------------------------------------------------------
   * Export .ics (RFC 5545) de la journée composée
   * -------------------------------------------------------------------- */

  // "2026-08-26" + "10:45" -> "20260826T104500" (heure locale, sans "Z" ni
  // TZID : le spectacle a lieu en France quel que soit le fuseau du
  // visiteur qui exporte — le cas d'usage n'est jamais "je consulte à
  // distance", toujours "j'y serai").
  function icsDateTime(dateStr, hhmm) {
    return dateStr.replace(/-/g, "") + "T" + hhmm.replace(":", "") + "00";
  }

  // Construit le contenu d'un fichier .ics à partir des items d'une journée
  // composée : un VEVENT par spectacle, avec un rappel (VALARM) à l'heure
  // d'ouverture des portes pour les séances à heure fixe (aucun sens pour
  // les attractions en continu, sans file d'attente). `uidFn` génère l'UID
  // d'un item qui n'en a pas encore (ex: ajout manuel jamais sauvegardé) —
  // injecté par l'appelant plutôt que de dépendre de PDF.carnetUid ici,
  // pour que cette fonction reste testable sans stub d'aléatoire.
  function buildIcs(dateStr, items, gate, now, uidFn) {
    var dtstamp = PDF.icsUtcStamp(now || new Date());
    var lignes = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Puy du Fou Companion//Carnet//FR", "CALSCALE:GREGORIAN"];
    items.forEach(function (it) {
      if (!it.start) return; // rien d'exploitable sans heure de début
      var fin = it.end || minutesToHHMM(PDF.timeToMinutes(it.start) + 30);
      var description = it.is_continuous
        ? "Accès en continu."
        : "Ouverture des portes : " + PDF.formatTimeFR(minutesToHHMM(PDF.timeToMinutes(it.start) - gate)) + ".";
      description += "\nAjouté depuis Mon carnet — Puy du Fou (non officiel).";

      lignes.push("BEGIN:VEVENT");
      lignes.push("UID:" + (it.uid || (uidFn ? uidFn() : PDF.carnetUid())) + "@puydufou-companion");
      lignes.push("DTSTAMP:" + dtstamp);
      lignes.push("DTSTART:" + icsDateTime(dateStr, it.start));
      lignes.push("DTEND:" + icsDateTime(dateStr, fin));
      lignes.push("SUMMARY:" + PDF.icsEscape(it.name));
      lignes.push("DESCRIPTION:" + PDF.icsEscape(description));
      lignes.push("LOCATION:" + PDF.icsEscape("Puy du Fou"));
      if (!it.is_continuous) {
        lignes.push("BEGIN:VALARM");
        lignes.push("ACTION:DISPLAY");
        lignes.push("DESCRIPTION:Ouverture des portes");
        lignes.push("TRIGGER:-PT" + Math.max(0, gate) + "M");
        lignes.push("END:VALARM");
      }
      lignes.push("END:VEVENT");
    });
    lignes.push("END:VCALENDAR");
    return lignes.join("\r\n");
  }

  var dayPlan = {
    realDayToSlots: realDayToSlots,
    probableToSlots: probableToSlots,
    itemsFixesTries: itemsFixesTries,
    detecterConflits: detecterConflits,
    severiteConflit: severiteConflit,
    conflitChevauchementAvec: conflitChevauchementAvec,
    compterSeveriteConflits: compterSeveriteConflits,
    seancesCompatibles: seancesCompatibles,
    seancesSeChevauchent: seancesSeChevauchent,
    margeMinutes: margeMinutes,
    buildAutoPlan: buildAutoPlan,
    optionsPourManquant: optionsPourManquant,
    analyserManques: analyserManques,
    planDayCellInfo: planDayCellInfo,
    minutesToHHMM: minutesToHHMM,
    dureeTotaleMinutes: dureeTotaleMinutes,
    formatDureeHeuresMinutes: formatDureeHeuresMinutes,
    icsDateTime: icsDateTime,
    buildIcs: buildIcs,
  };

  window.PDF = window.PDF || {};
  window.PDF.dayPlan = dayPlan;

  // Exposé pour les tests (tests/frontend/) — no-op dans un navigateur.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = dayPlan;
  }
})();
