# Runner GitHub Actions auto-hébergé (abandonné — conservé pour référence)

> ⚠️ **Ce document décrit une approche qui s'est révélée insuffisante et
> n'est plus utilisée.** Le workflow utilise désormais un runner
> GitHub-hébergé standard (`ubuntu-latest`) associé à un **proxy
> résidentiel** (secret `COLLECTOR_PROXY_URL`, voir
> [`../README.md`](../README.md) et `src/config.py`). Voir la section
> "Pourquoi ce document est obsolète" ci-dessous pour le détail de ce qui a
> été testé et pourquoi ça ne suffisait pas. Ce fichier est conservé pour
> mémoire (comprendre les essais déjà faits avant d'en retenter d'autres).

## Pourquoi ce document est obsolète

Un runner auto-hébergé sur un VPS a bien été mis en place et testé, mais le
blocage du site officiel (403, CloudFront + AWS WAF) s'est avéré être une
règle de **réputation IP au niveau de la plage/l'hébergeur entière**, pas
propre aux runners GitHub. Ont été testés et confirmés bloqués, quelle que
soit la page du site visée :
- Runners GitHub-hébergés (Azure).
- VPS OVH (hébergeur français, datacenter français) — sur **deux IP
  différentes** achetées séparément.
- IPv6 depuis ce VPS — inexistant côté site (`www.puydufou.com` n'a pas
  d'enregistrement AAAA), donc sans objet.
- Empreinte TLS/JA3 de navigateur réel via `curl_cffi` (`impersonate=
  "chrome124"`) depuis le VPS — toujours bloqué à l'identique : ce n'est
  donc pas une histoire d'empreinte TLS, mais bien de réputation IP.
- Un agent cloud planifié Claude (routine `/schedule`) — bloqué lui aussi,
  mais pour une raison différente : la politique d'egress réseau du bac à
  sable cloud (liste blanche de domaines) refuse `www.puydufou.com`,
  indépendamment du WAF du site.

Seule une IP résidentielle passe ce blocage. La solution retenue est un
proxy résidentiel payant (voir README), qui permet de repasser sur un
runner GitHub-hébergé classique sans dépendre d'un serveur perso allumé en
permanence.

## Contenu original (pour référence historique)

Le workflow ciblait ce runner via le label `puydufou-programmes` :

```yaml
runs-on: [self-hosted, puydufou-programmes]
```

## Prérequis serveur

- Un serveur Linux (Ubuntu 22.04/24.04 recommandé) avec accès SSH, connecté
  à Internet en sortie.
- Idéalement un utilisateur dédié non-root (ex. `actions-runner`) pour
  exécuter le runner — évite qu'un job compromis ait un accès root direct.

```bash
sudo adduser --disabled-password --gecos "" actions-runner
sudo su - actions-runner
```

## 0. Test préalable (avant tout le reste)

Avant d'installer quoi que ce soit, vérifier que l'IP de ce serveur n'est
pas, elle aussi, bloquée par le site officiel :

```bash
curl -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  -sS -o /tmp/test.pdf -w "%{http_code}\n" \
  "https://www.puydufou.com/france/fr/program-day/download-today"
file /tmp/test.pdf   # doit afficher "PDF document", pas "HTML document"
```

Si le code HTTP n'est pas `200` ou que `file` ne détecte pas un PDF, ce
serveur est probablement bloqué aussi (voir les alternatives évoquées :
proxy résidentiel, ou runner sur une machine avec IP domestique) — pas la
peine d'aller plus loin avant d'avoir résolu ce point.

## 1. Installer les dépendances système

```bash
sudo apt-get update
sudo apt-get install -y curl tar git ca-certificates python3 python3-venv python3-pip build-essential python3-dev
```

`python3-venv` est indispensable (le workflow crée un environnement
virtuel à chaque run — voir plus bas) ; `build-essential`/`python3-dev`
servent de filet de sécurité si `pip` doit compiler une dépendance faute
de wheel précompilé disponible pour votre version de Python/distro
(rare, mais peut arriver sur une distro très récente).

⚠️ Le workflow n'utilise PAS `actions/setup-python` : cette action
télécharge un Python précompilé depuis `actions/python-versions`, qui ne
couvre pas toutes les distros (ex: échoue avec *"not found for Debian
13"* sur une Debian trop récente). Il utilise directement le `python3`
du système, via un venv créé dans le workspace du job. Vérifiez que la
version de `python3` installée est raisonnablement récente (3.10+) :

```bash
python3 --version
```

## 2. Enregistrer le runner

1. Sur GitHub : repo → **Settings** → **Actions** → **Runners** →
   **New self-hosted runner** → OS **Linux**, architecture **x64**.
2. GitHub affiche des commandes avec un **token temporaire** (valable
   ~1h) — les copier/exécuter telles quelles, dans le home de
   `actions-runner` :

```bash
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-x64-<version>.tar.gz -L https://github.com/actions/runner/releases/download/v<version>/actions-runner-linux-x64-<version>.tar.gz
tar xzf ./actions-runner-linux-x64-<version>.tar.gz
```

3. **Important** : à l'étape `./config.sh`, GitHub propose une commande du
   type :

```bash
./config.sh --url https://github.com/<owner>/puy-du-fou-programmes --token <TOKEN>
```

   Ajouter le label dédié utilisé par le workflow :

```bash
./config.sh --url https://github.com/<owner>/puy-du-fou-programmes --token <TOKEN> --labels puydufou-programmes
```

   (Si `config.sh` a déjà été lancé sans `--labels`, il demande le nom du
   runner, le dossier de travail, etc. de façon interactive — répondre aux
   valeurs par défaut convient.)

4. Installer les dépendances requises par le runner lui-même (script fourni
   dans l'archive) :

```bash
sudo ./bin/installdependencies.sh
```

## 3. Installer comme service systemd (tourne en arrière-plan, survit aux reboots)

```bash
sudo ./svc.sh install actions-runner
sudo ./svc.sh start
sudo ./svc.sh status
```

## 4. Vérification

- Dans GitHub : **Settings** → **Actions** → **Runners**, le runner doit
  apparaître avec le statut **Idle** et le label `puydufou-programmes`.
- Déclencher manuellement le workflow (`Actions` → *Mise à jour
  quotidienne du programme* → **Run workflow**) et vérifier que le job
  `collect` s'exécute bien sur ce runner (visible dans les logs du run :
  nom de la machine en en-tête).

## Notes de sécurité

- `actions/setup-python@v5` télécharge/mets en cache une distribution
  Python 3.12 sur le runner au premier run (nécessite l'accès Internet déjà
  requis pour la collecte).
- Un runner auto-hébergé exécute le code du workflow **directement sur le
  serveur**, sans l'isolation d'une VM éphémère comme sur les runners
  GitHub-hébergés. Tant que le dépôt reste privé/personnel (pas de PR
  externes non fiables), le risque est limité au code que tu contrôles
  toi-même. Si le dépôt devient public et accepte des PR de tiers, ne pas
  laisser ce runner actif sans restrictions supplémentaires (`pull_request`
  depuis un fork ne doit jamais pouvoir cibler un runner self-hosted).
