# Puy du Fou — Programmes & Statistiques (projet communautaire, non officiel)

Collecte, historisation, consultation et analyse des **programmes quotidiens
officiels du Puy du Fou France**.

> ⚠️ **Ce projet n'est ni édité, ni approuvé, ni affilié au Puy du Fou.**
> Il s'agit d'un outil communautaire open source qui collecte des
> informations publiques (horaires de spectacles) publiées par le Puy du
> Fou, à des fins pratiques (préparer sa visite, analyser des tendances).
> Le programme officiel du Puy du Fou reste la seule source de vérité :
> vérifiez-le avant votre visite. Aucun logo ni élément visuel protégé du
> Puy du Fou n'est utilisé dans ce dépôt.

## Sommaire

- [Objectif](#objectif)
- [Architecture](#architecture)
- [Installation locale](#installation-locale)
- [Créer / initialiser la base SQLite](#créer--initialiser-la-base-sqlite)
- [Lancer une collecte](#lancer-une-collecte)
- [Statistiques](#statistiques)
- [Export JSON](#export-json)
- [Lancer le site localement](#lancer-le-site-localement)
- [GitHub Actions](#github-actions)
- [GitHub Pages](#github-pages)
- [Structure des données](#structure-des-données)
- [Ajouter une nouvelle saison](#ajouter-une-nouvelle-saison)
- [Adapter le parser si le site change](#adapter-le-parser-si-le-site-change)
- [Tests](#tests)
- [Limites connues](#limites-connues)

## Objectif

Le Puy du Fou publie chaque jour un programme (horaires des spectacles,
animations, etc.), généralement sous forme de document téléchargeable. Ce
document n'est pas historisé nulle part de façon publique : ce projet vise
à :

1. **Collecter** automatiquement le programme officiel du jour.
2. **Historiser** chaque jour dans une base SQLite (sans jamais écraser les
   données précédentes).
3. **Normaliser** les noms de spectacles (variantes de casse/orthographe →
   un seul spectacle canonique).
4. **Exposer** ces données sous forme de fichiers JSON statiques.
5. **Afficher** un site web statique (sans backend) : programme du jour,
   liste des spectacles, statistiques, historique par calendrier.
6. **Analyser** : spectacle le plus/moins représenté, jour le plus chargé,
   conflits horaires, plan de visite optimal, comparaisons, etc.
7. **Automatiser** tout ça quotidiennement via GitHub Actions, avec
   déploiement sur GitHub Pages.

Le tout en restant robuste : si la source officielle est indisponible ou
change de mise en page, le projet ne doit **jamais** remplacer des données
fiables par du vide, et doit rendre l'échec visible (logs + statut affiché
sur le site).

## Architecture

```
puy-du-fou-companion/
├── README.md
├── LICENSE
├── .gitignore
├── requirements.txt
├── pyproject.toml
│
├── data/
│   ├── programmes.db          # base SQLite (historisation)
│   ├── known_spectacles.json  # config : catégories + alias de noms
│   ├── seasons.json           # config : dates d'ouverture/fermeture par saison
│   ├── json/                  # JSON générés pour le frontend
│   │   ├── today.json
│   │   ├── spectacles.json
│   │   ├── dates.json
│   │   ├── stats.json
│   │   └── history/{année}/{date}.json (+ recap.json une fois la saison terminée)
│   └── raw/                   # sources brutes archivées (HTML/PDF, non versionnées)
│
├── src/
│   ├── config.py                # chemins, catégories, statuts, constantes
│   ├── database.py              # schéma SQLite + CRUD + historisation par version
│   ├── models.py                # dataclasses partagées
│   ├── normalizer.py            # slugs + résolution des alias de spectacles
│   ├── schedule_json_parser.py  # source par défaut : JSON structuré embarqué dans la page "programme du jour"
│   ├── pdf_parser.py            # ancienne source (PDF) : conservée pour référence/repli, plus utilisée par défaut
│   ├── collector.py             # SourceAdapter(s) + orchestration de la collecte
│   ├── statistics.py   # statistiques globales / avancées / conflits horaires
│   ├── exporter.py     # génération des fichiers JSON
│   └── main.py          # CLI (collect / stats / export / all)
│
├── tests/                # pytest (parser, normalizer, database, statistics)
├── scripts/              # wrappers simples pour la CI
├── site/                 # frontend statique (HTML/CSS/JS, sans backend)
└── .github/workflows/    # collecte quotidienne + déploiement Pages
```

### Principes de conception

- **`SourceAdapter`** (`src/collector.py`) isole la façon de récupérer le
  programme officiel. Si le site change (nouvelle URL, nouveau format), on
  adapte cette seule classe. Deux implémentations existent :
  `PuyDuFouScheduleSourceAdapter` (par défaut) récupère la page "programme
  du jour" et en extrait les données JSON déjà structurées qu'elle embarque
  (voir `src/schedule_json_parser.py`) ; `PuyDuFouSourceAdapter` (ancien,
  conservé pour repli) télécharge et parse le PDF (voir `src/pdf_parser.py`).
  La source JSON couvre toujours 3 jours (aujourd'hui/demain/après-demain)
  en une seule requête d'environ 16 Ko compressés, contre deux
  téléchargements PDF d'environ 1 Mo chacun.
- **Extraction ≠ analyse**, dans les deux sources : `parse_schedule_html`
  et `parse_program_text` (le pendant PDF) sont de pures fonctions
  texte/JSON → données, sans dépendance réseau ni fichier — ce qui permet
  de les tester avec de simples extraits représentatifs (voir
  `tests/fixtures.py`), sans vraie page ni PDF.
- **Historisation par version** (`src/database.py`) : une date n'est
  jamais écrasée. Si le programme officiel d'une date déjà collectée
  change, une nouvelle ligne `dates` (version N+1) est créée et l'ancienne
  passe à `is_active=0`, mais reste consultable.
- **Détection de changement sur le contenu, pas sur les octets** : le hash
  qui décide si une nouvelle version doit être créée est calculé sur les
  représentations structurées (spectacle/horaire/statut), pas sur les
  octets bruts de la source — une page/un PDF régénéré peut différer octet
  pour octet (métadonnées internes) sans que le programme ait changé.
- **Catégories et alias configurables** (`data/known_spectacles.json`),
  jamais codés en dur dans la logique métier.
- **Dates de saison configurables** (`data/seasons.json`), même principe :
  éditable directement, sans commande Python (voir "Saisons" plus bas).

## Installation locale

Prérequis : **Python 3.12+**.

```bash
git clone https://github.com/anthony49300/puy-du-fou-companion.git
cd puy-du-fou-companion

python -m venv .venv
# Windows :
.venv\Scripts\activate
# macOS / Linux :
source .venv/bin/activate

pip install -r requirements.txt
pip install pytest   # pour lancer les tests
```

## Créer / initialiser la base SQLite

La base est créée automatiquement (schéma + migrations additives) dès la
première commande qui l'utilise — aucune étape manuelle n'est nécessaire :

```bash
python -m src.main stats
# -> crée data/programmes.db si absent, puis affiche des statistiques vides
```

## Lancer une collecte

```bash
# Collecte le programme du jour (date système) et l'enregistre en base
python -m src.main collect

# Collecte le programme d'une date précise
python -m src.main collect --date 2026-08-26

# Collecte le programme de DEMAIN (déjà publié dès 17h30 la veille) —
# ignore --date, calcule la date cible comme aujourd'hui + 1 jour
python -m src.main collect --tomorrow

# Mode aperçu : n'écrit rien en base, affiche juste ce qui serait extrait
python -m src.main collect --dry-run

# Point d'entrée quotidien recommandé (utilisé par le workflow GitHub
# Actions) : ne recollecte "aujourd'hui"/"demain"/"après-demain" que si
# chacun n'est pas déjà connu en base. En régime stable, seul
# "après-demain" (le nouveau jour de la fenêtre) ne l'est pas encore
# (chaque jour est collecté un jour à l'avance) : une seule requête réseau
# dans ce cas, AUCUNE si les trois sont déjà connus — ce qui la rend sûre
# à appeler plusieurs fois par jour sans rien dupliquer.
python -m src.main collect-daily
```

En cas d'échec (source indisponible, PDF illisible, structure inattendue) :
- **aucune donnée existante n'est supprimée ou remplacée** ;
- l'erreur est enregistrée dans `collection_logs` ;
- la commande retourne un code de sortie non nul (utile en CI).

Si le programme officiel a changé de structure au point que rien n'est
détecté, la collecte réussit techniquement (statut `ok`/`partial`) mais un
avertissement `"Aucune représentation détectée..."` est ajouté — regardez
toujours la sortie de la commande et les `warnings` du JSON exporté.

## Saisons (dates d'ouverture/fermeture)

Le Puy du Fou est un parc saisonnier : renseigner les dates d'ouverture et
de fermeture d'une saison permet à la collecte de ne pas tenter (et
échouer) inutilement hors saison, et au site d'afficher clairement "Parc
fermé, réouverture le ..." plutôt que de laisser croire à une panne.

**Façon recommandée : éditer directement `data/seasons.json`** (même
principe que `data/known_spectacles.json` pour les spectacles — pas besoin
de Python) :

```json
{
  "2026": {
    "start_date": "2026-04-11",
    "end_date": "2026-11-08"
  }
}
```

Ces valeurs sont resynchronisées en base automatiquement à chaque
`collect`/`export`/`seasons` (voir `src/season_config.py`) — rien d'autre
à faire après avoir édité le fichier. Une année absente du fichier, ou
dont les dates sont à `null`, laisse le comportement inchangé pour cette
année (aucune régression tant que rien n'est renseigné).

La clé (`"2026"`) sert juste d'identifiant pour la saison : une saison
peut chevaucher le nouvel an (ex: une extension "Noël au Puy du Fou"
jusqu'en janvier) sans que ça pose problème — la recherche se fait par
plage de dates (`start_date <= date <= end_date`), pas par correspondance
d'année calendaire. Dans ce cas, `end_date` est simplement dans l'année
suivante (ex: `"2026": {"start_date": "2026-04-04", "end_date": "2027-01-03"}`).

Alternative en ligne de commande (utile en script ; le fichier, quand il
renseigne des dates pour une année, reprend toujours la main dessus au
prochain `collect`/`export`) :

```bash
python -m src.main set-season-dates 2026 --start 2026-04-11 --end 2026-11-08

# Liste les saisons enregistrées et leurs dates (fichier + base combinés)
python -m src.main seasons
```

`export` maintient un bilan de saison dans `data/json/history/{année}/recap.json`
(nombre de jours collectés, total de représentations, spectacle le
plus/moins joué, répartition par catégorie...) — mis à jour au plus une
fois par mois calendaire tant que la saison est **en cours** (`final:
false`, `as_of_date` indique jusqu'à quand portent les chiffres), puis
figé définitivement (`final: true`) une fois la saison **terminée** (date
de fermeture passée) — jamais retouché ensuite. Pour forcer une
régénération explicite (ex: après une correction de données) :

```bash
python -m src.main season-recap 2026
```

## Statistiques

```bash
python -m src.main stats                 # statistiques globales
python -m src.main stats --season 2026   # filtrées sur une saison
```

Le module `src/statistics.py` couvre :

- Statistiques globales : total spectacles/représentations, moyenne/min/max
  par jour, représentations continues/nocturnes.
- Statistiques par spectacle (`compute_spectacle_stats`) : nb aujourd'hui,
  moyenne/jour, jours présent/absent, historique complet.
- Statistiques avancées : spectacle le plus/moins représenté
  (`compute_global_stats`), jour le plus/moins chargé
  (`busiest_and_lightest_day`), spectacles co-programmés
  (`co_programmed_spectacles`), spectacles rares
  (`rarely_programmed`), distribution horaire (`hourly_distribution`),
  nombre de spectacles différents par jour (`spectacles_per_day`),
  évolution saisonnière (`seasonal_evolution`), comparaisons
  (`compare_dates`, `compare_spectacles`, `compare_seasons`).
- Conflits horaires et plan de visite optimal
  (`find_schedule_conflicts`, `max_shows_schedulable`) : répond à "quel est
  le nombre maximal de spectacles que je peux voir aujourd'hui sans
  superposition d'horaires ?" via un algorithme classique de sélection
  d'activités (tri par heure de fin, choix glouton) — optimal pour
  maximiser le *nombre* de représentations vues.

## Export JSON

```bash
python -m src.main export                       # régénère tout data/json/
python -m src.main export --date 2026-08-26      # today.json pour une date de référence donnée

# Ou directement, en enchaînant collecte + export + stats :
python -m src.main all
```

Fichiers générés : `today.json`, `spectacles.json`, `dates.json`,
`stats.json`, et `history/{date}.json` pour chaque date active (utilisé
par la page Historique du site).

## Lancer le site localement

Le site est 100 % statique (aucun serveur applicatif nécessaire), mais il
faut le servir via HTTP (pas de double-clic sur le fichier) pour que les
appels `fetch()` vers `../data/json/*.json` fonctionnent.

**Important** : servez depuis la **racine du dépôt** (pas depuis `site/`
directement), car le frontend référence les données via des chemins
relatifs `../data/json/...` qui supposent que `site/` et `data/` sont
frères.

```bash
# Depuis la racine du dépôt :
python -m http.server 8000
# puis ouvrez http://localhost:8000/site/index.html
```

## GitHub Actions

Deux workflows dans `.github/workflows/` :

- **`update-programme.yml`** : déclenché une fois par jour le matin (cron
  ~09h13 Europe/Paris), et via `workflow_dispatch` (lancement manuel, avec
  des paramètres `date`/`source` optionnels). Le programme d'aujourd'hui,
  demain ET après-demain sont déjà publiés à cette heure-là en pratique
  (`timelineSchedule.dates_open`), donc ce seul run couvre **les 3 jours**
  (`collect-daily`, voir "Lancer une collecte" plus haut). `collect-daily`
  ne recollecte chaque jour que s'il est encore inconnu : en régime stable,
  seul "après-demain" (le nouveau jour de la fenêtre) l'est réellement —
  "aujourd'hui"/"demain" ne redeviennent utiles à recollecter que si un run
  précédent a été manqué (ex: cron GitHub Actions retardé au point de
  sauter un jour). Aucune réécriture/commit inutile n'a lieu quand rien n'a
  changé (voir `exporter._write_json`, qui ignore les horodatages pour
  décider si un fichier JSON a réellement changé). Avec une date précisée
  dans `workflow_dispatch`, seule cette date est recollectée (pas le combo
  des 3 jours). Le workflow installe Python, installe
  les dépendances, régénère les JSON, exécute les tests (`pytest`), affiche
  un résumé dans les logs (`$GITHUB_STEP_SUMMARY`), committe
  `data/programmes.db` et `data/json/**` s'il y a des changements, les
  pousse, puis déclenche explicitement `deploy-pages.yml`.
- **`deploy-pages.yml`** : déclenché par le workflow précédent (ou
  manuellement, ou par un push touchant `site/**`/`data/json/**`). Il
  reconstitue un dossier `_site/` qui reproduit la structure relative du
  dépôt (`site/` + `data/json/` côte à côte, avec une redirection
  `_site/index.html` vers `site/index.html`), puis publie sur GitHub Pages
  via les actions officielles `actions/upload-pages-artifact` et
  `actions/deploy-pages`.

Lancer la collecte manuellement depuis GitHub : onglet **Actions** →
*Mise à jour quotidienne du programme* → **Run workflow** (avec ou sans
date).

### Proxy résidentiel requis pour la collecte

Le site officiel bloque (403, WAF CloudFront + AWS WAF) systématiquement
toute requête venant d'une IP d'hébergeur/datacenter — constaté sur les
runners GitHub-hébergés et sur plusieurs VPS (différents fournisseurs,
différentes IP, y compris en imitant l'empreinte TLS d'un vrai navigateur).
C'est un blocage au niveau du DOMAINE entier, pas d'une URL en particulier :
passer de la source PDF à la source JSON (voir ci-dessus) ne change donc
rien à ce besoin. Seule une IP résidentielle passe. La collecte passe donc
par un **proxy résidentiel** :

1. Créer un compte chez un fournisseur de proxy résidentiel légitime (ex.
   [IPRoyal](https://iproyal.com/)) et souscrire un petit volume — le
   volume consommé est minime (une page JSON d'environ 16 Ko compressés,
   une fois par jour, soit moins d'1 Mo par mois).
2. Récupérer l'URL de connexion au format `http://user:pass@host:port`
   (le mot de passe peut inclure un suffixe de ciblage géographique, ex.
   `..._country-fr`, selon le fournisseur).
3. Créer le secret de dépôt **`COLLECTOR_PROXY_URL`** (Settings → Secrets
   and variables → Actions → New repository secret) avec cette URL comme
   valeur. Ne JAMAIS committer cette URL en clair dans le code.

Sans ce secret configuré, `HTTP_PROXY_URL` (voir `src/config.py`) reste
vide et le collecteur se connecte directement — ce qui échouera (403)
depuis un runner GitHub-hébergé. En local, sur un poste avec une IP
résidentielle, aucun proxy n'est nécessaire (voir "Lancer une collecte"
plus haut).

Historique des pistes explorées (runner auto-hébergé, IPv6, empreinte
TLS...) et pourquoi elles ne suffisaient pas : voir
[`docs/self-hosted-runner.md`](docs/self-hosted-runner.md).

## GitHub Pages

1. Poussez ce dépôt sur GitHub (voir commandes ci-dessous).
2. Dans **Settings → Pages**, choisissez **Source : GitHub Actions** (pas
   "Deploy from a branch").
3. Lancez une première fois `update-programme.yml` (ou directement
   `deploy-pages.yml`) via l'onglet Actions.
4. L'URL du site s'affiche dans **Settings → Pages** une fois le premier
   déploiement terminé (généralement `https://<utilisateur>.github.io/<dépôt>/`).

## Structure des données

### Base SQLite (`data/programmes.db`)

| Table              | Rôle                                                                 |
|---------------------|-----------------------------------------------------------------------|
| `seasons`           | Une ligne par année de saison (2026, 2027, ...), avec ses dates d'ouverture/fermeture optionnelles (`start_date`/`end_date`, voir "Saisons" plus haut) |
| `dates`             | Une ligne par **version** de programme pour une date (historisation)  |
| `spectacles`        | Un spectacle canonique (nom, slug, catégorie)                          |
| `representations`   | Une représentation (horaire, statut) liée à une version de `dates`    |
| `collection_logs`   | Journal de chaque exécution de collecte (succès/échec/message)         |

### JSON (`data/json/`)

Voir les fichiers eux-mêmes pour le détail complet des champs ; résumé :

- `today.json` : programme de la date la plus pertinente (aujourd'hui, ou
  la dernière date fiable connue si la collecte du jour est en échec —
  jamais un JSON "vide" présenté comme officiel sans indication de statut).
  Statut particulier `out_of_season` : la date demandée tombe hors de la
  période d'ouverture connue de sa saison (voir "Saisons" plus haut) ;
  `season_window` (`{start, end}`) et `next_opening` (date de réouverture
  si déjà connue, sinon `null`) sont alors renseignés. Autre statut
  particulier, `closed_day` : fermeture ponctuelle EN saison (événement
  privé, maintenance...), constatée directement sur la source pour cette
  date précise (`dates_open` la reconnaît mais sans aucun spectacle
  programmé — voir `schedule_json_parser.parse_schedule_html`) plutôt que
  déduite d'une plage de dates configurée ; `spectacles` est alors vide et
  `warnings` explique le pourquoi. Le frontend affiche un bandeau dédié
  ("Le Puy du Fou est fermé le ...") dans les deux cas, sans jamais le
  présenter comme une erreur de collecte.
- `spectacles.json` : tous les spectacles connus + leurs statistiques et
  leur historique de représentations par jour.
- `dates.json` : résumé (nb spectacles/représentations, statut) de chaque
  date active — alimente le calendrier de la page Historique.
- `stats.json` : statistiques globales, par saison, et données prêtes à
  l'emploi pour les graphiques Chart.js.
- `history/{année}/{date}.json` : le détail complet (même format que
  `today.json`) pour chaque date active, rangé par année de saison (évite
  d'accumuler des milliers de fichiers en vrac dans un seul dossier au fil
  des saisons) — permet à la page Historique d'afficher le programme de
  n'importe quel jour passé.
- `history/{année}/recap.json` : bilan d'une saison (voir "Saisons" plus
  haut) — provisoire (`final: false`) et mis à jour ~mensuellement tant
  que la saison est en cours, figé (`final: true`) une fois terminée.

## Ajouter une nouvelle saison

Rien à faire manuellement pour la saison elle-même : dès qu'une collecte
réussit pour une date appartenant à une nouvelle année, `get_or_create_season`
crée automatiquement la saison correspondante (`src/database.py`). Les
données de toutes les saisons restent en base indéfiniment ; les
statistiques par saison (`compute_stats_by_season`, `compare_seasons`) et
les graphiques d'évolution en tiennent compte nativement.

Pensez en revanche à renseigner ses dates d'ouverture/fermeture dès
qu'elles sont officielles (`python -m src.main set-season-dates ...`, voir
"Saisons" plus haut) — sans ça, la collecte continuera de tourner toute
l'année sans distinguer "parc fermé" d'un vrai échec.

Si vous voulez nommer une saison différemment (ex: "Saison des 30 ans"),
modifiez la ligne correspondante dans la table `seasons` ou étendez
`get_or_create_season(conn, year, name=...)`.

## Adapter le parser si le site change

Le parser est volontairement découpé pour limiter l'impact d'un changement
côté site officiel :

1. **Le site change de méthode de diffusion** (nouvelle URL, page
   différente) → adaptez uniquement `fetch()` de l'adapter concerné
   (`PuyDuFouScheduleSourceAdapter` ou `PuyDuFouSourceAdapter`, dans
   `src/collector.py`). La classe abstraite `SourceAdapter` garantit que le
   reste du pipeline n'a pas à changer.
2. **La structure `drupal-settings-json`/`timelineSchedule` change** (le
   widget calendrier de la page "programme du jour" est modifié) → ajustez
   `src/schedule_json_parser.py`. La détection "continu vs ponctuel"
   (écart étendue/durée, voir `_CONTINUOUS_SPAN_MARGIN_MINUTES`) est le
   point le plus susceptible d'évoluer si le site change son modèle de
   données pour les accès "libres".
3. **Retour au PDF nécessaire** (ex: la source JSON disparaît) →
   `extract_text_from_pdf` (dans `src/pdf_parser.py`) essaie déjà plusieurs
   stratégies d'extraction (texte simple, puis blocs positionnés triés) et
   garde la meilleure ; passez `Collector(adapter=PuyDuFouSourceAdapter())`
   pour la réactiver. Le format des horaires/mentions se règle via les
   regex et listes de mots-clés en tête de `src/pdf_parser.py` (`TIME_RE`,
   `CONTINUOUS_KEYWORDS`, `COMPLET_KEYWORDS`, etc.) — **le parser ne doit
   jamais supposer que l'ordre du texte extrait est parfait** (voir la
   gestion des lignes "horaire seul" dans `parse_program_text`).
4. Dans tous les cas, ajoutez un extrait représentatif dans
   `tests/fixtures.py` et un test associé (`tests/test_schedule_json_parser.py`
   ou `tests/test_parser.py` selon la source).
5. **Un nouveau spectacle apparaît** → ajoutez-le (avec ses alias éventuels)
   dans `data/known_spectacles.json`. Un spectacle absent de ce fichier
   n'est **jamais rejeté** : il est conservé avec la catégorie `autre` et
   un avertissement, pour ne perdre aucune donnée réelle.

Toujours utiliser `--dry-run` après une modification du parser pour
vérifier le résultat avant d'écrire en base :

```bash
python -m src.main collect --dry-run
```

## Tests

```bash
pytest -v
```

Couvre : parsing des horaires et plages horaires, spectacles continus,
statuts complet/exceptionnel, robustesse à un ordre de texte
désordonné, normalisation des noms (alias, casse, accents), schéma et
historisation SQLite (versions, unicité, requêtes actives uniquement),
statistiques (globales, par spectacle, avancées, conflits horaires, plan de
visite optimal), et validité des JSON exportés.

## Limites connues

- **Fenêtre de données limitée à 3 jours** : la page "programme du jour"
  ne publie qu'aujourd'hui, demain et après-demain
  (`timelineSchedule.dates_open`). Une date en dehors de cette fenêtre
  (mais dans la saison) donne 0 représentation avec un avertissement
  explicite plutôt qu'une erreur — voir `schedule_json_parser.py`. C'était
  déjà le cas avec le PDF (today/tomorrow uniquement) : pas de régression.
- **Aucun statut "complet"/"exceptionnel" dans la source JSON** : ce statut
  n'existait que dans le texte du PDF, et n'a de toute façon jamais été
  observé en pratique sur les données réellement collectées (toujours
  "scheduled") — voir la docstring de `schedule_json_parser.py`.
- **Détection de la date du programme (PDF, source de repli uniquement)** :
  le parser PDF cherche une date dans le texte (formats `26 août 2026` ou
  `26/08/2026`). Si le PDF ne contient aucune date reconnaissable, la date
  demandée (`--date` ou date système) est utilisée à la place, avec un
  avertissement explicite. Non applicable à la source JSON, où la date est
  un simple index dans les données (jamais ambiguë).
- **Sources brutes non versionnées par défaut** : pour éviter de faire
  grossir le dépôt Git indéfiniment, `data/raw/*.html` et `data/raw/*.pdf`
  sont ignorés par Git (voir `.gitignore`). L'historique structuré (SQLite
  + `data/json/history/`) reste complet ; seul le document brut original du
  jour n'est pas conservé dans le dépôt. Retirez ces lignes du
  `.gitignore` (idéalement avec Git LFS) si vous voulez les conserver.
- **Durée par défaut des représentations sans heure de fin** : les calculs
  de conflits horaires et de plan de visite optimal supposent une durée par
  défaut (`DEFAULT_SHOW_DURATION_MINUTES`, 25 min) quand le programme
  officiel ne précise pas d'heure de fin. Ajustez cette constante dans
  `src/config.py` si nécessaire — cette valeur n'est **jamais** utilisée
  pour afficher un horaire, uniquement pour ces calculs de superposition.
- **Pousse via `GITHUB_TOKEN`** : le workflow `update-programme.yml`
  committe avec le jeton par défaut des Actions. Si la branche `main` est
  protégée (revues obligatoires, etc.), il faudra soit assouplir la
  protection pour le bot, soit utiliser un jeton dédié avec les permissions
  adéquates.
- **Une exécution cron par jour** (le matin) ne garantit pas une fraîcheur
  à la minute (l'heure réelle de déclenchement d'un cron GitHub Actions
  peut varier de plusieurs heures selon la charge de la plateforme) :
  utilisez `workflow_dispatch` pour forcer une collecte immédiate si
  besoin.
