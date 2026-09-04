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
   * Calcule, à partir de l'heure RÉELLE actuelle du navigateur, le prochain
   * spectacle nocturne du jour dans `today.spectacles` (à n'utiliser que si
   * `isDataForToday(today.date)` est vrai). Contrairement au champ
   * "nocturne" du JSON — figé au moment de l'export côté serveur — ceci
   * reste exact tout au long de la journée même sans nouvelle collecte.
   */
  function computeUpcoming(today) {
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const slots = [];
    (today.spectacles || []).forEach((spectacle) => {
      (spectacle.representations || []).forEach((rep) => {
        if (rep.is_continuous) return;
        const mins = timeToMinutes(rep.start);
        if (mins == null || mins < nowMinutes) return;
        slots.push({ spectacle, rep, mins });
      });
    });
    slots.sort((a, b) => a.mins - b.mins);
    const toItem = (slot) =>
      slot && { name: slot.spectacle.name, start: slot.rep.start, category: slot.spectacle.category };
    const nocturne = toItem(slots.find((s) => s.spectacle.category === "spectacle_nocturne"));
    return { nocturne: nocturne || null };
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
    if (!payload || payload.status !== "out_of_season") return null;
    const message = payload.next_opening
      ? "Saison terminée — réouverture prévue le " + formatDateLongFR(payload.next_opening) + "."
      : "Saison terminée — date de réouverture pas encore annoncée.";
    return (
      '<div class="status-banner status-stale"><span aria-hidden="true">🌙</span>' +
      "<span>" + escapeHtml(message) + "</span></div>"
    );
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

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = isoDate(year, month, day);
      const info = dayCellInfo(dateMap[dateStr], dateStr === selectedDate, dateStr);
      html +=
        '<button type="button" class="' + info.cls + '" data-date="' + dateStr + '"' +
        (info.disabled ? " disabled" : "") +
        ' title="' + info.title + '">' +
        day + "</button>";
    }
    html += "</div>";
    wrap.innerHTML = html;

    wrap.querySelector(".cal-nav-prev").addEventListener("click", () => onNav(-1));
    wrap.querySelector(".cal-nav-next").addEventListener("click", () => onNav(1));
    wrap.querySelectorAll("button.cal-day:not([disabled])").forEach((btn) => {
      btn.addEventListener("click", () => onSelect(btn.getAttribute("data-date")));
    });
  }

  /* ----------------------------------------------------------------------
   * 6. Header / nav / footer injectés
   * -------------------------------------------------------------------- */
  // Nav directe : les 2 pages consultées au quotidien. Le logo sert déjà de
  // lien "Accueil", pas besoin de le dupliquer dans la nav.
  const NAV_DIRECT = [
    { page: "programme", href: "programme.html", label: "Programme" },
    { page: "carnet", href: "carnet.html", label: "Mon carnet" },
  ];
  // Regroupées sous "Explorer" : pages de consultation/données, moins
  // fréquentées au quotidien — évite une nav à 7 entrées à plat.
  const NAV_EXPLORE = [
    { page: "spectacles", href: "spectacles.html", label: "Spectacles" },
    { page: "statistiques", href: "statistiques.html", label: "Statistiques" },
    { page: "historique", href: "historique.html", label: "Historique" },
    { page: "bilan", href: "bilan.html", label: "Bilan" },
  ];

  // Petit emblème SVG dessiné à la main (pas de logo officiel) :
  // un blason simplifié couronné d'une flamme, dans la palette du site.
  const BRAND_SVG =
    '<svg class="brand-emblem" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M24 5l14 5.2v10.5c0 10-6 17-14 21.3-8-4.3-14-11.3-14-21.3V10.2z" fill="var(--color-bordeaux, #7c2233)"/>' +
    '<path d="M24 13c-1.3 2.6-2 4.6-2 6.3 0 1.8.9 3.1 2 4.1 1.1-1 2-2.3 2-4.1 0-1.7-.7-3.7-2-6.3z" fill="var(--color-amber, #c98a2b)"/>' +
    '<path d="M24 20c-2 0-4 1.3-5.3 3.3-1.4 2.1-1.2 4.3.1 5.5 1 .9 2.3.9 3.1-.2-.9-1.3-1-3-.2-4.3.6-1 1.5-1.8 2.3-2.3z" fill="var(--color-amber, #c98a2b)"/>' +
    '<path d="M24 20c2 0 4 1.3 5.3 3.3 1.4 2.1 1.2 4.3-.1 5.5-1 .9-2.3.9-3.1-.2.9-1.3 1-3 .2-4.3-.6-1-1.5-1.8-2.3-2.3z" fill="var(--color-amber, #c98a2b)"/>' +
    '<rect x="22.3" y="30" width="3.4" height="6.5" fill="var(--color-amber, #c98a2b)"/>' +
    '<rect x="19" y="35.6" width="10" height="2.6" rx="1" fill="var(--color-amber, #c98a2b)"/>' +
    "</svg>";

  function navLinkHtml(item, activePage, cls) {
    const activeCls = item.page === activePage ? " active" : "";
    return (
      '<a href="' + item.href + '" class="' + cls + activeCls + '"' +
      (item.page === activePage ? ' aria-current="page"' : "") +
      ">" + item.label + "</a>"
    );
  }

  function buildHeaderHtml(activePage) {
    const directHtml = NAV_DIRECT.map((item) => navLinkHtml(item, activePage, "nav-link")).join("");
    const exploreHtml = NAV_EXPLORE.map((item) => navLinkHtml(item, activePage, "nav-dropdown-link")).join("");
    const isExploreActive = NAV_EXPLORE.some((item) => item.page === activePage);

    return (
      '<div class="header-inner">' +
      '<a href="index.html" class="brand">' +
      BRAND_SVG +
      '<span class="brand-text-full">Puy du Fou — Programmes</span>' +
      '<span class="brand-text-short">PdF Programmes</span>' +
      "</a>" +
      '<nav class="main-nav" id="main-nav" aria-label="Navigation principale">' +
      directHtml +
      '<div class="nav-group">' +
      '<button type="button" class="nav-link nav-group-toggle' + (isExploreActive ? " active" : "") + '" ' +
      'id="nav-explore-toggle" aria-haspopup="true" aria-expanded="false">Explorer <span class="nav-caret" aria-hidden="true">▾</span></button>' +
      '<div class="nav-dropdown" id="nav-explore-dropdown">' + exploreHtml + "</div>" +
      "</div>" +
      "</nav>" +
      '<div class="header-actions">' +
      '<button type="button" class="theme-toggle" id="theme-toggle" aria-label="Basculer le mode sombre / clair" title="Mode sombre / clair">🌙</button>' +
      '<button type="button" class="hamburger" id="hamburger-btn" aria-label="Ouvrir le menu" aria-controls="main-nav" aria-expanded="false"><span></span><span></span><span></span></button>' +
      "</div>" +
      "</div>"
    );
  }

  function buildFooterHtml() {
    const year = new Date().getFullYear();
    return (
      '<div class="footer-inner">' +
      '<div class="footer-block">' +
      '<div class="footer-disclaimer">⚠️ Projet communautaire non officiel — données issues du programme officiel du Puy du Fou. Ce site n\'est ni édité, ni approuvé, ni affilié au Puy du Fou.</div>' +
      "<p>Les horaires et informations peuvent évoluer sans préavis. Vérifiez toujours le programme officiel avant votre visite.</p>" +
      "</div>" +
      '<div class="footer-block footer-links">' +
      "<h4>Liens</h4>" +
      '<p><a href="' +
      GITHUB_REPO_URL +
      '" target="_blank" rel="noopener noreferrer">📦 Dépôt GitHub du projet</a></p>' +
      '<p><a href="https://www.puydufou.com" target="_blank" rel="noopener noreferrer">🔗 Site officiel du Puy du Fou</a></p>' +
      "<p>© " +
      year +
      ' — Projet open source communautaire</p>' +
      "</div>" +
      "</div>"
    );
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
    initMobileMenu();
    initThemeToggle();
  }

  /* ----------------------------------------------------------------------
   * 7. Menu mobile (hamburger)
   * -------------------------------------------------------------------- */
  function initMobileMenu() {
    const btn = document.getElementById("hamburger-btn");
    const nav = document.getElementById("main-nav");
    if (!btn || !nav) return;
    btn.addEventListener("click", () => {
      const isOpen = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      btn.setAttribute("aria-label", isOpen ? "Fermer le menu" : "Ouvrir le menu");
    });
    // Ferme le menu après un clic sur un lien (mobile)
    nav.addEventListener("click", (e) => {
      if (e.target.tagName === "A") {
        nav.classList.remove("open");
        btn.setAttribute("aria-expanded", "false");
      }
    });
    initNavDropdown();
  }

  // Menu déroulant "Explorer" (desktop : flottant sous le bouton ; mobile :
  // s'ouvre en ligne dans le menu hamburger déjà vertical, même markup/JS).
  function initNavDropdown() {
    const toggle = document.getElementById("nav-explore-toggle");
    const dropdown = document.getElementById("nav-explore-dropdown");
    if (!toggle || !dropdown) return;

    function close() {
      dropdown.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
    function open() {
      dropdown.classList.add("open");
      toggle.setAttribute("aria-expanded", "true");
    }

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dropdown.classList.contains("open")) close();
      else open();
    });
    document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target) && e.target !== toggle) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dropdown.classList.contains("open")) {
        close();
        toggle.focus();
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
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    updateThemeToggleIcon(btn);
    btn.addEventListener("click", () => {
      const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem(THEME_KEY, next);
      updateThemeToggleIcon(btn);
      // Permet aux pages avec graphiques Chart.js de se redessiner avec les
      // bonnes couleurs (texte/grille) pour le nouveau thème.
      global.dispatchEvent(new CustomEvent("pdf:themechange", { detail: { theme: next } }));
    });
  }

  function updateThemeToggleIcon(btn) {
    btn.textContent = currentEffectiveTheme() === "dark" ? "☀️" : "🌙";
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
    };
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
   * -------------------------------------------------------------------- */
  global.PDF = {
    DATA_BASE,
    GITHUB_REPO_URL,
    fetchJSON,
    parseISODate,
    formatDateFR,
    formatDateLongFR,
    formatDateTimeFR,
    formatTimeFR,
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
    initMobileMenu,
    initThemeToggle,
  };

  // Injection auto du header/footer au chargement, basé sur data-page du body
  document.addEventListener("DOMContentLoaded", () => {
    const page = document.body.getAttribute("data-page") || "";
    injectHeaderFooter(page);
  });
})(window);
