// Stubs minimaux (window/document/localStorage) pour charger les scripts du
// site tels quels dans Node, sans navigateur ni jsdom : suffisant pour
// tester la logique pure (pas le rendu DOM complet).
const path = require("path");

function freshGlobals() {
  global.window = { matchMedia: function () { return { matches: false, addEventListener: function () {} }; } };
  global.document = {
    addEventListener: function () {},
    body: { getAttribute: function () { return ""; }, setAttribute: function () {} },
    documentElement: { setAttribute: function () {}, removeAttribute: function () {} },
  };
  global.localStorage = { getItem: function () { return null; }, setItem: function () {} };
}

function siteJs(name) {
  return path.join(__dirname, "..", "..", "site", "js", name);
}

// Charge app.js (peuple window.PDF) puis, optionnellement, un second script
// qui en dépend (`var PDF = window.PDF` en tête de fichier). Chaque module
// est retiré du cache pour repartir d'un état propre à chaque appel.
function loadModule(name) {
  freshGlobals();
  delete require.cache[require.resolve(siteJs("app.js"))];
  require(siteJs("app.js"));
  if (name === "app.js") return global.window.PDF;
  delete require.cache[require.resolve(siteJs(name))];
  return require(siteJs(name));
}

module.exports = { loadModule };
