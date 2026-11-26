[English](README.md) · **Français**

# llm-bench

**Comparez des modèles LLM sur votre propre projet — locaux ou cloud, gratuits ou payants — et passez
de l'un à l'autre sans toucher à votre code.**

llm-bench répond à trois questions :

1. **Quel modèle répond le mieux à mon prompt ?** → *Bench prompt* : le prompt système de votre projet
   est envoyé directement à chaque modèle, et les réponses sont vérifiées automatiquement.
2. **Mon application fonctionne-t-elle aussi bien avec un autre modèle ?** → *Bench serveur* : des
   copies de votre serveur (chatbot HTTP, API de chat…) sont lancées chacune avec un modèle, puis
   testées de bout en bout par des conversations scénarisées.
3. **Comment changer de modèle en un clic pendant que je développe ?** → *Passerelle* : un endpoint
   compatible OpenAI fixe ; le modèle réel derrière se choisit dans l'interface.

Chaque appel au modèle est **capturé** (URL réelle, requête, réponse, tokens, coût) et chaque campagne
produit un **rapport** (score, latence, tokens/s, coût par cas).

Tout se pilote depuis une **interface web locale** (écoute sur `127.0.0.1` uniquement). Une ligne de
commande couvre le bench prompt et la passerelle. Seule dépendance : [`tsx`](https://github.com/privatenumber/tsx).

---

## Sommaire

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Langue](#langue)
- [Notions de base](#notions-de-base)
- [Brancher votre projet](#brancher-votre-projet)
- [L'interface](#linterface)
- [Modèles et fournisseurs](#modèles-et-fournisseurs)
- [Bench prompt](#bench-prompt)
- [Bench serveur](#bench-serveur)
- [Cas de test et vérifications](#cas-de-test-et-vérifications)
- [Exécution en parallèle](#exécution-en-parallèle)
- [Passerelle](#passerelle)
- [Capture des appels LLM](#capture-des-appels-llm)
- [Coûts](#coûts)
- [Référence de la configuration](#référence-de-la-configuration)
- [Ligne de commande](#ligne-de-commande)
- [Fichiers et stockage](#fichiers-et-stockage)
- [Sécurité](#sécurité)
- [Dépannage](#dépannage)
- [Développement](#développement)
- [Licence](#licence)

---

## Prérequis

| Outil | Version | Pour quoi |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | **22 ou plus** | Obligatoire |
| Dépendances npm (`tsx`) | — | Obligatoire, installées par `npm install` |
| [Ollama](https://ollama.com) | récente | Facultatif : modèles locaux gratuits |
| Clés API (OpenAI, OpenRouter, Groq, Azure…) | — | Facultatif : modèles cloud |

Tout fournisseur exposant une **API compatible OpenAI** (`/v1/chat/completions`) fonctionne.

### Vérifier les prérequis

Node.js doit être installé pour lancer quoi que ce soit ([nodejs.org](https://nodejs.org),
`brew install node`, `winget install OpenJS.NodeJS` ou `nvm install 22`). Ensuite, depuis le dépôt
cloné :

```sh
node bin/llm-bench.mjs doctor      # une fois installé : llm-bench doctor
```

`doctor` n'a besoin d'aucune dépendance (il fonctionne avant `npm install`). Il vérifie chaque
prérequis et, pour ce qui manque, **propose de l'installer** (répondre `o` / `n`) :

| Vérification | S'il manque ou n'est pas prêt, il propose de… |
| --- | --- |
| Node.js ≥ 22 | Mettre à jour : `brew install node` (macOS), `winget install OpenJS.NodeJS` (Windows) ; sinon indique la marche à suivre |
| Dépendances npm | Lancer `npm install` dans le dépôt |
| Ollama installé | L'installer : `brew install ollama` (macOS), `winget install Ollama.Ollama` (Windows), script officiel (Linux) ; sinon indique la page de téléchargement |
| Serveur Ollama démarré | Le démarrer : `brew services start ollama` ou `ollama serve` |
| Au moins un modèle local | Télécharger `qwen2.5:7b` (≈ 4,7 Go ; réponse par défaut : non) |

Ollama est facultatif : sans lui, seuls les modèles cloud sont utilisables. Options : `--yes` accepte
toutes les propositions (installation sans intervention), `--no` affiche seulement le bilan. Code de
sortie `1` s'il manque un prérequis obligatoire.

## Installation

```sh
git clone https://github.com/ennosof/llm-bench.git
cd llm-bench
node bin/llm-bench.mjs doctor   # vérifie les prérequis, installe ce qui manque (npm install compris)
npm link                        # rend la commande `llm-bench` disponible partout
```

Vérification : `llm-bench --help`.

## Langue

Tout l'outil (interface web, ligne de commande, messages d'erreur, configuration générée, rapports) est
disponible en anglais et en français.

- **Interface web** : bascule **FR / EN** dans l'en-tête (en haut à droite). Par défaut, la langue du
  navigateur (français si le navigateur est en français, sinon anglais) ; le choix est mémorisé par le
  navigateur. Les rapports de campagne et les messages venant du serveur suivent la langue de l'interface.
- **Ligne de commande** : `LLM_BENCH_LANG=fr` ou `LLM_BENCH_LANG=en` ; sinon la langue du système
  (`LC_ALL`, `LC_MESSAGES`, `LANG`) ; anglais par défaut.

  ```sh
  LLM_BENCH_LANG=fr llm-bench prompt --tier free
  ```

- `llm-bench init` écrit les commentaires de la configuration générée dans cette langue.
- **Contributeurs** : le texte français sert de clé de traduction : `tr("…")` dans le code, l'anglais
  dans `src/i18n/en-*.ts` (serveur, CLI) et `UI_EN` dans `ui/index.html`. `npm run i18n:check` liste
  les traductions manquantes.

## Notions de base

| Notion | Signification |
| --- | --- |
| **Fournisseur** | Un endpoint compatible OpenAI déclaré dans la config (`ollama`, `openrouter`, `azure`…). |
| **Modèle** | Toujours écrit `fournisseur/modèle`, ex. `ollama/qwen2.5:7b`, `openrouter/meta-llama/llama-3.3-70b-instruct:free`. Seul le premier `/` sépare les deux. |
| **Offre** (`tier`) | `free` (gratuit) ou `paid` (payant). Sert aux filtres, à la bascule de la passerelle et aux coûts. Ollama est `free` par défaut, les autres `paid`. |
| **Local / distant** | Un modèle est *local* si son fournisseur est Ollama ou pointe vers `localhost` / `127.0.0.1`. Les modèles locaux ne sont jamais exécutés en parallèle (mémoire, GPU). |
| **Cas de test** | Un message (ou une conversation) et les vérifications attendues sur la réponse. |
| **Campagne** | L'exécution de plusieurs cas sur plusieurs modèles ou serveurs ; elle produit un rapport. |

---

## Brancher votre projet

Votre projet **n'a aucune dépendance** vers llm-bench et peut être écrit dans **n'importe quel langage**
(Node, Python, Go, Java, .NET, Ruby, PHP…) : il suffit d'un fichier de configuration et de cas de test,
rangés à côté du code.

### 1. Générer la configuration

Depuis la racine de votre projet :

```sh
llm-bench init          # crée bench/bench.config.ts, des cas de départ et bench/.gitignore
```

`init` analyse le projet et remplit ce qu'il peut. Ce qu'il n'a pas pu déterminer est marqué
**« À VÉRIFIER »** dans le fichier :

| Élément | D'où vient la détection |
| --- | --- |
| Technologie, commandes `install` / `build` / `start` | Node, Python, Go, Java, .NET, Ruby, PHP : voir [N'importe quel langage](#nimporte-quel-langage) |
| Variables du modèle (endpoint, clé, modèle, port) | Noms trouvés dans `.env`, `.env.example`…, puis dans le code (`process.env.X`, `os.environ`, `getenv`), choisis par motif (`LLM_ENDPOINT`, `OPENAI_BASE_URL`, `*_API_KEY`, `*_MODEL`, `PORT`…) |
| Route de chat et route de santé | Routes déclarées dans le code (Express, Fastify, Nest `@Post`, FastAPI…) contenant `chat`, `message`… ou `health`, `ping`… |
| Prompt système | Voir [Prompt système](#prompt-système) |

Options : `--dir <dossier>` (défaut `bench`), `--force` (remplace une config existante).

> ⚠️ `init` ajoute un profil de passerelle `free: "ollama/qwen2.5:7b"` par défaut : remplacez-le par
> vos modèles (voir [Passerelle](#passerelle)).

### 2. Relire la configuration

Ouvrez `bench/bench.config.ts`, corrigez les lignes « À VÉRIFIER », adaptez au format de votre API :

- `server.chat.body` : le corps de la requête de chat envoyée à votre serveur ;
- `server.chat.reply` / `server.chat.kind` : comment lire la réponse.

Mettez les clés API dans le `.env` du projet (la config les lit, elle ne les écrit jamais).

### 3. Lancer l'interface

```sh
llm-bench ui --open
```

### Structure obtenue

```
mon-projet/
├── bench/
│   ├── bench.config.ts       fournisseurs, prompt, serveur, passerelle, vérifications (versionné)
│   ├── prompt-cases.json     cas du bench prompt   (versionné ; éditables dans l'interface)
│   ├── server-cases.json     cas du bench serveur  (versionné ; éditables dans l'interface)
│   ├── .gitignore            ignore les données générées ci-dessous
│   ├── results/              rapports du bench prompt            (généré)
│   ├── results-servers/      rapports du bench serveur           (généré)
│   ├── gateway.json          modèle choisi pour la passerelle    (généré)
│   └── providers.local.json  modèles et clés saisis dans l'UI    (généré, contient des clés)
└── .env                      clés API
```

La config est cherchée, dans l'ordre : `bench.config.ts`, `bench.config.mjs`, `bench.config.js`,
`bench/bench.config.ts`, `bench/bench.config.mjs`, ou via `--config <fichier>`. Elle est exécutée par
`tsx` : elle peut **importer le code du projet** (prompt système, utilitaires) et déclarer des
**fonctions** (vérifications métier, construction des requêtes…).

---

## L'interface

`llm-bench ui` démarre sur `http://localhost:4317`. Pour changer de port, mettre `port: 5000` dans
`bench.config.ts` avant de lancer l'outil (ou `--port` / `BENCH_PORT`, prioritaires sur la config). Quatre menus :

| Menu | Onglets | Rôle |
| --- | --- | --- |
| **Modèles** | Gratuits · Payants | Gérer les modèles Ollama, consulter les offres gratuites, ajouter des modèles payants |
| **Bench prompt** | Lancer · Rapports · Cas de test · Prompt système | Tester le prompt système directement sur les modèles |
| **Bench serveur** | Serveurs · Lancer · Rapports · Cas de test · Variables | Tester votre serveur de bout en bout (visible si la config a une section `server`) |
| **Passerelle** | — | Choisir le modèle derrière l'endpoint stable, voir les appels capturés |

Le filtre **Toutes / Gratuites / Payantes** se retrouve partout où l'on choisit un modèle ; la liste ne
propose alors que les modèles de l'offre choisie, et le dernier modèle choisi dans chaque offre est
retenu quand on bascule.

---

## Modèles et fournisseurs

### Déclarer des fournisseurs dans la config

```ts
providers: {
  ollama:     { kind: "ollama", baseUrl: "http://localhost:11434/v1", tier: "free" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY, tier: "free",
                models: ["meta-llama/llama-3.3-70b-instruct:free"] },
  azure:      { baseUrl: process.env.AZURE_ENDPOINT, apiKey: process.env.AZURE_KEY, apiKeyHeader: "api-key",
                tier: "paid", models: ["gpt-4.1"],
                pricing: { "gpt-4.1": { input: 2, output: 8 } } },   // prix par million de tokens
},
```

Un fournisseur distant **sans clé API** est affiché mais inutilisable (« clé API absente »).

### Menu Modèles

- **Gratuits**
  - Modèles Ollama installés (suppression).
  - Téléchargement depuis le catalogue ollama.com (recherche, choix de la variante, progression).
  - Offres cloud gratuites déclarées dans la config (lecture seule).
- **Payants**
  - Liste des modèles payants, modification ✎, suppression 🗑.
  - **+ Ajouter un modèle** : fournisseur, endpoint compatible OpenAI, clé, en-tête de la clé, modèle, prix.
  - **Pré-remplir** reprend l'endpoint, le modèle et la clé du `.env` du projet (variables de `server.env`).
  - 🔑 renseigne la clé d'un fournisseur de la config depuis l'interface (prioritaire sur la config).

Ce qui est saisi dans l'interface est enregistré dans `<dataDir>/providers.local.json` (**clés en clair**,
ignoré par git), sans jamais modifier `bench.config.ts`.

### Adaptation des requêtes

Certains modèles refusent des paramètres (ex. `temperature` ou `max_tokens` sur les modèles de
raisonnement). Par défaut, llm-bench retire `temperature` et transforme `max_tokens` en
`max_completion_tokens` pour ces modèles. Pour un contrôle total, déclarez `adaptRequest` :

```ts
azure: {
  // …
  adaptRequest: (body, { model }) => (model.startsWith("o") ? { ...body, temperature: undefined } : body),
},
```

`adaptRequest` s'applique partout : bench prompt, proxy du bench serveur et passerelle.

---

## Bench prompt

Le prompt système du projet est envoyé **directement** au modèle avec le message de chaque cas. Pas de
serveur à lancer : quelques secondes par cas, idéal pour trier des modèles et mettre au point un prompt.

### Prompt système

`init` cherche le prompt système et l'enregistre s'il le trouve ; sinon, choisissez-le dans
**Bench prompt → Prompt système**. La détection :

1. repère les textes utilisés comme message système (`new SystemMessage(X)`, `role: "system"`,
   `system: X`…) et remonte jusqu'à leur export ;
2. à défaut, les exports nommés comme un prompt système, puis les fichiers `.md` / `.txt` de prompt ;
3. exécute chaque export candidat dans un processus à part pour lire le **texte réel** (prompts
   assemblés compris) ;
4. utilise un export de version voisin (`PROMPT_VERSION`…) comme version.

Sources possibles dans la config :

```ts
prompt: {
  system: { module: "../src/llm/prompts/index.ts", export: "SYSTEM_PROMPT" },
  // ou : { file: "./system-prompt.md" } · un texte · une fonction (async ou non)
  version: { module: "../src/llm/prompts/version.ts", export: "PROMPT_VERSION" }, // facultatif
},
```

Le prompt est **relu à chaque campagne** : une modification dans le projet est testée dès la campagne
suivante. Sans `version`, une empreinte du texte sert de version.

### Déroulement d'une campagne

1. Pour chaque modèle Ollama : un premier appel non mesuré charge le modèle en mémoire (le temps de
   chargement est affiché à part).
2. Chaque cas est envoyé : `[système, …historique du cas, message utilisateur]`, avec les paramètres
   de `prompt.request` (défaut : `temperature: 0`, `max_tokens: 4096`).
3. La réponse est lue selon `prompt.parse` (`"json"` par défaut : du premier `{` au dernier `}`), puis
   les vérifications du cas sont évaluées.

### Rapport

Par modèle : **score** (cas réussis), **JSON valide**, erreurs, latence moyenne et médiane, tokens
d'entrée et de sortie, **tokens/s**, **coût total et par appel**, temps de chargement.

Par cas : réponse brute, vérifications réussies / échouées, tokens. Un cas peut être **rejoué**
individuellement (avec sa version actuelle s'il a été modifié) ; les essais précédents restent visibles.

Un avertissement **« contexte probablement tronqué »** apparaît quand Ollama a reçu nettement moins
de tokens que la taille du prompt : augmentez `OLLAMA_CONTEXT_LENGTH`.

---

## Bench serveur

Teste **votre application réelle** : des copies du projet sont lancées chacune avec un modèle, puis
reçoivent des conversations sur leur route de chat.

### N'importe quel langage

Le serveur testé peut être écrit dans **n'importe quel langage** : llm-bench ne lui parle que par
HTTP, des variables d'environnement et des commandes shell. Node.js ne sert qu'à faire tourner
llm-bench lui-même. `init` reconnaît la technologie et génère les commandes correspondantes :

| Langage / technologie | Détecté par | Commandes générées (`install` → `build` → `start`) |
| --- | --- | --- |
| **Node** (npm, yarn, pnpm, bun) | `package.json` + fichier de verrou | `npm ci` → `npm run build` (s'il existe) → `node <main>` ou le script `start` |
| **Python** (uv, Poetry, Pipenv, pip) | `pyproject.toml`, `uv.lock`, `poetry.lock`, `Pipfile`, `requirements.txt` | `uv sync` / `poetry install` / `pipenv install` / `python3 -m venv .venv && pip install …` → — → FastAPI : `uvicorn module:app --port $PORT` · Flask : `flask --app module:app run --port $PORT` · Django : `manage.py runserver 127.0.0.1:$PORT` · sinon `python main.py` |
| **Go** | `go.mod` (`main.go` ou `cmd/<nom>/main.go`) | `go mod download` → `go build -o .bench-bin/server ./cmd/<nom>` → `./.bench-bin/server` |
| **Java** (Maven, Gradle ; Spring Boot) | `pom.xml`, `build.gradle(.kts)`, `mvnw` / `gradlew` | `mvn dependency:go-offline` → `mvn package` / `gradle bootJar` → `java -jar <jar> --server.port=$PORT` |
| **.NET** | `*.csproj`, `*.fsproj`, `*.sln` | `dotnet restore` → `dotnet build -c Release` → `dotnet run --no-build --urls http://127.0.0.1:$PORT` |
| **Ruby** (Rails, Rack) | `Gemfile`, `config/application.rb`, `config.ru` | `bundle install` → — → `rails server -p $PORT` / `rackup -p $PORT` |
| **PHP** (Laravel, Composer) | `composer.json`, `artisan` | `composer install` → — → `php artisan serve --port=$PORT` / `php -S 127.0.0.1:$PORT -t public` |

- `install`, `build` et `start` sont des **commandes shell** exécutées dans la copie (`sh` sous
  macOS / Linux, `cmd.exe` sous Windows). La variable de port (`$PORT`, ou le nom défini dans
  `server.env.port`) y vaut le port attribué à la copie.
- **Windows** : `$PORT` et `${VAR}` y fonctionnent aussi (le bench les remplace lui-même, `cmd.exe` ne
  le faisant pas). Les commandes qui diffèrent (`.venv\Scripts\` au lieu de `.venv/bin/`,
  `gradlew.bat`, `mvnw.cmd`, `server.exe`, recherche du jar en PowerShell) sont générées sous la forme
  `win ? "…" : "…"` dans la config : le même `bench.config.ts` marche sur tous les systèmes. Les
  serveurs sont arrêtés par `taskkill` (tout l'arbre de processus) et les dossiers partagés sont liés
  par jonction (sans droits administrateur).
- Les dossiers de dépendances et de build (`.venv`, `vendor`, `target`, `bin/obj`…) sont exclus de la
  copie (`exclude`) ; `.venv`, `node_modules` ou `vendor` peuvent être **partagés** avec le projet au
  lieu d'être installés (`shareDirs`, option « Partager » à la création d'un serveur) S'il manque encore
  dans le projet (dépendances jamais installées), la copie installe les siennes.
- Dans un dépôt à plusieurs technologies (ex. un `package.json` d'outillage front à côté d'une API
  Python), c'est le vrai serveur qui l'emporte ; les autres sont indiquées en commentaire dans la
  config générée.
- Une technologie non reconnue reçoit des valeurs « À VÉRIFIER » : écrivez les trois commandes.

Ce qu'il faut au serveur, quel que soit le langage : lire l'endpoint, la clé, le modèle et le port
dans des variables d'environnement ; exposer une route de chat JSON et une route de santé ; appeler
une API compatible OpenAI (`/chat/completions`).

Exemple Python (FastAPI) :

```ts
server: {
  env: { baseUrl: "OPENAI_BASE_URL", apiKey: "OPENAI_API_KEY", model: "LLM_MODEL", port: "PORT" },
  install: ["uv sync --frozen"],
  build: [],
  start: "uv run uvicorn app.main:app --host 127.0.0.1 --port $PORT",
  exclude: [".venv", "__pycache__"],
  shareDirs: [".venv"],
  health: "/health",
  chat: { path: "/chat", body: (ctx) => ({ message: ctx.message, session_id: ctx.sessionId }) },
},
prompt: { system: { file: "../app/prompts/system.md" } },   // l'import d'un module ne marche qu'en JS/TS
```

### Cycle de vie d'un serveur

| Étape | Détail |
| --- | --- |
| **Copie** | Le dossier `source` **tel qu'il est sur le disque** (modifications non commitées comprises) est copié vers `instancesDir/<id>`, sans `node_modules`, `.git`, les données du bench ni les chemins `exclude` |
| **Environnement** | Le fichier `envFile` du projet (`.env`) est recopié, avec les variables du modèle remplacées (endpoint, clé, modèle, port) |
| **Installation** | Commandes `install`, ou lien symbolique vers les `node_modules` du projet (option « Partager », instantané) |
| **Build** | Commandes `build` |
| **Démarrage** | Commande `start` ; le serveur est prêt quand `health` répond en 2xx (délai `startTimeoutMs`) |

Chaque serveur reçoit son propre port, à partir de `firstPort` (défaut `3101`).

Actions dans **Bench serveur → Serveurs** : ▶ démarrer / ■ arrêter, **↻ Code** (recopie + build +
redémarrage), **✎** changer de modèle (redémarrage seul), **📄** journal, **📦** réinstaller,
**🗑** supprimer. Le détail d'un serveur montre son dossier, ses variables, son URL et ses commandes.

### Comment le modèle est branché

Le serveur appelle son modèle **à travers le bench** : au démarrage, sa variable d'endpoint reçoit
`http://127.0.0.1:4317/llm/<id>`. Le bench relaie vers le vrai fournisseur (clé ajoutée,
`adaptRequest` appliqué, streaming compris) et **enregistre chaque appel**. Le `.env` écrit dans la
copie contient, lui, le vrai endpoint : la copie reste utilisable seule.

### Variables d'environnement

**Bench serveur → Variables** : noms des variables par lesquelles le serveur reçoit son modèle.

| Rôle | Défaut |
| --- | --- |
| Endpoint | `LLM_ENDPOINT` |
| Clé API (vide si le projet n'en lit pas) | `LLM_API_KEY` |
| Modèle | `LLM_MODEL` |
| Port | `PORT` |

La page indique si chaque nom figure dans le `.env` du projet ou est lu par son code. Un changement
réécrit le bloc `server.env` de `bench.config.ts` et s'applique aux nouveaux serveurs.

### Déroulement d'un cas

- Une **session neuve** par cas : `ctx.sessionId` est unique, à transmettre dans `chat.body`.
- Les étapes sont envoyées dans l'ordre ; `chat.remember` peut garder des éléments d'une réponse pour
  les étapes suivantes (`ctx.memory`).
- Pour chaque étape : statut, type de réponse (`chat.kind`), message (`chat.reply`), latence,
  vérifications, requête et réponse HTTP, et **tous les appels LLM du serveur** pendant l'étape.

### Rapport

Par serveur : cas réussis / échoués / en erreur, vérifications réussies, latence moyenne, médiane et
maximale par étape, tokens et coût des appels LLM. Chaque cas peut être rejoué.

---

## Cas de test et vérifications

Les cas se créent et se modifient dans l'interface (onglets **Cas de test**) ou directement dans les
fichiers JSON.

### Format

**Bench prompt** (`prompt-cases.json`) :

```json
{
  "id": "search-author",
  "category": "search",
  "description": "Recherche par auteur",
  "message": "Vous avez des livres de Victor Hugo ?",
  "history": [{ "role": "user", "content": "Bonjour" }, { "role": "assistant", "content": "Bonjour !" }],
  "checks": [
    { "type": "intent", "value": "search" },
    { "type": "path", "path": "query", "op": "contains", "value": "hugo" }
  ]
}
```

**Bench serveur** (`server-cases.json`) : une conversation en plusieurs étapes.

```json
{
  "id": "order-followup",
  "category": "commande",
  "steps": [
    { "message": "Où en est ma commande 48213 ?", "checks": [{ "type": "notError" }] },
    { "message": "Et la livraison est prévue quand ?", "checks": [{ "type": "textContains", "value": "{{J+3}}, livraison" }] }
  ]
}
```

Les étapes peuvent porter des **options** (`server.stepOptions`, ex. « envoyer la position ») et les cas
des **champs** supplémentaires (`server.caseFields`, ex. langue), lus par `chat.body`.

### Dates relatives

Dans les messages : `{{J}}`, `{{J+7}}`, `{{today+7}}` sont remplacés par la date du jour décalée.
Dans les vérifications de date : `J+1` ou une date fixe `2026-12-24`.

### Vérifications intégrées

| Type | Bench | Vérifie |
| --- | --- | --- |
| `path` | les deux | Un chemin du JSON (`data.items.0.name`) avec un opérateur : `equals`, `contains`, `includes` (tableau), `exists`, `absent`, `matches` (regex), `gte`, `lte` |
| `textContains` | les deux | Le texte contient l'un des mots (séparés par des virgules) |
| `textExcludes` | les deux | Le texte ne contient aucun des mots (fuite d'informations…) |
| `textEquals` | les deux | Texte strictement égal |
| `textMatches` | les deux | Le texte correspond à une expression régulière |
| `prose` | les deux | Texte rédigé : non vide et pas un code (ex. `empty_results`) |
| `maxLatency` | les deux | Temps de réponse ≤ N secondes |
| `language` | les deux | Langue de la réponse : la même que le message utilisateur (`message`, par défaut) ou une langue donnée (`fr`, `en`, `es`…). Chemin JSON facultatif du texte à analyser (ex. `reply`) |
| `kind` | serveur | Type de réponse (`chat.kind`) |
| `notError` | serveur | Ni erreur HTTP, ni erreur technique |
| `status` | serveur | Code HTTP |

À propos de `language` : la détection ne fait appel à aucun service externe. Langues reconnues :
français, anglais, espagnol, allemand, italien, portugais, néerlandais (mots courants), arabe, russe,
chinois, japonais, coréen, hébreu, grec (écriture). Pour une réponse JSON sans chemin, seules ses
phrases rédigées sont analysées (les clés et les codes comme `no_results` sont ignorés). Le résultat
indique les langues détectées, ex. `langue = celle du message (réponse en fr, attendu en)`. Un message
trop court pour en déduire la langue (`ok`, un nom propre) n'est pas vérifié.

Dans le bench serveur, une étape **sans vérification** réussit si elle n'est pas une erreur technique.

### Vérifications métier

Déclarées dans `prompt.checks` ou `server.checks`, elles apparaissent dans l'éditeur de cas avec leurs
champs :

```ts
checks: {
  hasBooks: {
    description: "Au moins N livres trouvés",
    fields: [{ name: "min", label: "Minimum", kind: "number" }],   // champs éditables dans l'interface
    label: (c) => `≥ ${c.min} livre(s)`,                          // résumé affiché
    test: (s, c, h) => (s.json?.data?.books?.length ?? 0) >= Number(c.min),
    gate: false,   // true : si elle échoue, les vérifications suivantes ne sont pas évaluées
  },
},
```

| Paramètre de `test` | Contenu |
| --- | --- |
| `s.json` | Réponse analysée en JSON (`null` si absente) |
| `s.text` | Réponse brute du modèle, ou message rédigé du serveur |
| `s.latencyMs` | Temps de réponse |
| `s.status`, `s.kind` | Bench serveur : code HTTP et type de réponse |
| `c` | La vérification telle que saisie (ses champs) |
| `h.date(v)` | `"J+1"`, `"{{J+1}}"`, `"2026-12-24"` → date ISO |
| `h.get(obj, "a.b.0")` | Lecture d'un chemin |
| `h.lower(v)`, `h.list("a, b")` | Minuscules ; liste séparée par des virgules |

Types de champs : `text`, `number`, `date`, `select` (avec `options`), `boolean`, `tuples`.

---

## Exécution en parallèle

Par défaut, tout s'exécute **l'un après l'autre**, pour des latences comparables. Le parallélisme
accélère les campagnes sur des modèles cloud.

| Bench | Réglage | Ce qui part en parallèle | Ce qui reste séquentiel |
| --- | --- | --- | --- |
| Prompt | **Parallélisme** (interface) · `--parallel <n>` (CLI) | Jusqu'à *n* appels simultanés vers les modèles **distants**, cas répartis entre les modèles | Les modèles **locaux**, l'un après l'autre (ils tournent en même temps que les distants) |
| Serveur | **Serveurs en parallèle** | Jusqu'à *n* serveurs sur modèle **distant** | Les cas d'un même serveur (sinon les captures se mélangeraient) ; les serveurs sur modèle local |

Valeurs de 1 à 16. Les résultats sont remis dans l'ordre (modèle ou serveur, cas, répétition) dans le
rapport.

> En parallèle, la latence mesurée inclut l'attente côté fournisseur. Les offres gratuites limitent
> souvent le débit (HTTP 429) : commencez par 2 ou 3.

---

## Passerelle

Un endpoint **compatible OpenAI** stable : `http://127.0.0.1:4317/gateway/v1`. Votre projet l'appelle
comme son fournisseur habituel ; le modèle réel se choisit dans l'interface, sans redémarrer le projet
ni toucher à son `.env`.

### Brancher le projet (une fois pour toutes)

```sh
LLM_ENDPOINT=http://127.0.0.1:4317/gateway/v1
LLM_API_KEY=llm-bench      # valeur quelconque : la vraie clé est ajoutée par la passerelle
LLM_MODEL=gpt-4o           # valeur quelconque : remplacée par la passerelle
```

À chaque requête, la passerelle remplace le modèle demandé par le modèle choisi, ajoute la clé du
fournisseur, applique `adaptRequest` et relaie le streaming.

### Choisir le modèle

Dans l'onglet **Passerelle** :

- **Bascule Gratuit / Payant** (en haut à droite) : revient au **dernier modèle utilisé** dans cette
  offre ; s'il n'y en a pas encore, au profil de la config de cette offre. Le bouton affiche le modèle
  qu'il active ; il est grisé si aucun modèle de l'offre n'est disponible.
- **Autre modèle** : liste filtrable de tous les modèles de l'offre affichée, puis **Utiliser ce modèle**.
- **Profils de la config** : raccourcis nommés déclarés dans `gateway.profiles`.

En ligne de commande, sur une passerelle déjà lancée :

```sh
llm-bench gateway use free                 # un profil
llm-bench gateway use azure/gpt-4.1        # un modèle précis
llm-bench gateway status                   # modèle actuel et profils
```

Le choix (et le dernier modèle par offre) est enregistré dans `<dataDir>/gateway.json` et relu à chaque
requête : il survit au redémarrage.

```ts
gateway: {
  profiles: { free: "ollama/qwen2.5:7b", paid: "azure/gpt-4.1", rapide: "groq/llama-3.3-70b-versatile" },
  default: "free",   // au premier démarrage
},
```

### Suivi

L'onglet affiche les appels depuis le démarrage (nombre, erreurs, tokens, coût cumulé) et les
50 derniers appels. Un clic sur un appel ouvre son détail complet (voir ci-dessous).

---

## Capture des appels LLM

Chaque appel relayé — par la passerelle ou par le proxy d'un serveur du bench — est enregistré
**séparément**, avec un identifiant unique.

| Information | Détail |
| --- | --- |
| Résumé | Type d'appel (génération, JSON, outils, ou `server.llmCallKind`), modèle, statut HTTP, latence, tokens, coût, `finish_reason`, streaming |
| Messages | Prompt système (dédoublonné, affiché à la demande), **historique renvoyé par votre serveur** (replié), nouveau message, réponse du modèle |
| **URL réelle appelée** | Méthode et URL du fournisseur, hôte et **port** |
| **Clé envoyée** | Nom de l'en-tête et valeur (masquée, bouton « afficher ») |
| Appel du serveur | URL appelée par votre serveur, port local, adresse et port du client |
| Requête reçue du serveur | En-têtes et corps, tels que reçus |
| Requête envoyée au fournisseur | En-têtes et corps après remplacement du modèle et `adaptRequest` |
| Réponse du fournisseur | Statut, en-têtes, corps (en streaming : un événement SSE par élément), taille |

Tous les JSON sont affichés indentés et colorés.

> **« Je vois les messages des requêtes précédentes »** : un chatbot renvoie au modèle toute la
> conversation à chaque tour. Si votre serveur garde l'historique par session et que vos requêtes
> n'envoient pas d'identifiant de session (ou toujours le même), elles partagent un seul historique.
> Le bloc « Requête reçue du serveur — corps » montre exactement ce que votre serveur a envoyé.

---

## Coûts

- Chaque fournisseur est `free` ou `paid` ; un modèle gratuit coûte 0.
- Les prix se déclarent **par million de tokens**, par modèle, dans `pricing` (`"*"` pour tous les
  modèles non listés), ou depuis l'interface pour un modèle payant ajouté.
- La devise est `currency` (défaut `$`).
- Les rapports affichent le coût total, le coût par appel et par cas ; la passerelle affiche le coût
  cumulé. Un modèle payant sans prix est signalé « sans prix ».

---

## Référence de la configuration

Le type complet et la documentation de chaque option sont dans [`src/config.ts`](src/config.ts) ;
un exemple commenté dans [`examples/minimal-chatbot/bench.config.ts`](examples/minimal-chatbot/bench.config.ts).
Dans ce dépôt, `defineConfig` apporte l'autocomplétion ; ailleurs, `export default { … }` suffit.

### Exemple complet

```ts
export default {
  name: "Mon chatbot",
  currency: "€",

  providers: {
    ollama: { kind: "ollama", baseUrl: "http://localhost:11434/v1", tier: "free" },
    azure: { baseUrl: process.env.AZURE_ENDPOINT, apiKey: process.env.AZURE_KEY, tier: "paid",
             models: ["gpt-4.1"], pricing: { "gpt-4.1": { input: 2, output: 8 } } },
  },

  prompt: {
    system: { module: "../src/prompts.ts", export: "SYSTEM_PROMPT" },
    request: (model) => ({ temperature: 0, response_format: { type: "json_object" } }),
    checks: { /* vérifications métier */ },
  },

  server: {
    source: "..",
    env: { port: "PORT", baseUrl: "LLM_ENDPOINT", apiKey: "LLM_API_KEY", model: "LLM_MODEL" },
    install: ["npm ci"],
    build: ["npm run build"],
    start: "node dist/main.js",
    health: "/health",
    chat: {
      path: "/chat",
      body: (ctx) => ({ message: ctx.message, sessionId: ctx.sessionId }),
      kind: (status, json) => (status === 200 ? json.type : "error"),
      reply: (json) => json.reply,
    },
  },

  gateway: { profiles: { free: "ollama/qwen2.5:7b", paid: "azure/gpt-4.1" }, default: "free" },
};
```

### Racine

| Option | Défaut | Description |
| --- | --- | --- |
| `name` | — | Nom affiché dans l'interface |
| `providers` | **obligatoire** | Fournisseurs (au moins un ; noms : lettres, chiffres, `-`, `_`) |
| `dataDir` | dossier de la config | Où sont rangés cas, rapports et fichiers générés |
| `port` | `4317` | Port de l'interface, du proxy et de la passerelle |
| `currency` | `$` | Devise des prix |
| `prompt` | — | Bench prompt (facultatif) |
| `server` | — | Bench serveur (facultatif) |
| `gateway` | — | Profils de la passerelle (facultatif) |

### `providers.<nom>`

| Option | Défaut | Description |
| --- | --- | --- |
| `kind` | `"openai"` | `"openai"` : toute API compatible ; `"ollama"` : idem + gestion des modèles locaux |
| `label` | nom | Libellé affiché |
| `baseUrl` | — | URL compatible OpenAI, ex. `http://localhost:11434/v1` |
| `apiKey` | — | Clé API (lisez-la depuis `process.env`) |
| `apiKeyHeader` | `authorization` | En-tête de la clé : `authorization` (`Bearer …`) ou un nom, ex. `api-key` |
| `headers` | — | En-têtes ajoutés à chaque requête |
| `tier` | `free` pour Ollama, sinon `paid` | Offre |
| `models` | — | Modèles proposés (Ollama : les modèles installés s'ajoutent) |
| `listModels` | `false` | Interroge `GET /models` pour lister les modèles |
| `pricing` | — | `{ "<modèle>" \| "*": { input, output } }`, par million de tokens |
| `adaptRequest` | adaptation des modèles de raisonnement | `(body, { provider, model }) => body` |

### `prompt`

| Option | Défaut | Description |
| --- | --- | --- |
| `system` | **obligatoire** | Texte, fonction, `{ module, export }` ou `{ file }` |
| `version` | empreinte du texte | Texte, fonction ou `{ module, export }` |
| `user` | message tel quel | `(message, { history, today, tomorrow, case }) => string` |
| `request` | `temperature: 0`, `max_tokens: 4096` | `(model) => paramètres` ajoutés au corps |
| `parse` | `"json"` | `"json"`, `"text"` ou une fonction |
| `categories` | — | Catégories proposées dans l'éditeur |
| `checks` | — | Vérifications métier |
| `newCase` | — | Valeurs par défaut d'un nouveau cas (catégorie, vérifications) |

### `server`

| Option | Défaut | Description |
| --- | --- | --- |
| `start` | **obligatoire** | Commande de démarrage |
| `source` | dossier parent de la config | Projet copié pour chaque serveur |
| `instancesDir` | `../<projet>-bench-servers` | Dossier des copies |
| `exclude` | — | Chemins exclus de la copie (en plus de `node_modules`, `.git`…) |
| `envFile` | `.env` | Fichier d'environnement recopié |
| `env` | voir [Variables](#variables-denvironnement) | Noms des variables endpoint / clé / modèle / port |
| `install` | aucune | Commandes d'installation |
| `build` | aucune | Commandes de build (rejouées à chaque ↻ Code) |
| `readyFile` | — | Fichier qui doit exister avant de démarrer (ex. `dist/main.js`) |
| `shareDirs` | `["node_modules"]` | Dossiers partageables par lien symbolique |
| `health` | `/health` | Route de santé (prêt quand 2xx) |
| `startTimeoutMs` | 90 s | Délai maximal de démarrage |
| `firstPort` | `3101` | Premier port attribué aux serveurs |
| `chat` | voir ci-dessous | Forme de l'API de chat |
| `stepOptions` | — | Options d'étape (champs), lues par `chat.body` |
| `caseFields` | — | Champs de cas supplémentaires |
| `categories` | — | Catégories proposées |
| `checks` | — | Vérifications métier |
| `llmCallKind` | génération / JSON / outils | `(body, systemPrompt) => nom` affiché pour chaque appel LLM |

### `server.chat`

| Option | Défaut | Description |
| --- | --- | --- |
| `path` | `/chat` | Route de chat |
| `method` | `POST` | Méthode HTTP |
| `timeoutMs` | 240 s | Délai par étape |
| `headers` | — | `(ctx) => en-têtes` |
| `body` | `{ message, sessionId }` | `(ctx) => corps` ; `ctx` : `message`, `sessionId`, `index`, `step`, `case`, `memory` |
| `kind` | `success` si 2xx + JSON, sinon `error` | `(status, json) => type` ; `error` = erreur technique |
| `kinds` | — | Types possibles (proposés dans la vérification `kind`) |
| `reply` | `json.reply ?? json.message` | Message rédigé de la réponse |
| `summary` | — | Résumé court d'une étape (ex. « 12 résultat(s) ») |
| `remember` | — | `(json, memory) => void` : garde des éléments pour les étapes suivantes |
| `redactRequest` / `redactResponse` | — | Version allégée enregistrée dans le rapport |

### `gateway`

| Option | Description |
| --- | --- |
| `profiles` | `{ nom: "fournisseur/modèle" }` : raccourcis de la passerelle |
| `default` | Profil ou modèle au premier démarrage |

---

## Ligne de commande

```sh
llm-bench doctor  [--yes | --no]
llm-bench init    [--dir bench] [--force]
llm-bench ui      [--open] [--port 4317] [--config bench/bench.config.ts]
llm-bench prompt  --models ollama/qwen2.5:7b,azure/gpt-4.1 [--cases a,b] [--runs 3] [--parallel 4] [--name "v2"] [--verbose]
llm-bench prompt  --tier free           # tous les modèles gratuits disponibles (free | paid | all)
llm-bench gateway use <profil|fournisseur/modèle>
llm-bench gateway status
llm-bench --help
```

### Commandes

#### `llm-bench doctor`

Vérifie les prérequis et propose d'installer ce qui manque : Node.js 22+, dépendances npm, Ollama
(installé, serveur démarré, au moins un modèle). Fonctionne avant `npm install`
(`node bin/llm-bench.mjs doctor`). Détails : [Vérifier les prérequis](#vérifier-les-prérequis).

- `--yes` : accepte toutes les propositions (installation sans intervention) · `--no` : bilan seul,
  n'installe rien.
- Code de sortie `1` s'il manque encore un prérequis obligatoire (Node.js, dépendances).

```sh
llm-bench doctor            # interactif
llm-bench doctor --yes      # installe tout ce qui manque sans demander
```

#### `llm-bench init`

À lancer à la racine du projet à tester. Détecte la technologie, les variables du modèle, les routes
de chat et de santé et le prompt système, puis crée `bench/bench.config.ts`, des cas de départ
(`server-cases.json`, `prompt-cases.json`) et `bench/.gitignore`. Affiche ce qu'il a détecté (✓ sûr,
? à vérifier) ; ce qu'il n'a pas pu déduire est marqué « À VÉRIFIER » dans la config. Détails :
[Brancher votre projet](#brancher-votre-projet).

- `--dir <dossier>` : dossier de la config (défaut `bench`).
- `--force` : remplace un `bench.config.ts` existant (les cas et le `.gitignore` existants sont gardés).
- Les commentaires générés suivent la langue de la ligne de commande (`LLM_BENCH_LANG`).

#### `llm-bench ui` (commande par défaut)

Démarre l'interface web, le proxy du bench serveur (`/llm/<id>`) et la passerelle (`/gateway/v1`) sur
`127.0.0.1`, et affiche leurs URL. Reste au premier plan : **Ctrl+C** l'arrête, ainsi que tous les
serveurs qu'il a lancés. `llm-bench` sans commande fait la même chose.

- `--open` : ouvre l'interface dans le navigateur.
- `--port <n>` : port de l'interface, du proxy et de la passerelle (défaut : config, puis `4317`).
- `--config <fichier>` : configuration à utiliser (défaut : `bench.config.ts`, puis
  `bench/bench.config.ts` dans le dossier courant).

#### `llm-bench prompt`

Lance une campagne du bench prompt sans l'interface (pratique dans un script ou en CI) : envoie
chaque cas de test à chaque modèle avec le prompt système du projet, affiche chaque résultat (✅ réussi,
❌ échoué, 💥 erreur) et un tableau de synthèse par modèle (score, JSON valide, latence, tokens/s, coût),
puis écrit le rapport en JSON et en Markdown dans `results/`. Nécessite une section `prompt` dans la
config.

- `--models <a,b>` : modèles à tester, au format `fournisseur/modèle`.
- `--tier <free|paid|all>` : à défaut de `--models`, tous les modèles disponibles de l'offre (défaut
  `free`).
- `--cases <a,b>` : ne lancer que ces cas · `--runs <n>` : répétitions par cas.
- `--parallel <n>` : appels simultanés vers les modèles distants ; les modèles locaux restent à la suite.
- `--name <texte>` : nom du rapport · `--verbose` : affiche aussi la réponse brute de chaque appel.

```sh
llm-bench prompt --tier free --runs 3
llm-bench prompt --models ollama/qwen2.5:7b,openai/gpt-4.1-mini --cases search-author --verbose
```

Les rapports apparaissent aussi dans l'interface (**Bench prompt → Rapports**).

#### `llm-bench gateway use <cible>`

Choisit le modèle derrière la passerelle : un profil de la config (`free`, `paid`…) ou un
`fournisseur/modèle`. Prend effet tout de suite sur une passerelle déjà lancée (le choix est
enregistré dans `gateway.json`, relu à chaque requête), sans redémarrer votre projet. Échoue si le
fournisseur est inconnu ou inutilisable (ex. clé API absente).

```sh
llm-bench gateway use paid
llm-bench gateway use ollama/qwen2.5:7b
```

#### `llm-bench gateway status`

Affiche l'URL de la passerelle, le modèle actuel (avec son offre et son profil) et les profils
déclarés dans la config.

#### `llm-bench --help`

Liste les commandes et les options, dans la langue courante.

### Options

| Option | Commandes | Description |
| --- | --- | --- |
| `-c, --config <fichier>` | toutes | Fichier de configuration |
| `--port <n>` | toutes | Port de l'interface et de la passerelle |
| `--open` | `ui` | Ouvre le navigateur |
| `--dir`, `--force` | `init` | Dossier de la config ; remplacer une config existante |
| `--models <a,b>` | `prompt` | Modèles à tester |
| `--tier <free\|paid\|all>` | `prompt` | À défaut de `--models` : tous les modèles de l'offre (défaut `free`) |
| `--cases <a,b>` | `prompt` | Ne lancer que ces cas |
| `--runs <n>` | `prompt` | Répétitions par cas (défaut 1) |
| `--parallel <n>` | `prompt` | Appels simultanés vers les modèles distants (défaut 1) |
| `--name <texte>` | `prompt` | Nom du rapport |
| `--verbose` | `prompt` | Affiche la réponse brute de chaque appel |

### Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `BENCH_PORT` | Port de l'interface (prioritaire sur la config) |
| `BENCH_INSTANCES_DIR` | Dossier des copies de serveurs |
| `BENCH_SERVER_PORT` | Premier port des serveurs |
| `LLM_BENCH_LANG` | Langue de la ligne de commande : `fr` ou `en` (voir [Langue](#langue)) |

---

## Fichiers et stockage

| Quoi | Où | Durée de vie |
| --- | --- | --- |
| Configuration, cas de test | `bench.config.ts`, `prompt-cases.json`, `server-cases.json` | Versionnés avec le projet |
| Rapports du bench prompt | `<dataDir>/results/*.json` (+ `.md` en CLI) | Sur disque |
| Rapports du bench serveur (avec les appels LLM, clés masquées) | `<dataDir>/results-servers/` | Sur disque |
| Modèle de la passerelle, dernier modèle par offre | `<dataDir>/gateway.json` | Sur disque |
| Modèles et clés saisis dans l'interface | `<dataDir>/providers.local.json` | Sur disque, **clés en clair** |
| Prompt système collé dans l'interface | `system-prompt.md`, à côté de la config | Versionnable |
| Copies des serveurs | `instancesDir` (défaut `../<projet>-bench-servers`) | Jusqu'à suppression |
| Appels de la passerelle | **En mémoire** (200 derniers) | Effacés au redémarrage |

`<dataDir>` est le dossier de la config, sauf si `dataDir` est défini. `init` crée un `.gitignore` qui
exclut les fichiers générés.

---

## Sécurité

- L'interface, le proxy et la passerelle n'écoutent que sur **`127.0.0.1`** : ils ne sont pas
  joignables depuis le réseau.
- Les clés API restent côté bench : votre serveur et vos copies reçoivent une clé factice, la vraie est
  ajoutée au moment de relayer.
- `providers.local.json` contient des clés **en clair** : il est ignoré par git, ne le partagez pas.
- Dans les rapports écrits sur disque, les clés sont **masquées**. Dans la passerelle (mémoire
  seulement), la clé est conservée pour le détail des appels et masquée à l'affichage par défaut.
- La config est du code exécuté : n'utilisez que des configurations de confiance.

---

## Dépannage

| Symptôme | Cause probable | Solution |
| --- | --- | --- |
| « clé API absente » | Variable d'environnement non chargée | Vérifiez le `.env` lu par la config, ou 🔑 dans **Modèles** |
| HTTP 429 | Limite de débit de l'offre gratuite | Baissez le parallélisme, espacez les campagnes |
| « contexte probablement tronqué » | Contexte Ollama trop petit pour le prompt | Augmentez `OLLAMA_CONTEXT_LENGTH` et relancez Ollama |
| La passerelle répond 503 | Aucun modèle choisi | Onglet **Passerelle** ou `llm-bench gateway use <profil>` |
| Un serveur ne démarre pas | Commande, build ou route de santé | **📄 journal** du serveur ; vérifiez `start`, `health`, `readyFile` |
| Les appels LLM du serveur ne sont pas capturés | Le serveur n'utilise pas la variable d'endpoint | **Bench serveur → Variables** : vérifiez que le code lit bien ce nom |
| L'historique s'accumule d'une requête à l'autre | Votre serveur garde la conversation par session | Envoyez un nouvel identifiant de session, ou redémarrez votre serveur |
| Un modèle de raisonnement refuse un paramètre | `temperature`, `max_tokens`… non supportés | `adaptRequest` sur le fournisseur |

---

## Développement

```sh
npm install
npm run typecheck      # tsc --noEmit
npm run i18n:check     # traductions anglaises manquantes
```

| Fichier | Rôle |
| --- | --- |
| `bin/llm-bench.mjs` | Point d'entrée (lance `src/cli.ts` via tsx) |
| `bin/doctor.mjs` | `llm-bench doctor` : vérification et installation des prérequis (JavaScript pur, sans dépendance) |
| `src/cli.ts` | Ligne de commande |
| `src/config.ts` | Types et chargement de la configuration |
| `src/http.ts` | Serveur HTTP : API de l'interface, proxy `/llm/<id>`, passerelle `/gateway` |
| `src/providers.ts` | Fournisseurs, appels, coûts, adaptation des requêtes |
| `src/capture.ts` | Relais et capture des appels LLM |
| `src/gateway.ts` | Passerelle |
| `src/prompt-bench.ts` | Bench prompt |
| `src/server-bench.ts` | Bench serveur |
| `src/instances.ts` | Copies des serveurs (copie, install, build, démarrage) |
| `src/checks.ts` | Vérifications intégrées |
| `src/prompt-source.ts` | Détection et lecture du prompt système |
| `src/init.ts` | Commande `init` |
| `src/stacks.ts` | Détection de la technologie (Node, Python, Go, Java, .NET, Ruby, PHP) et commandes générées |
| `src/ollama.ts` | Modèles locaux et catalogue Ollama |
| `src/i18n.ts` | Langue courante et traduction (`tr`) |
| `src/i18n/` | Traductions anglaises (`en-*.ts`) du serveur et de la CLI |
| `scripts/i18n-check.mjs` | Liste des traductions manquantes (`npm run i18n:check`) |
| `ui/index.html` | Interface (un seul fichier, sans build) |
| `examples/minimal-chatbot/` | Chatbot d'exemple et sa configuration |

## Licence

[MIT](LICENSE) © ennosof
