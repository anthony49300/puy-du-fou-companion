/* =========================================================================
   Puy du Fou — Programmes & Statistiques (projet communautaire non officiel)
   icons.js — jeu d'icônes trait unique (24×24, stroke=currentColor), un seul
   endroit pour tout le site plutôt qu'un SVG copié-collé par page. Remplace
   les emojis dans le chrome de l'UI (nav, header, footer, boutons d'action).
   ========================================================================= */

(function (global) {
  "use strict";

  // Attributs communs factorisés : un seul <svg ...> par icône, pas un par
  // appel — PDF.icon() retourne une chaîne, pas un nœud DOM, pour rester
  // cohérent avec le reste du site (tout est construit en += innerHTML).
  var ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

  var ICONS = {
    // Navigation principale
    home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/>',
    scroll: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
    "map-route": '<path d="M12 21s7-7.2 7-12a7 7 0 1 0-14 0c0 4.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/>',
    book: '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9.5 3.5v17"/><path d="M15 3.5v5l-1.5-1-1.5 1v-5"/>',
    "chart-bar": '<path d="M4 20V11M10 20V5M16 20v-8"/><path d="M3 20h18"/>',

    // Thème / chrome
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
    "chevron-down": '<path d="M6 9l6 6 6-6"/>',
    castle: '<rect x="4" y="11" width="16" height="9" rx="0.5"/><path d="M4 11V8h3v3M10.5 11V8h3v3M17 11V8h3v3M4 8h3M10.5 8h3M17 8h3"/><path d="M10.5 20v-5h3v5"/>',
    "external-link": '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
    package: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    "alert-triangle": '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 9.5v4"/><path d="M12 16.7v.01"/>',
    "more-horizontal": '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    door: '<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M14.5 12h.01"/>',
    share: '<circle cx="18" cy="5" r="2.3"/><circle cx="6" cy="12" r="2.3"/><circle cx="18" cy="19" r="2.3"/><path d="M8.1 10.8l7.8-4.6M8.1 13.2l7.8 4.6"/>',
    walking: '<circle cx="12.5" cy="5" r="1.7"/><path d="M12.5 8v4l-3 3M12.5 12l3 2.5M9.3 15l-1.6 4M15.3 14.3l2 4.7"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z"/>',
    "star-filled": '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.8z" fill="currentColor"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.7 7.7 0 0 0 0-2l2-1.5-2-3.5-2.4.7a7.6 7.6 0 0 0-1.7-1l-.4-2.5h-4l-.4 2.5a7.6 7.6 0 0 0-1.7 1l-2.4-.7-2 3.5 2 1.5a7.7 7.7 0 0 0 0 2l-2 1.5 2 3.5 2.4-.7a7.6 7.6 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 1.7-1l2.4.7 2-3.5z"/>',
  };

  function icon(name, extraClass) {
    var body = ICONS[name];
    if (!body) return "";
    return '<svg class="icon' + (extraClass ? " " + extraClass : "") + '" ' + ATTRS + ">" + body + "</svg>";
  }

  global.PDF = global.PDF || {};
  global.PDF.icon = icon;
})(window);
