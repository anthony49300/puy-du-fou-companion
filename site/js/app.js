/* =========================================================================
   Puy du Fou — Programmes & Statistiques (projet communautaire non officiel)
   app.js — utilitaires communs : chargement des données, formatage,
   header/nav/footer injectés, mode sombre, menu mobile, recherche.
   ========================================================================= */

(function (global) {
  "use strict";

  /* ----------------------------------------------------------------------
   * 1. Emplacement des données
   *    Centralisé ici : le site vit dans site/ et les JSON dans data/json/
   *    (dossiers frères). Ne JAMAIS utiliser de chemin absolu ("/...")
   *    car le site est aussi déployé sous un sous-chemin GitHub Pages.
   * -------------------------------------------------------------------- */
  const DATA_BASE = "../data/json/";
  const GITHUB_REPO_URL = "https://github.com/anthony49300/puy-du-fou-companion";

  /**
   * Charge un fichier JSON relatif à DATA_BASE (ex: "today.json",
   * "history/2026-08-25.json").
   * Retourne une Promise qui résout les données, ou lève une erreur
   * enrichie (avec un flag notFound pour les 404).
   */
  /**
   * Chemin du fichier d'historique détaillé d'une date, rangé par année de
   * saison ("history/2026/2026-08-26.json") plutôt qu'à plat, pour ne pas
   * accumuler des milliers de fichiers dans un seul dossier au fil des
   * saisons. `seasonYear` vient idéalement de dates.json (season_year) ;
   * à défaut (donnée absente), on retombe sur l'année calendaire de la
   * date elle-même — correct dans l'immense majorité des cas (l'unique
   * exception étant une date de fin d'année rattachée à la saison
   * suivante, cf. src/collector.py).
   */
  function historyJsonPath(dateStr, seasonYear) {
    var year = seasonYear || String(dateStr).slice(0, 4);
    return "history/" + year + "/" + dateStr + ".json";
  }

  function fetchJSON(name) {
    const url = DATA_BASE + name;
    return fetch(url, { cache: "no-store" }).then((res) => {
      if (!res.ok) {
        const err = new Error(
          "Impossible de charger " + name + " (HTTP " + res.status + ")"
        );
        err.notFound = res.status === 404;
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  /* ----------------------------------------------------------------------
   * 2. Formatage des dates / heures en français
   * -------------------------------------------------------------------- */

  // "2026-08-26" -> Date (UTC-safe, éviter les décalages de fuseau)
  function parseISODate(dateStr) {
    if (!dateStr) return null;
    const parts = String(dateStr).split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  // "2026-08-26" -> "26/08/2026"
  function formatDateFR(dateStr) {
    const d = parseISODate(dateStr);
    if (!d) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return dd + "/" + mm + "/" + yyyy;
  }

  // "2026-08-26" -> "mercredi 26 août 2026"
  function formatDateLongFR(dateStr) {
    const d = parseISODate(dateStr);
    if (!d) return "—";
    return d.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  // ISO datetime ("2026-08-26T08:15:00+02:00") -> "26/08/2026 à 08:15"
  function formatDateTimeFR(isoStr) {
    if (!isoStr) return "—";
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return "—";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return dd + "/" + mm + "/" + yyyy + " à " + hh + ":" + min;
  }

  // "11:30" ou "11:30:00" -> "11h30"
  function formatTimeFR(timeStr) {
    if (!timeStr) return "—";
    const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return timeStr;
    return m[1].padStart(2, "0") + "h" + m[2];
  }

  // Un nombre à décimales inséré tel quel (JS -> chaîne) garde un point
  // ("5.85"), jamais une virgule française — sans conséquence pour un
  // calcul, mais visible dès qu'il atterrit dans l'UI (stats "Moyenne /
  // jour"...). Ici pour TOUT nombre affiché, pas seulement les devises
  // (déjà couvertes par eur(), carnet.js).
  function formatNumberFR(n, options) {
    if (n == null || typeof n !== "number" || isNaN(n)) return "—";
    return new Intl.NumberFormat("fr-FR", options).format(n);
  }

  /* ----------------------------------------------------------------------
   * 2bis. Heure/date réelle du visiteur (horloge du navigateur)
   *    Les fichiers JSON sont des exports statiques, figés au moment de la
   *    dernière collecte automatique : ils NE savent PAS quelle heure/date
   *    il est réellement pour la personne qui consulte le site. Toute
   *    notion de "aujourd'hui"/"maintenant"/"prochain spectacle" côté
   *    interface doit se recaler sur l'horloge du navigateur plutôt que de
   *    se fier tel quel au contenu du JSON.
   * -------------------------------------------------------------------- */

  // Date réelle du navigateur au format ISO "YYYY-MM-DD" (fuseau local).
  function isoDateToday() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  // Le programme chargé (today.json) correspond-il réellement à la date du
  // jour pour le visiteur ? Peut être faux même si status="ok" : "ok"
  // signifie seulement que la DERNIÈRE collecte a réussi, pas qu'elle date
  // d'aujourd'hui (ex: runner de collecte indisponible depuis plusieurs
  // jours).
  function isDataForToday(dateStr) {
    return !!dateStr && dateStr === isoDateToday();
  }

  // "HH:MM" -> minutes depuis minuit, ou null si invalide/absent (plage
  // "en continu" par exemple).
  function timeToMinutes(timeStr) {
    if (!timeStr) return null;
    const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  /**
   * Calcule, à partir de l'heure RÉELLE actuelle du navigateur (ou de `now`
   * si fourni — un `Date` injecté, pour des tests déterministes), l'état
   * "en direct" du programme du jour dans `today.spectacles` (à n'utiliser
   * que si `isDataForToday(today.date)` est vrai). Contrairement aux champs
   * figés au moment de l'export côté serveur (ex: "nocturne" du JSON), ceci
   * reste exact tout au long de la journée même sans nouvelle collecte.
   *
   * Retourne :
   * - next : la toute prochaine représentation (toutes catégories, hors
   *   accès continu), ou null s'il n'y en a plus aujourd'hui ;
   * - inProgress : les représentations EN COURS en ce moment (hors accès
   *   continu : un spectacle en accès continu n'est pas une "séance" qu'on
   *   peut manquer, déjà visible ailleurs sur la page) ;
   * - withinHour : les représentations à venir dans les 60 prochaines
   *   minutes (max 5, triées par heure) ;
   * - nocturne : la prochaine représentation du spectacle nocturne du jour ;
   * - lastShowingSlugs : les slugs des spectacles dont la PROCHAINE
   *   représentation à venir (et seulement celle-là : si une autre suit
   *   plus tard dans la journée, ce spectacle n'y figure pas) est aussi
   *   leur dernière de la journée — pour le badge "Dernière séance" sur la
   *   ligne de cette représentation précise.
   */
  function computeUpcoming(today, now) {
    now = now || new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const slots = [];
    (today.spectacles || []).forEach((spectacle) => {
      (spectacle.representations || []).forEach((rep) => {
        const startMins = timeToMinutes(rep.start);
        const endMins = timeToMinutes(rep.end);
        slots.push({ spectacle, rep, startMins, endMins });
      });
    });

    const toItem = (slot) =>
      slot && {
        name: slot.spectacle.name,
        slug: slot.spectacle.slug,
        category: slot.spectacle.category,
        start: slot.rep.start,
        end: slot.rep.end,
        is_continuous: !!slot.rep.is_continuous,
      };

    const inProgress = slots
      .filter((s) => !s.rep.is_continuous && s.startMins != null && s.endMins != null && s.startMins <= nowMinutes && nowMinutes < s.endMins)
      .sort((a, b) => a.startMins - b.startMins)
      .map(toItem);

    const upcomingSlots = slots
      .filter((s) => !s.rep.is_continuous && s.startMins != null && s.startMins >= nowMinutes)
      .sort((a, b) => a.startMins - b.startMins);

    const next = toItem(upcomingSlots[0]);
    const nocturne = toItem(upcomingSlots.find((s) => s.spectacle.category === "spectacle_nocturne"));
    const withinHour = upcomingSlots.filter((s) => s.startMins - nowMinutes <= 60).slice(0, 5).map(toItem);

    // Dernière représentation de la journée, par spectacle (toutes heures
    // confondues, pas seulement celles à venir)...
    const lastStartBySlug = {};
    slots.forEach((s) => {
      if (s.rep.is_continuous || s.startMins == null) return;
      const slug = s.spectacle.slug;
      if (lastStartBySlug[slug] == null || s.startMins > lastStartBySlug[slug]) {
        lastStartBySlug[slug] = s.startMins;
      }
    });
    // ...comparée à la PROCHAINE représentation à venir de ce spectacle
    // (la première rencontrée dans upcomingSlots, déjà trié par heure) :
    // si une autre suit plus tard le même jour, ce n'est pas "la dernière"
    // du point de vue de cette représentation précise, même si le spectacle
    // a par ailleurs une dernière séance plus tard.
    const firstUpcomingBySlug = {};
    upcomingSlots.forEach((s) => {
      const slug = s.spectacle.slug;
      if (firstUpcomingBySlug[slug] == null) firstUpcomingBySlug[slug] = s.startMins;
    });
    const lastShowingSlugs = Object.keys(firstUpcomingBySlug).filter(
      (slug) => firstUpcomingBySlug[slug] === lastStartBySlug[slug]
    );

    return { next: next || null, inProgress, withinHour, nocturne: nocturne || null, lastShowingSlugs };
  }

  /* ----------------------------------------------------------------------
   * 3. Normalisation de texte pour la recherche
   *    (minuscule + suppression des accents + trim des espaces)
   * -------------------------------------------------------------------- */
  function normalizeStr(str) {
    if (!str) return "";
    return String(str)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchesSearch(name, query) {
    if (!query) return true;
    return normalizeStr(name).includes(normalizeStr(query));
  }

  /* ----------------------------------------------------------------------
   * 4. Catégories & badges
   * -------------------------------------------------------------------- */
  const CATEGORY_LABELS = {
    spectacle: "Spectacle",
    spectacle_nocturne: "Spectacle nocturne",
    spectacle_immersif: "Spectacle immersif",
    autre: "Autre",
  };

  function categoryLabel(cat) {
    return CATEGORY_LABELS[cat] || "Autre";
  }

  const STATUS_LABELS = {
    scheduled: "Programmé",
    complet: "Complet",
    exceptionnel: "Exceptionnel",
    unknown: "Statut inconnu",
  };

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => {
      return (
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c] || c
      );
    });
  }

  /**
   * Détermine si une heure ("HH:MM") est considérée "nocturne" (tardive).
   */
  function isLateHour(timeStr) {
    if (!timeStr) return false;
    const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return false;
    const h = parseInt(m[1], 10);
    return h >= 21 || h < 5;
  }

  /**
   * Construit la liste de badges HTML applicables à une représentation.
   * rep: {start, end, is_continuous, status, source_text}
   * spectacleCategory: catégorie du spectacle parent
   */
  function representationBadges(rep, spectacleCategory) {
    const badges = [];
    if (
      spectacleCategory === "spectacle_nocturne" ||
      isLateHour(rep && rep.start)
    ) {
      badges.push(badgeHtml("Nocturne", "nocturne"));
    }
    if (rep && rep.is_continuous) {
      badges.push(badgeHtml("En continu", "continu"));
    }
    if (rep) {
      if (rep.status === "complet") badges.push(badgeHtml("Complet", "complet"));
      else if (rep.status === "exceptionnel")
        badges.push(badgeHtml("Exceptionnel", "exceptionnel"));
    }
    return badges.join(" ");
  }

  function badgeHtml(label, variant) {
    const cls =
      {
        nocturne: "badge-nocturne",
        continu: "badge-continu",
        complet: "badge-complet",
        exceptionnel: "badge-exceptionnel",
      }[variant] || "badge-default";
    return (
      '<span class="badge ' + cls + '">' + escapeHtml(label) + "</span>"
    );
  }

  function categoryBadgeHtml(cat) {
    const variant = cat === "spectacle_nocturne" ? "nocturne" : null;
    if (variant) return badgeHtml(categoryLabel(cat), variant);
    return (
      '<span class="badge badge-default">' + escapeHtml(categoryLabel(cat)) + "</span>"
    );
  }

  /* ----------------------------------------------------------------------
   * 5. Statut de collecte (badge accueil / bannière)
   * -------------------------------------------------------------------- */
  function statusBannerHtml(status, dateStr, hasData, checkFreshness) {
    // hasData: le payload contient-il au moins une représentation ? Permet de
    // distinguer "aucune collecte n'a encore eu lieu" (premier déploiement,
    // avant toute exécution de la GitHub Action) de "la collecte a échoué
    // mais d'anciennes données fiables restent affichées". Les deux ont le
    // statut "error" côté export, mais le message ne doit jamais prétendre
    // qu'il existe des données antérieures si ce n'est pas le cas.
    const dateFR = formatDateFR(dateStr);
    // checkFreshness : à activer UNIQUEMENT sur les pages qui prétendent
    // représenter "aujourd'hui" (accueil, programme du jour) — jamais sur
    // une page d'historique où afficher une date différente d'aujourd'hui
    // est normal et voulu, pas un signe de péremption.
    //
    // "status" ne reflète que le résultat de la DERNIÈRE collecte exécutée
    // (succès/échec) — il ne dit rien sur la fraîcheur de cette collecte
    // par rapport à la date réelle du visiteur. Un site dont la collecte
    // automatique est à l'arrêt depuis plusieurs jours aurait donc, sans ce
    // contrôle, affiché indéfiniment "Collecte à jour" avec une date de
    // plus en plus périmée.
    if (checkFreshness && (status === "ok" || status === "partial") && !isDataForToday(dateStr)) {
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🕰️</span>' +
        "<span>Dernières données disponibles : " + dateFR +
        " — pas celles d'aujourd'hui (" + formatDateFR(isoDateToday()) +
        "). La collecte automatique n'a pas tourné depuis.</span></div>"
      );
    }
    if (status === "ok" || status === "partial") {
      return (
        '<div class="status-banner status-ok"><span aria-hidden="true">✅</span>' +
        "<span>Collecte à jour — données du " + dateFR + ".</span></div>"
      );
    }
    if (status === "error") {
      if (hasData) {
        return (
          '<div class="status-banner status-error"><span aria-hidden="true">⚠️</span>' +
          "<span>Dernière collecte en erreur — affichage des dernières données fiables du " +
          dateFR +
          ".</span></div>"
        );
      }
      return (
        '<div class="status-banner status-error"><span aria-hidden="true">⏳</span>' +
        "<span>Aucune collecte n'a encore été effectuée pour le moment. Revenez après la prochaine " +
        "exécution automatique du programme.</span></div>"
      );
    }
    if (status === "out_of_season") {
      // Cas normal (parc fermé pour la saison), pas une erreur : voir
      // seasonClosedBannerHtml, qui construit un message plus précis
      // (date de réouverture) à partir de next_opening. Ce repli générique
      // ne sert que si l'appelant utilise statusBannerHtml directement
      // sans passer par seasonClosedBannerHtml.
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🌙</span>' +
        "<span>Parc fermé pour la saison — dernières données du " + dateFR + ".</span></div>"
      );
    }
    if (status === "closed_day") {
      // Fermeture ponctuelle EN saison (constatée sur la source pour CETTE
      // date précise), pas de saison entière : voir DATE_STATUS_CLOSED_DAY
      // côté backend. À distinguer de "out_of_season" (plage de dates
      // configurée) même si le rendu est volontairement similaire.
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🚧</span>' +
        "<span>Le Puy du Fou est fermé le " + dateFR + ".</span></div>"
      );
    }
    if (status === "private_event") {
      // Voir DATE_STATUS_PRIVATE_EVENT côté backend : repli générique pour
      // les appelants qui n'utilisent pas seasonClosedBannerHtml (ex: une
      // date passée consultée sur la page Historique).
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🎪</span>' +
        "<span>Le " + dateFR + ", le parc n'est normalement pas ouvert au public à cette période — probable privatisation. Exclu des statistiques officielles.</span></div>"
      );
    }
    if (status === "stale") {
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🕰️</span>' +
        "<span>Données potentiellement périmées — dernière mise à jour connue du " +
        dateFR +
        ".</span></div>"
      );
    }
    return "";
  }

  /**
   * Bannière spécifique "parc fermé pour la saison", avec la date de
   * réouverture quand elle est connue (`payload.next_opening`, voir
   * l'export today.json). Retourne null si le payload ne correspond pas à
   * ce cas (l'appelant se rabat alors sur statusBannerHtml). Séparée de
   * statusBannerHtml pour ne pas surcharger sa signature avec un
   * paramètre supplémentaire propre à ce seul cas.
   */
  function seasonClosedBannerHtml(payload) {
    if (!payload) return null;
    if (payload.status === "out_of_season") {
      const message = payload.next_opening
        ? "Saison terminée — réouverture prévue le " + formatDateLongFR(payload.next_opening) + "."
        : "Saison terminée — date de réouverture pas encore annoncée.";
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🌙</span>' +
        "<span>" + escapeHtml(message) + "</span></div>"
      );
    }
    if (payload.status === "closed_day") {
      // Fermeture ponctuelle EN saison (voir DATE_STATUS_CLOSED_DAY) : même
      // logique que ci-dessus mais avec la date du jour fermé lui-même,
      // pas seulement celle de réouverture (utile même quand elle est
      // inconnue) — voir next_opening_date côté export (src/exporter.py).
      const message = payload.next_opening
        ? "Fermé le " + formatDateLongFR(payload.date) + " — prochaine ouverture le " + formatDateLongFR(payload.next_opening) + "."
        : "Le Puy du Fou est fermé le " + formatDateLongFR(payload.date) + ".";
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🚧</span>' +
        "<span>" + escapeHtml(message) + "</span></div>"
      );
    }
    if (payload.status === "private_event") {
      // Le parc n'est normalement pas ouvert au public à cette période
      // (voir DATE_STATUS_PRIVATE_EVENT, data/planned_closures.json), mais
      // un vrai programme a été constaté : probable privatisation. Le
      // programme du jour reste affiché normalement (voir le reste de la
      // page) — ce bandeau prévient juste que ces données sont hors
      // statistiques officielles (voir src/statistics.py).
      return (
        '<div class="status-banner status-stale"><span aria-hidden="true">🎪</span>' +
        "<span>Le " + escapeHtml(formatDateFR(payload.date)) + ", le parc n'est normalement pas ouvert au public à cette période — probable privatisation (événement privé). Programme réel ci-dessous, mais exclu des statistiques officielles.</span></div>"
      );
    }
    return null;
  }

  /* ----------------------------------------------------------------------
   * 5bis. Mini calendrier mensuel (composant réutilisable)
   *       Utilisé par Historique (navigation + comparateur) et par le
   *       composeur de journée du Carnet.
   * -------------------------------------------------------------------- */
  const DOW_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const MONTH_LABELS = [
    "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
  ];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function isoDate(y, m, d) {
    return y + "-" + pad2(m + 1) + "-" + pad2(d);
  }

  // Rendu générique d'un mini-calendrier mensuel dans `containerId`, sans
  // état propre : year/month/selectedDate sont fournis par l'appelant, qui
  // reste responsable de son propre état (plusieurs calendriers indépendants
  // peuvent coexister sur une même page, voir le comparateur d'Historique).
  //
  // `dayCellInfo(dateMap[dateStr], isSelected, dateStr)` décide, par jour,
  // des classes CSS/titre/désactivation — propre à chaque page (Historique
  // grise les jours sans donnée, le Carnet les laisse tous cliquables).
  function renderMiniCalendar(containerId, year, month, dateMap, selectedDate, dayCellInfo, onSelect, onNav) {
    const wrap = document.getElementById(containerId);
    const firstOfMonth = new Date(year, month, 1);
    const startOffset = (firstOfMonth.getDay() + 6) % 7; // lundi = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let html = '<div class="calendar-head">' +
      '<button type="button" class="cal-nav-prev" aria-label="Mois précédent">‹</button>' +
      '<span class="calendar-title">' + MONTH_LABELS[month] + " " + year + "</span>" +
      '<button type="button" class="cal-nav-next" aria-label="Mois suivant">›</button>' +
      "</div>" +
      '<div class="calendar-grid">';

    DOW_LABELS.forEach((d) => { html += '<div class="cal-dow">' + d + "</div>"; });
    for (let i = 0; i < startOffset; i++) html += '<div class="cal-empty"></div>';

    let anyClosed = false;
    let anyPrivate = false;
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = isoDate(year, month, day);
      const info = dayCellInfo(dateMap[dateStr], dateStr === selectedDate, dateStr);
      if (info.cls.indexOf("is-closed") !== -1) anyClosed = true;
      if (info.cls.indexOf("is-private") !== -1) anyPrivate = true;
      html +=
        '<button type="button" class="' + info.cls + '" data-date="' + dateStr + '"' +
        (info.disabled ? " disabled" : "") +
        ' title="' + info.title + '">' +
        day + "</button>";
    }
    html += "</div>";
    // Légende des petits points "fermeture"/"privatisation" (voir
    // .cal-day.is-closed/.is-private dans style.css) : affichée seulement
    // quand ce mois en contient au moins un, pas en permanence sur un mois
    // sans rien à expliquer.
    if (anyClosed) {
      html += '<div class="calendar-legend"><span class="cal-legend-dot" aria-hidden="true"></span> Fermeture ponctuelle du parc</div>';
    }
    if (anyPrivate) {
      html += '<div class="calendar-legend"><span class="cal-legend-dot cal-legend-dot-private" aria-hidden="true"></span> Privatisation probable (hors statistiques)</div>';
    }
    wrap.innerHTML = html;

    wrap.querySelector(".cal-nav-prev").addEventListener("click", () => onNav(-1));
    wrap.querySelector(".cal-nav-next").addEventListener("click", () => onNav(1));
    wrap.querySelectorAll("button.cal-day:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => onSelect(btn.getAttribute("data-date")));
    });
  }

  /* ----------------------------------------------------------------------
   * 6. Header / nav / footer injectés
   *
   *    Nouvelle coquille de navigation (refonte "Nocturne/Parchemin") :
   *    - mobile (< 780px) : barre fine en haut (marque + thème + "Plus") et
   *      une barre d'onglets FIXE en bas (5 destinations principales) ;
   *    - desktop (>= 780px) : en-tête horizontal classique (marque, liens,
   *      thème). Les deux variantes sont injectées en même temps et
   *      basculées en CSS (media query) plutôt qu'en JS, pour ne pas avoir
   *      à réagir au redimensionnement de la fenêtre.
   *
   *    Les 3 pages de consultation moins fréquentes (Spectacles,
   *    Historique, Bilan) restent groupées sous "Explorer" : un même
   *    panneau (#nav-explore-dropdown) sert de menu déroulant ancré sous le
   *    bouton en desktop, et de feuille ("sheet") remontant du bas en
   *    mobile — seul le CSS diffère, le JS d'ouverture/fermeture est
   *    partagé (voir initNavDropdown).
   * -------------------------------------------------------------------- */
  const NAV_PRIMARY = [
    { key: "index", page: "index", href: "index.html", label: "Aujourd'hui", icon: "home" },
    { key: "programme", page: "programme", href: "programme.html", label: "Programme", icon: "scroll" },
    { key: "carnet-journee", page: "carnet", tab: "jour", href: "carnet.html#journee", label: "Ma journée", icon: "map-route" },
    { key: "carnet-visites", page: "carnet", tab: "autre", href: "carnet.html#visites", label: "Carnet", icon: "book" },
    { key: "statistiques", page: "statistiques", href: "statistiques.html", label: "Stats", icon: "chart-bar" },
  ];
  // Regroupées sous "Explorer" : pages de consultation/données, moins
  // fréquentées au quotidien — évite une nav à 8 entrées à plat.
  const NAV_EXPLORE = [
    { page: "spectacles", href: "spectacles.html", label: "Spectacles" },
    { page: "historique", href: "historique.html", label: "Historique" },
    { page: "bilan", href: "bilan.html", label: "Bilan" },
  ];
  // "#journee" -> onglet "jour" (clé interne déjà utilisée par carnet.js) ;
  // les 3 autres ancres gardent le même nom que l'onglet. Pas de hash du
  // tout = état par défaut du HTML de carnet.html, c'est-à-dire "jour".
  const CARNET_HASH_TO_TAB = { journee: "jour", visites: "visites", bilan: "bilan", pass: "pass" };

  function currentCarnetTab() {
    const hash = (global.location.hash || "").replace(/^#/, "");
    return CARNET_HASH_TO_TAB[hash] || "jour";
  }

  // Un item de nav "carnet" a deux variantes (Ma journée / Carnet) qui
  // partagent la même page mais pas le même onglet : il faut donc regarder
  // le hash en plus de data-page pour savoir laquelle est active.
  function isNavItemActive(item, activePage) {
    if (item.page !== "carnet") return item.page === activePage;
    if (activePage !== "carnet") return false;
    const tab = currentCarnetTab();
    return item.tab === "jour" ? tab === "jour" : tab !== "jour";
  }

  function primaryItemHtml(item, activePage, cls) {
    const active = isNavItemActive(item, activePage);
    return (
      '<a href="' + item.href + '" class="' + cls + (active ? " active" : "") + '" data-nav-key="' + item.key + '"' +
      (active ? ' aria-current="page"' : "") +
      ">" + PDF.icon(item.icon) + '<span class="' + (cls === "tabbar-item" ? "tabbar-label" : "nav-link-label") + '">' + item.label + "</span></a>"
    );
  }

  function exploreItemHtml(item, activePage) {
    const active = item.page === activePage;
    return (
      '<a href="' + item.href + '" class="nav-dropdown-link' + (active ? " active" : "") + '" data-nav-key="' + item.page + '"' +
      (active ? ' aria-current="page"' : "") +
      ">" + item.label + "</a>"
    );
  }

  function buildHeaderHtml(activePage) {
    const isExploreActive = NAV_EXPLORE.some((item) => item.page === activePage);
    const exploreHtml = NAV_EXPLORE.map((item) => exploreItemHtml(item, activePage)).join("");
    const brandLink = '<a href="index.html" class="brand">' + PDF.icon("castle", "brand-emblem") + '<span class="brand-text">Puy du Fou Companion</span></a>';
    const themeBtn = (idSuffix) =>
      '<button type="button" class="icon-btn theme-toggle" id="theme-toggle' + idSuffix + '" ' +
      'aria-label="Basculer le mode sombre / clair" title="Mode sombre / clair"></button>';
    const exploreToggleBtn = (idSuffix, visibleLabel) =>
      '<button type="button" class="nav-explore-toggle' + (isExploreActive ? " active" : "") + '" ' +
      'id="nav-explore-toggle' + idSuffix + '" aria-haspopup="true" aria-expanded="false" ' +
      (visibleLabel ? "" : 'aria-label="Plus de pages"') + ">" +
      (visibleLabel ? "Explorer " + PDF.icon("chevron-down", "nav-caret") : PDF.icon("more-horizontal")) +
      "</button>";

    return (
      '<div class="header-inner">' +
      // ---- Desktop ----
      '<div class="header-row header-desktop">' +
      brandLink +
      '<nav class="main-nav" aria-label="Navigation principale">' +
      NAV_PRIMARY.map((item) => primaryItemHtml(item, activePage, "nav-link")).join("") +
      '<div class="nav-group">' + exploreToggleBtn("-desktop", true) + "</div>" +
      "</nav>" +
      '<div class="header-actions">' +
      '<span class="freshness-note" id="freshness-note"></span>' +
      themeBtn("-desktop") +
      "</div>" +
      "</div>" +
      // ---- Mobile : barre fine ----
      '<div class="header-row header-mobile">' +
      '<a href="index.html" class="brand brand-compact" aria-label="Accueil">' + PDF.icon("castle", "brand-emblem") + "</a>" +
      '<div class="header-actions">' +
      themeBtn("-mobile") +
      exploreToggleBtn("-mobile", false) +
      "</div>" +
      "</div>" +
      // ---- Panneau "Explorer" partagé (dropdown desktop / sheet mobile) ----
      '<div class="nav-dropdown" id="nav-explore-dropdown">' + exploreHtml + "</div>" +
      "</div>"
    );
  }

  function buildTabbarHtml(activePage) {
    return (
      '<nav class="tabbar" id="bottom-tabbar" aria-label="Navigation principale">' +
      NAV_PRIMARY.map((item) => primaryItemHtml(item, activePage, "tabbar-item")).join("") +
      "</nav>"
    );
  }

  function buildFooterHtml() {
    const year = new Date().getFullYear();
    return (
      '<div class="footer-inner">' +
      '<div class="footer-block">' +
      '<div class="footer-disclaimer">' + PDF.icon("alert-triangle") +
      "<span>Projet communautaire non officiel — données issues du programme officiel du Puy du Fou. Ce site n'est ni édité, ni approuvé, ni affilié au Puy du Fou.</span></div>" +
      "<p>Les horaires et informations peuvent évoluer sans préavis. Vérifiez toujours le programme officiel avant votre visite.</p>" +
      "</div>" +
      '<div class="footer-block footer-links">' +
      "<h4>Liens</h4>" +
      '<p><a href="' + GITHUB_REPO_URL + '" target="_blank" rel="noopener noreferrer">' + PDF.icon("package") + " Dépôt GitHub du projet</a></p>" +
      '<p><a href="https://www.puydufou.com" target="_blank" rel="noopener noreferrer">' + PDF.icon("external-link") + " Site officiel du Puy du Fou</a></p>" +
      "<p>© " + year + " — Projet open source communautaire</p>" +
      "</div>" +
      "</div>"
    );
  }

  // Ré-applique juste l'état actif des items de nav déjà rendus (classe +
  // aria-current), sans reconstruire le HTML — appelé après un changement
  // de hash (ex: clic sur un onglet du Carnet) pour que "Ma journée" /
  // "Carnet" restent corrects sans perdre le focus/scroll d'un re-rendu complet.
  function refreshNavActiveStates(activePage) {
    document.querySelectorAll("[data-nav-key]").forEach((el) => {
      const item = NAV_PRIMARY.find((i) => i.key === el.getAttribute("data-nav-key"));
      const active = item ? isNavItemActive(item, activePage) : el.getAttribute("data-nav-key") === activePage;
      el.classList.toggle("active", active);
      if (active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
  }

  // Texte "Non officiel · données du JJ/MM à HH:MM" du header desktop,
  // alimenté par chaque page une fois son today.json/stats chargé (le
  // header, lui, est injecté sans connaître ces données).
  function setFreshnessNote(dateTimeIso) {
    const el = document.getElementById("freshness-note");
    if (!el) return;
    el.textContent = dateTimeIso ? "Non officiel · données du " + formatDateTimeFR(dateTimeIso) : "Non officiel";
  }

  function injectHeaderFooter(activePage) {
    const headerEl = document.getElementById("site-header");
    const footerEl = document.getElementById("site-footer");
    if (headerEl) {
      headerEl.className = "site-header";
      headerEl.innerHTML = buildHeaderHtml(activePage);
    }
    if (footerEl) {
      footerEl.className = "site-footer";
      footerEl.innerHTML = buildFooterHtml();
    }
    // Barre d'onglets mobile : élément à part (position fixed en bas),
    // injecté une seule fois comme enfant direct de <body>.
    let tabbarEl = document.getElementById("bottom-tabbar");
    if (!tabbarEl) {
      document.body.insertAdjacentHTML("beforeend", buildTabbarHtml(activePage));
    } else {
      tabbarEl.outerHTML = buildTabbarHtml(activePage);
    }
    initNavDropdown();
    initThemeToggle();
    global.addEventListener("hashchange", () => refreshNavActiveStates(activePage));
  }

  /* ----------------------------------------------------------------------
   * 7. Panneau "Explorer" (dropdown desktop / sheet mobile, même markup)
   * -------------------------------------------------------------------- */
  function initNavDropdown() {
    const toggles = Array.prototype.slice.call(document.querySelectorAll(".nav-explore-toggle"));
    const dropdown = document.getElementById("nav-explore-dropdown");
    if (!toggles.length || !dropdown) return;

    function close() {
      dropdown.classList.remove("open");
      toggles.forEach((t) => t.setAttribute("aria-expanded", "false"));
    }
    // `right: 1.25rem` (CSS) suppose que le bouton est collé au bord droit
    // de .header-inner — faux en desktop dès que la note de fraîcheur (sa
    // largeur varie selon la page/les données) s'intercale avant le bouton
    // thème. On recalcule donc l'écart réel au clic plutôt que de fixer une
    // valeur CSS qui ne vaudrait que par coïncidence.
    function open(fromToggle) {
      if (fromToggle && fromToggle.id === "nav-explore-toggle-desktop") {
        const headerInner = fromToggle.closest(".header-inner");
        if (headerInner) {
          const toggleRect = fromToggle.getBoundingClientRect();
          const innerRect = headerInner.getBoundingClientRect();
          dropdown.style.right = Math.max(0, innerRect.right - toggleRect.right) + "px";
        }
      } else {
        // Mobile : laisse la media query (right: 0, feuille pleine largeur)
        // reprendre la main plutôt que de garder un décalage desktop périmé.
        dropdown.style.right = "";
      }
      dropdown.classList.add("open");
      toggles.forEach((t) => t.setAttribute("aria-expanded", "true"));
    }

    toggles.forEach((toggle) => {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (dropdown.classList.contains("open")) close();
        else open(toggle);
      });
    });
    document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target) && toggles.indexOf(e.target) === -1) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dropdown.classList.contains("open")) {
        close();
        toggles[0].focus();
      }
    });
  }

  /* ----------------------------------------------------------------------
   * 8. Mode sombre (prefers-color-scheme + toggle localStorage)
   * -------------------------------------------------------------------- */
  const THEME_KEY = "pdf-programmes-theme"; // "light" | "dark"

  function applyStoredTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  }

  function currentEffectiveTheme() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr) return attr;
    return global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function initThemeToggle() {
    const btns = document.querySelectorAll(".theme-toggle");
    if (!btns.length) return;
    btns.forEach((btn) => {
      updateThemeToggleIcon(btn);
      btn.addEventListener("click", () => {
        const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem(THEME_KEY, next);
        btns.forEach(updateThemeToggleIcon);
        // Permet aux pages avec graphiques Chart.js de se redessiner avec les
        // bonnes couleurs (texte/grille) pour le nouveau thème.
        global.dispatchEvent(new CustomEvent("pdf:themechange", { detail: { theme: next } }));
      });
    });
  }

  function updateThemeToggleIcon(btn) {
    const dark = currentEffectiveTheme() === "dark";
    btn.innerHTML = PDF.icon(dark ? "sun" : "moon");
  }

  // Appliquer le thème stocké le plus tôt possible (avant l'injection du header)
  applyStoredTheme();

  /* ----------------------------------------------------------------------
   * 8bis. Couleurs pour les graphiques Chart.js (lit les tokens CSS actifs,
   *       clair ou sombre, pour que les graphiques suivent le thème).
   * -------------------------------------------------------------------- */
  function getChartTheme() {
    const cs = getComputedStyle(document.documentElement);
    const read = (name) => cs.getPropertyValue(name).trim();
    return {
      text: read("--text") || "#2c2118",
      textSoft: read("--text-soft") || "#52453a",
      grid: read("--border-soft") || "#e9dcb9",
      border: read("--border") || "#ddcba4",
      surface: read("--bg-surface") || "#ffffff",
      bordeaux: read("--color-bordeaux") || "#7c2233",
      amber: read("--color-amber") || "#c98a2b",
      forest: read("--color-forest") || "#2f4a3c",
      accent: read("--accent") || "#7c2233",
      accent2: read("--accent-2") || "#c98a2b",
      accent3: read("--accent-3") || "#2f4a3c",
      // Tokens sémantiques de la refonte (voir §2 design tokens) : utiles
      // aux graphiques qui veulent distinguer visuellement une catégorie
      // (spectacle_nocturne, spectacle_immersif) plutôt que de réutiliser
      // l'accent générique pour toutes les séries.
      success: read("--success") || "#2F6B45",
      warn: read("--warn") || "#9A5A0F",
      danger: read("--danger") || "#A3262E",
      night: read("--night") || "#3A4F8C",
      immersive: read("--immersive") || "#2F6B45",
    };
  }

  /* ----------------------------------------------------------------------
   * 8ter. Carnet (plan du jour) : stockage partagé
   *       Le Carnet (carnet.html/carnet.js) reste seul propriétaire de SON
   *       état complet (visites, pass, réglages) et de sa logique de
   *       conflits — mais le bouton "+" de l'accueil et du Programme
   *       (ajouter une séance à la journée) a besoin d'écrire dans LA MÊME
   *       clé localStorage, avec la même règle de dédoublonnage. Plutôt que
   *       de la réécrire ailleurs (voir les 3 bugs de cohérence déjà
   *       rencontrés cette session sur des couples de fichiers qui se
   *       recoupent), ces quelques primitives vivent ici et carnet.js les
   *       appelle lui aussi (voir site/js/carnet.js, charger/sauver/
   *       planItemExists). Ne jettent pas d'erreur transformée : un appelant
   *       qui a besoin de savoir si le stockage a échoué garde son propre
   *       try/catch autour de l'appel (voir carnet.js).
   * -------------------------------------------------------------------- */
  const CARNET_STORAGE_KEY = "pdf-carnet-v1";

  function carnetUid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function loadCarnetState() {
    const raw = localStorage.getItem(CARNET_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function saveCarnetState(state) {
    localStorage.setItem(CARNET_STORAGE_KEY, JSON.stringify(state));
  }

  // Un item "identique" (même spectacle/nom, mêmes horaires) est déjà dans
  // le plan : évite les doublons qu'on clique une fois ou dix, depuis le
  // Carnet, le Programme ou l'accueil (tous passent par cette même règle).
  function planItemExists(plan, candidate) {
    const key = candidate.slug || candidate.name;
    return plan.items.some(
      (it) =>
        (it.slug || it.name) === key &&
        it.start === candidate.start &&
        it.end === candidate.end &&
        !!it.is_continuous === !!candidate.is_continuous
    );
  }

  // Ajoute une représentation au plan du jour `dateStr` (créé si besoin) et
  // sauvegarde, ou ne fait rien si elle y est déjà (voir planItemExists).
  // Retourne false si elle était déjà présente (rien écrit), true sinon.
  function addToPlan(dateStr, item) {
    const state = loadCarnetState() || { visites: [], plans: {}, gate: 30, pass: null };
    if (!state.plans) state.plans = {};
    if (!state.plans[dateStr]) state.plans[dateStr] = { moment: "Jour", items: [] };
    const plan = state.plans[dateStr];
    if (planItemExists(plan, item)) return false;
    plan.items.push(Object.assign({ uid: carnetUid() }, item));
    saveCarnetState(state);
    return true;
  }

  // Une représentation précise (slug/name + heure de début) est-elle déjà
  // dans le plan du jour `dateStr` ? Utilisé pour l'état du bouton "+"
  // (rempli/coché quand déjà ajoutée).
  function isInPlan(dateStr, slugOrName, start) {
    const state = loadCarnetState();
    const plan = state && state.plans && state.plans[dateStr];
    if (!plan) return false;
    return plan.items.some((it) => (it.slug || it.name) === slugOrName && it.start === start);
  }

  // Favoris (chip "Favoris" du Programme, étoile sur chaque séance) : un
  // simple tableau de slugs dans le même état partagé que le plan du jour.
  // Retourne true si le spectacle est désormais favori (false s'il vient
  // d'être retiré).
  function toggleFavorite(slug) {
    const state = loadCarnetState() || { visites: [], plans: {}, gate: 30, pass: null, favoris: [] };
    if (!state.favoris) state.favoris = [];
    const i = state.favoris.indexOf(slug);
    if (i === -1) state.favoris.push(slug);
    else state.favoris.splice(i, 1);
    saveCarnetState(state);
    return i === -1;
  }

  function isFavorite(slug) {
    const state = loadCarnetState();
    return !!(state && state.favoris && state.favoris.indexOf(slug) !== -1);
  }

  // Calendrier scolaire + jours fériés (data/json/calendar.json) : chargé
  // une seule fois par PAGE (pas par composant) et partagé entre
  // spectacles.js ("Horaires habituels") et programme.js ("Programme
  // probable") — dégrade sans erreur (résout `null`) si le fichier est
  // absent, voir site/js/schedule-stats.js pour ce que ça implique côté
  // classification (aucun jour n'est jamais un jour férié/de vacances).
  let _calendarPromise = null;
  function fetchCalendarOnce() {
    if (!_calendarPromise) {
      _calendarPromise = fetchJSON("calendar.json").catch(() => null);
    }
    return _calendarPromise;
  }

  // Même principe pour l'index compact des horaires habituels (voir
  // src/exporter.py:export_schedule_index) : une seule requête par page,
  // quel que soit le nombre de dates consultées dans la session.
  let _scheduleIndexPromise = null;
  function fetchScheduleIndexOnce() {
    if (!_scheduleIndexPromise) {
      _scheduleIndexPromise = fetchJSON("schedule-index.json").catch(() => null);
    }
    return _scheduleIndexPromise;
  }

  // Retire une représentation précise du plan du jour (symétrique
  // d'addToPlan) — utilisé par la vue grille desktop du Programme pour
  // "décocher" une séance déjà ajoutée d'un clic. Retourne false si elle
  // n'y était pas (rien à faire).
  function removeFromPlan(dateStr, slugOrName, start) {
    const state = loadCarnetState();
    const plan = state && state.plans && state.plans[dateStr];
    if (!plan) return false;
    const before = plan.items.length;
    plan.items = plan.items.filter((it) => !((it.slug || it.name) === slugOrName && it.start === start));
    if (plan.items.length === before) return false;
    saveCarnetState(state);
    return true;
  }

  /* ----------------------------------------------------------------------
   * 8quater. Export .ics (RFC 5545) : utilitaires partagés
   *          carnet.js construit un .ics à plusieurs événements (un par
   *          séance planifiée, avec rappel d'ouverture des portes) ; la
   *          carte "jour fermé" de l'accueil n'a besoin que d'un seul
   *          événement journée entière (date de réouverture) — formes trop
   *          différentes pour une seule fonction, mais l'échappement de
   *          texte et l'horodatage UTC, eux, sont identiques : partagés ici.
   * -------------------------------------------------------------------- */
  // Backslash, virgule, point-virgule et retour à la ligne doivent être
  // préfixés d'un backslash (RFC 5545).
  function icsEscape(text) {
    return String(text == null ? "" : text)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");
  }

  // Horodatage UTC "AAAAMMJJTHHMMSSZ" requis par DTSTAMP.
  function icsUtcStamp(date) {
    return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  }

  // Un seul événement "journée entière" (DTSTART;VALUE=DATE, sans heure ni
  // rappel) — ex: réouverture de la saison. `dateStr` au format YYYY-MM-DD.
  function buildAllDayIcs(dateStr, title, description) {
    const compactDate = String(dateStr).replace(/-/g, "");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Puy du Fou Companion//FR", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      "UID:" + carnetUid() + "@puydufou-companion",
      "DTSTAMP:" + icsUtcStamp(new Date()),
      "DTSTART;VALUE=DATE:" + compactDate,
      "SUMMARY:" + icsEscape(title),
    ];
    if (description) lines.push("DESCRIPTION:" + icsEscape(description));
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
  }

  // Déclenche le téléchargement d'un contenu texte (ex: un .ics) sous le
  // nom de fichier donné.
  function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* ----------------------------------------------------------------------
   * 9. Barre de recherche réutilisable
   *    createSearchBar(container, options) -> { getValue, setItems }
   *    options.placeholder, options.onChange(query)
   * -------------------------------------------------------------------- */
  function createSearchBar(container, options) {
    options = options || {};
    const wrap = document.createElement("div");
    wrap.className = "search-input-wrap";
    wrap.innerHTML =
      '<span class="search-icon" aria-hidden="true">🔎</span>' +
      '<input type="search" class="search-input" placeholder="' +
      escapeHtml(options.placeholder || "Rechercher un spectacle…") +
      '" aria-label="Rechercher un spectacle">';
    container.appendChild(wrap);
    const input = wrap.querySelector("input");
    let debounceTimer = null;
    input.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (typeof options.onChange === "function") {
          options.onChange(input.value);
        }
      }, 120);
    });
    return {
      getValue: () => input.value,
      inputEl: input,
    };
  }

  /* ----------------------------------------------------------------------
   * 10. Affichage d'erreur générique
   * -------------------------------------------------------------------- */
  function renderErrorMessage(container, message) {
    container.innerHTML =
      '<div class="empty-state"><div class="empty-icon" aria-hidden="true">🛑</div>' +
      "<p>" +
      escapeHtml(message) +
      "</p></div>";
  }

  function renderLoading(container, message) {
    container.innerHTML =
      '<div class="empty-state"><div class="skeleton" style="height:2.2em;max-width:320px;margin:0 auto 0.6em;"></div>' +
      '<p class="text-muted">' +
      escapeHtml(message || "Chargement…") +
      "</p></div>";
  }

  /* ----------------------------------------------------------------------
   * 11. Export global
   *     Fusionné (jamais remplacé) : site/js/icons.js s'exécute avant et
   *     attache déjà PDF.icon, qu'un remplacement complet effacerait selon
   *     l'ordre réel des <script> — Object.assign reste sûr dans les deux sens.
   * -------------------------------------------------------------------- */
  Object.assign(global.PDF = global.PDF || {}, {
    DATA_BASE,
    GITHUB_REPO_URL,
    fetchJSON,
    parseISODate,
    formatDateFR,
    formatDateLongFR,
    formatDateTimeFR,
    formatTimeFR,
    formatNumberFR,
    historyJsonPath,
    isoDateToday,
    isDataForToday,
    timeToMinutes,
    computeUpcoming,
    normalizeStr,
    matchesSearch,
    categoryLabel,
    CATEGORY_LABELS,
    STATUS_LABELS,
    escapeHtml,
    isLateHour,
    representationBadges,
    badgeHtml,
    categoryBadgeHtml,
    statusBannerHtml,
    MONTH_LABELS,
    DOW_LABELS,
    isoDate,
    renderMiniCalendar,
    seasonClosedBannerHtml,
    getChartTheme,
    injectHeaderFooter,
    createSearchBar,
    renderErrorMessage,
    renderLoading,
    initThemeToggle,
    setFreshnessNote,
    CARNET_STORAGE_KEY,
    carnetUid,
    loadCarnetState,
    saveCarnetState,
    planItemExists,
    addToPlan,
    isInPlan,
    removeFromPlan,
    toggleFavorite,
    isFavorite,
    fetchCalendarOnce,
    fetchScheduleIndexOnce,
    icsEscape,
    icsUtcStamp,
    buildAllDayIcs,
    downloadTextFile,
  });

  // Injection auto du header/footer au chargement, basé sur data-page du body
  document.addEventListener("DOMContentLoaded", () => {
    const page = document.body.getAttribute("data-page") || "";
    injectHeaderFooter(page);
  });
})(window);
