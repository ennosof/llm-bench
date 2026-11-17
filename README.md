**English** · [Français](README.fr.md)

# llm-bench

**Compare LLM models on your own project — local or cloud, free or paid — and switch from one to
another without touching your code.**

llm-bench answers three questions:

1. **Which model responds best to my prompt?** → *Prompt bench*: your project's system prompt is sent
   directly to each model, and the responses are checked automatically.
2. **Does my application work just as well with another model?** → *Server bench*: copies of your
   server (HTTP chatbot, chat API…) are started, each with a model, then tested end to end with
   scripted conversations.
3. **How do I switch models in one click while developing?** → *Gateway*: a fixed OpenAI-compatible
   endpoint; the actual model behind it is chosen in the interface.

Every model call is **captured** (actual URL, request, response, tokens, cost) and every campaign
produces a **report** (score, latency, tokens/s, cost per case).

Everything is driven from a **local web interface** (listening on `127.0.0.1` only). A command line
covers the prompt bench and the gateway. Only dependency: [`tsx`](https://github.com/privatenumber/tsx).

---

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Language](#language)
- [Basic concepts](#basic-concepts)
- [Connecting your project](#connecting-your-project)
- [The interface](#the-interface)
- [Models and providers](#models-and-providers)
- [Prompt bench](#prompt-bench)
- [Server bench](#server-bench)
- [Test cases and checks](#test-cases-and-checks)
- [Parallel execution](#parallel-execution)
- [Gateway](#gateway)
- [LLM call capture](#llm-call-capture)
- [Costs](#costs)
- [Configuration reference](#configuration-reference)
- [Command line](#command-line)
- [Files and storage](#files-and-storage)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Requirements

| Tool | Version | What for |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | **22 or later** | Required |
| npm dependencies (`tsx`) | — | Required, installed by `npm install` |
| [Ollama](https://ollama.com) | recent | Optional: free local models |
| API keys (OpenAI, OpenRouter, Groq, Azure…) | — | Optional: cloud models |

Any provider exposing an **OpenAI-compatible API** (`/v1/chat/completions`) works.

### Check the requirements

Node.js must be installed to run anything ([nodejs.org](https://nodejs.org), `brew install node`,
`winget install OpenJS.NodeJS`, or `nvm install 22`). Then, from the cloned repository:

```sh
node bin/llm-bench.mjs doctor      # once installed: llm-bench doctor
```

`doctor` needs no dependency (it works before `npm install`). It checks each requirement and, for
anything missing, **offers to install it** (answer `y` / `n`):

| Check | If missing or not ready, it offers to… |
| --- | --- |
| Node.js ≥ 22 | Upgrade: `brew install node` (macOS), `winget install OpenJS.NodeJS` (Windows); otherwise shows the manual steps |
| npm dependencies | Run `npm install` in the repository |
| Ollama installed | Install it: `brew install ollama` (macOS), `winget install Ollama.Ollama` (Windows), official script (Linux); otherwise shows the download page |
| Ollama server running | Start it: `brew services start ollama` or `ollama serve` |
| At least one local model | Download `qwen2.5:7b` (≈ 4.7 GB; default answer: no) |

Ollama is optional: without it, only cloud models are available. Options: `--yes` accepts every
proposal (unattended setup), `--no` only reports. Exit code `1` if a required item is missing.

## Installation

```sh
git clone https://github.com/ennosof/llm-bench.git
cd llm-bench
node bin/llm-bench.mjs doctor   # checks requirements, installs what is missing (npm install included)
npm link                        # makes the `llm-bench` command available everywhere
```

Check: `llm-bench --help`.

## Language

The whole tool (web interface, command line, error messages, generated configuration, reports) is
available in English and French.

- **Web interface**: **FR / EN** switch in the header (top right). By default, the browser language
  (French if the browser is in French, otherwise English); the choice is remembered by the browser.
  Campaign reports and messages coming from the server follow the interface language.
- **Command line**: `LLM_BENCH_LANG=fr` or `LLM_BENCH_LANG=en`; otherwise the system language
  (`LC_ALL`, `LC_MESSAGES`, `LANG`); English by default.

  ```sh
  LLM_BENCH_LANG=fr llm-bench prompt --tier free
  ```

- `llm-bench init` writes the generated configuration comments in that language.
- **Contributors**: French text is the translation key: `tr("…")` in the code, English in
  `src/i18n/en-*.ts` (server, CLI) and `UI_EN` in `ui/index.html`. `npm run i18n:check` lists missing
  translations.

## Basic concepts

| Concept | Meaning |
| --- | --- |
| **Provider** | An OpenAI-compatible endpoint declared in the config (`ollama`, `openrouter`, `azure`…). |
| **Model** | Always written `provider/model`, e.g. `ollama/qwen2.5:7b`, `openrouter/meta-llama/llama-3.3-70b-instruct:free`. Only the first `/` separates the two. |
| **Tier** (`tier`) | `free` or `paid`. Used for filters, gateway switching and costs. Ollama is `free` by default, the others `paid`. |
| **Local / remote** | A model is *local* if its provider is Ollama or points to `localhost` / `127.0.0.1`. Local models are never run in parallel (memory, GPU). |
| **Test case** | A message (or a conversation) and the checks expected on the response. |
| **Campaign** | Running several cases on several models or servers; it produces a report. |

---

## Connecting your project

Your project **has no dependency** on llm-bench and can be written in **any language** (Node, Python,
Go, Java, .NET, Ruby, PHP…): all it needs is a configuration file and test cases, stored next to the code.

### 1. Generate the configuration

From the root of your project:

```sh
llm-bench init          # creates bench/bench.config.ts, starter cases and bench/.gitignore
```

`init` analyzes the project and fills in what it can. Anything it could not determine is marked
**"TO CHECK"** in the file:

| Item | Where detection comes from |
| --- | --- |
| Stack, `install` / `build` / `start` commands | Node, Python, Go, Java, .NET, Ruby, PHP: see [Any language](#any-language) |
| Model variables (endpoint, key, model, port) | Names found in `.env`, `.env.example`…, then in the code (`process.env.X`, `os.environ`, `getenv`), chosen by pattern (`LLM_ENDPOINT`, `OPENAI_BASE_URL`, `*_API_KEY`, `*_MODEL`, `PORT`…) |
| Chat route and health route | Routes declared in the code (Express, Fastify, Nest `@Post`, FastAPI…) containing `chat`, `message`… or `health`, `ping`… |
| System prompt | See [System prompt](#system-prompt) |

Options: `--dir <folder>` (default `bench`), `--force` (replaces an existing config).

> ⚠️ `init` adds a gateway profile `free: "ollama/qwen2.5:7b"` by default: replace it with
> your models (see [Gateway](#gateway)).

### 2. Review the configuration

Open `bench/bench.config.ts`, fix the "TO CHECK" lines, and adapt it to your API format:

- `server.chat.body`: the body of the chat request sent to your server;
- `server.chat.reply` / `server.chat.kind`: how to read the response.

Put the API keys in the project's `.env` (the config reads them, it never writes them).

### 3. Run the interface

```sh
llm-bench ui --open
```

### Resulting structure

```
my-project/
├── bench/
│   ├── bench.config.ts       providers, prompt, server, gateway, checks (versioned)
│   ├── prompt-cases.json     prompt bench cases    (versioned; editable in the interface)
│   ├── server-cases.json     server bench cases    (versioned; editable in the interface)
│   ├── .gitignore            ignores the generated data below
│   ├── results/              prompt bench reports               (generated)
│   ├── results-servers/      server bench reports               (generated)
│   ├── gateway.json          model chosen for the gateway       (generated)
│   └── providers.local.json  models and keys entered in the UI  (generated, contains keys)
└── .env                      API keys
```

The config is looked up, in order: `bench.config.ts`, `bench.config.mjs`, `bench.config.js`,
`bench/bench.config.ts`, `bench/bench.config.mjs`, or via `--config <file>`. It is executed by
`tsx`: it can **import the project's code** (system prompt, utilities) and declare
**functions** (business checks, request building…).

---

## The interface

`llm-bench ui` starts on `http://localhost:4317` (port configurable). Four menus:

| Menu | Tabs | Role |
| --- | --- | --- |
| **Models** | Free · Paid | Manage Ollama models, browse free tiers, add paid models |
| **Prompt bench** | Run · Reports · Test cases · System prompt | Test the system prompt directly on the models |
| **Server bench** | Servers · Run · Reports · Test cases · Variables | Test your server end to end (visible if the config has a `server` section) |
| **Gateway** | — | Choose the model behind the stable endpoint, view captured calls |

The **All / Free / Paid** filter appears wherever you choose a model; the list then only offers models
of the chosen tier, and the last model chosen in each tier is remembered when you switch.

---

## Models and providers

### Declaring providers in the config

```ts
providers: {
  ollama:     { kind: "ollama", baseUrl: "http://localhost:11434/v1", tier: "free" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_API_KEY, tier: "free",
                models: ["meta-llama/llama-3.3-70b-instruct:free"] },
  azure:      { baseUrl: process.env.AZURE_ENDPOINT, apiKey: process.env.AZURE_KEY, apiKeyHeader: "api-key",
                tier: "paid", models: ["gpt-4.1"],
                pricing: { "gpt-4.1": { input: 2, output: 8 } } },   // price per million tokens
},
```

A remote provider **without an API key** is shown but unusable ("API key missing").

### Models menu

- **Free**
  - Installed Ollama models (deletion).
  - Download from the ollama.com catalog (search, variant selection, progress).
  - Free cloud tiers declared in the config (read-only).
- **Paid**
  - List of paid models, edit ✎, delete 🗑.
  - **+ Add a model**: provider, OpenAI-compatible endpoint, key, key header, model, price.
  - **Pre-fill** takes the endpoint, model and key from the project's `.env` (variables from `server.env`).
  - 🔑 sets the key of a config provider from the interface (takes precedence over the config).

What is entered in the interface is saved in `<dataDir>/providers.local.json` (**keys in plain text**,
ignored by git), without ever modifying `bench.config.ts`.

### Request adaptation

Some models reject parameters (e.g. `temperature` or `max_tokens` on reasoning models). By default,
llm-bench removes `temperature` and turns `max_tokens` into `max_completion_tokens` for these models.
For full control, declare `adaptRequest`:

```ts
azure: {
  // …
  adaptRequest: (body, { model }) => (model.startsWith("o") ? { ...body, temperature: undefined } : body),
},
```

`adaptRequest` applies everywhere: prompt bench, server bench proxy and gateway.

---

## Prompt bench

The project's system prompt is sent **directly** to the model with each case's message. No server to
start: a few seconds per case, ideal for shortlisting models and fine-tuning a prompt.

### System prompt

`init` looks for the system prompt and saves it if it finds it; otherwise, choose it in
**Prompt bench → System prompt**. Detection:

1. spots texts used as a system message (`new SystemMessage(X)`, `role: "system"`,
   `system: X`…) and traces them back to their export;
2. failing that, exports named like a system prompt, then prompt `.md` / `.txt` files;
3. runs each candidate export in a separate process to read the **actual text** (assembled prompts
   included);
4. uses a nearby version export (`PROMPT_VERSION`…) as the version.

Possible sources in the config:

```ts
prompt: {
  system: { module: "../src/llm/prompts/index.ts", export: "SYSTEM_PROMPT" },
  // or: { file: "./system-prompt.md" } · a string · a function (async or not)
  version: { module: "../src/llm/prompts/version.ts", export: "PROMPT_VERSION" }, // optional
},
```

The prompt is **re-read at every campaign**: a change in the project is tested from the next
campaign. Without `version`, a fingerprint of the text is used as the version.

### How a campaign runs

1. For each Ollama model: a first, unmeasured call loads the model into memory (the load time is
   shown separately).
2. Each case is sent: `[system, …case history, user message]`, with the parameters from
   `prompt.request` (default: `temperature: 0`, `max_tokens: 4096`).
3. The response is read according to `prompt.parse` (`"json"` by default: from the first `{` to the
   last `}`), then the case's checks are evaluated.

### Report

Per model: **score** (passed cases), **valid JSON**, errors, mean and median latency, input and output
tokens, **tokens/s**, **total and per-call cost**, load time.

Per case: raw response, passed / failed checks, tokens. A case can be **replayed** individually (with
its current version if it was modified); previous attempts remain visible.

A **"context probably truncated"** warning appears when Ollama received significantly fewer tokens
than the prompt size: increase `OLLAMA_CONTEXT_LENGTH`.

---

## Server bench

Tests **your actual application**: copies of the project are started, each with a model, then
receive conversations on their chat route.

### Any language

The tested server can be written in **any language**: llm-bench only talks to it over HTTP, through
environment variables and shell commands. Node.js is only needed to run llm-bench itself. `init`
recognizes the stack and generates matching commands:

| Language / stack | Detected from | Generated commands (`install` → `build` → `start`) |
| --- | --- | --- |
| **Node** (npm, yarn, pnpm, bun) | `package.json` + lock file | `npm ci` → `npm run build` (if any) → `node <main>` or the `start` script |
| **Python** (uv, Poetry, Pipenv, pip) | `pyproject.toml`, `uv.lock`, `poetry.lock`, `Pipfile`, `requirements.txt` | `uv sync` / `poetry install` / `pipenv install` / `python3 -m venv .venv && pip install …` → — → FastAPI: `uvicorn module:app --port $PORT` · Flask: `flask --app module:app run --port $PORT` · Django: `manage.py runserver 127.0.0.1:$PORT` · otherwise `python main.py` |
| **Go** | `go.mod` (`main.go` or `cmd/<name>/main.go`) | `go mod download` → `go build -o .bench-bin/server ./cmd/<name>` → `./.bench-bin/server` |
| **Java** (Maven, Gradle; Spring Boot) | `pom.xml`, `build.gradle(.kts)`, `mvnw` / `gradlew` | `mvn dependency:go-offline` → `mvn package` / `gradle bootJar` → `java -jar <jar> --server.port=$PORT` |
| **.NET** | `*.csproj`, `*.fsproj`, `*.sln` | `dotnet restore` → `dotnet build -c Release` → `dotnet run --no-build --urls http://127.0.0.1:$PORT` |
| **Ruby** (Rails, Rack) | `Gemfile`, `config/application.rb`, `config.ru` | `bundle install` → — → `rails server -p $PORT` / `rackup -p $PORT` |
| **PHP** (Laravel, Composer) | `composer.json`, `artisan` | `composer install` → — → `php artisan serve --port=$PORT` / `php -S 127.0.0.1:$PORT -t public` |

- `install`, `build` and `start` are **shell commands** run inside the copy (`sh` on macOS / Linux,
  `cmd.exe` on Windows). The port variable (`$PORT`, or the name set in `server.env.port`) holds the
  port assigned to the copy.
- **Windows**: `$PORT` and `${VAR}` work there too (the bench replaces them itself, since `cmd.exe`
  doesn't). Commands that differ (`.venv\Scripts\` instead of `.venv/bin/`, `gradlew.bat`,
  `mvnw.cmd`, `server.exe`, finding the jar with PowerShell) are generated as
  `win ? "…" : "…"` in the config, so the same `bench.config.ts` works on every system. Servers are
  stopped with `taskkill` (whole process tree) and shared folders are linked as junctions (no
  administrator rights needed).
- Dependency folders and build output (`.venv`, `vendor`, `target`, `bin/obj`…) are excluded from the
  copy (`exclude`); `.venv`, `node_modules` or `vendor` can be **shared** with the project instead of
  installed (`shareDirs`, "Share" option when creating a server). If a shared folder doesn't exist yet
  in the project (dependencies never installed), the copy installs its own.
- In a repository with several stacks (e.g. a `package.json` for front-end tooling next to a Python
  API), the actual server wins; the others are listed as a comment in the generated config.
- A stack that isn't recognized gets "TO CHECK" placeholders: write the three commands yourself.

Requirements for the server, whatever the language: read the endpoint, key, model and port from
environment variables; expose a JSON chat route and a health route; call an OpenAI-compatible API
(`/chat/completions`).

Python (FastAPI) example:

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
prompt: { system: { file: "../app/prompts/system.md" } },   // importing a module only works for JS/TS
```

### Server lifecycle

| Step | Detail |
| --- | --- |
| **Copy** | The `source` folder **as it is on disk** (uncommitted changes included) is copied to `instancesDir/<id>`, without `node_modules`, `.git`, the bench data or the `exclude` paths |
| **Environment** | The project's `envFile` (`.env`) is copied, with the model variables replaced (endpoint, key, model, port) |
| **Installation** | `install` commands, or a symbolic link to the project's `node_modules` ("Share" option, instant) |
| **Build** | `build` commands |
| **Start** | `start` command; the server is ready when `health` responds with 2xx (timeout `startTimeoutMs`) |

Each server gets its own port, starting from `firstPort` (default `3101`).

Actions in **Server bench → Servers**: ▶ start / ■ stop, **↻ Code** (re-copy + build +
restart), **✎** change model (restart only), **📄** log, **📦** reinstall,
**🗑** delete. A server's detail view shows its folder, variables, URL and commands.

### How the model is wired

The server calls its model **through the bench**: at startup, its endpoint variable receives
`http://127.0.0.1:4317/llm/<id>`. The bench relays to the real provider (key added, `adaptRequest`
applied, streaming included) and **records every call**. The `.env` written in the copy, however,
contains the real endpoint: the copy remains usable on its own.

### Environment variables

**Server bench → Variables**: names of the variables through which the server receives its model.

| Role | Default |
| --- | --- |
| Endpoint | `LLM_ENDPOINT` |
| API key (empty if the project does not read one) | `LLM_API_KEY` |
| Model | `LLM_MODEL` |
| Port | `PORT` |

The page shows whether each name appears in the project's `.env` or is read by its code. A change
rewrites the `server.env` block of `bench.config.ts` and applies to new servers.

### How a case runs

- A **fresh session** per case: `ctx.sessionId` is unique, to be passed in `chat.body`.
- Steps are sent in order; `chat.remember` can keep parts of a response for the following steps
  (`ctx.memory`).
- For each step: status, response type (`chat.kind`), message (`chat.reply`), latency, checks, HTTP
  request and response, and **all of the server's LLM calls** during the step.

### Report

Per server: passed / failed / errored cases, passed checks, mean, median and maximum latency per step,
tokens and cost of the LLM calls. Each case can be replayed.

---

## Test cases and checks

Cases are created and edited in the interface (**Test cases** tabs) or directly in the JSON files.

### Format

**Prompt bench** (`prompt-cases.json`):

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

**Server bench** (`server-cases.json`): a multi-step conversation.

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

Steps can carry **options** (`server.stepOptions`, e.g. "send location") and cases can carry extra
**fields** (`server.caseFields`, e.g. language), read by `chat.body`.

### Relative dates

In messages: `{{J}}`, `{{J+7}}`, `{{today+7}}` are replaced by today's date shifted accordingly.
In date checks: `J+1` or a fixed date `2026-12-24`.

### Built-in checks

| Type | Bench | Checks |
| --- | --- | --- |
| `path` | both | A JSON path (`data.items.0.name`) with an operator: `equals`, `contains`, `includes` (array), `exists`, `absent`, `matches` (regex), `gte`, `lte` |
| `textContains` | both | The text contains one of the words (comma-separated) |
| `textExcludes` | both | The text contains none of the words (information leak…) |
| `textEquals` | both | Text strictly equal |
| `textMatches` | both | The text matches a regular expression |
| `prose` | both | Written text: not empty and not a code (e.g. `empty_results`) |
| `maxLatency` | both | Response time ≤ N seconds |
| `kind` | server | Response type (`chat.kind`) |
| `notError` | server | Neither an HTTP error nor a technical error |
| `status` | server | HTTP code |

In the server bench, a step **without checks** passes if it is not a technical error.

### Business checks

Declared in `prompt.checks` or `server.checks`, they appear in the case editor with their fields:

```ts
checks: {
  hasBooks: {
    description: "At least N books found",
    fields: [{ name: "min", label: "Minimum", kind: "number" }],   // fields editable in the interface
    label: (c) => `≥ ${c.min} book(s)`,                           // summary shown
    test: (s, c, h) => (s.json?.data?.books?.length ?? 0) >= Number(c.min),
    gate: false,   // true: if it fails, the following checks are not evaluated
  },
},
```

| `test` parameter | Content |
| --- | --- |
| `s.json` | Response parsed as JSON (`null` if absent) |
| `s.text` | Raw model response, or the server's written message |
| `s.latencyMs` | Response time |
| `s.status`, `s.kind` | Server bench: HTTP code and response type |
| `c` | The check as entered (its fields) |
| `h.date(v)` | `"J+1"`, `"{{J+1}}"`, `"2026-12-24"` → ISO date |
| `h.get(obj, "a.b.0")` | Reads a path |
| `h.lower(v)`, `h.list("a, b")` | Lowercase; comma-separated list |

Field types: `text`, `number`, `date`, `select` (with `options`), `boolean`, `tuples`.

---

## Parallel execution

By default, everything runs **one after the other**, for comparable latencies. Parallelism speeds up
campaigns on cloud models.

| Bench | Setting | What runs in parallel | What stays sequential |
| --- | --- | --- | --- |
| Prompt | **Parallelism** (interface) · `--parallel <n>` (CLI) | Up to *n* simultaneous calls to **remote** models, cases spread across models | **Local** models, one after the other (they run at the same time as the remote ones) |
| Server | **Parallel servers** | Up to *n* servers on a **remote** model | Cases of the same server (otherwise captures would get mixed up); servers on a local model |

Values from 1 to 16. Results are put back in order (model or server, case, repetition) in the
report.

> In parallel, the measured latency includes waiting on the provider side. Free tiers often limit
> throughput (HTTP 429): start with 2 or 3.

---

## Gateway

A stable **OpenAI-compatible** endpoint: `http://127.0.0.1:4317/gateway/v1`. Your project calls it
like its usual provider; the actual model is chosen in the interface, without restarting the project
or touching its `.env`.

### Connecting the project (once and for all)

```sh
LLM_ENDPOINT=http://127.0.0.1:4317/gateway/v1
LLM_API_KEY=llm-bench      # any value: the real key is added by the gateway
LLM_MODEL=gpt-4o           # any value: replaced by the gateway
```

On each request, the gateway replaces the requested model with the chosen model, adds the provider's
key, applies `adaptRequest` and relays streaming.

### Choosing the model

In the **Gateway** tab:

- **Free / Paid switch** (top right): returns to the **last model used** in that tier; if there is
  none yet, to the config profile for that tier. The button shows the model it activates; it is
  greyed out if no model of the tier is available.
- **Other model**: filterable list of all models of the displayed tier, then **Use this model**.
- **Config profiles**: named shortcuts declared in `gateway.profiles`.

From the command line, on a gateway that is already running:

```sh
llm-bench gateway use free                 # a profile
llm-bench gateway use azure/gpt-4.1        # a specific model
llm-bench gateway status                   # current model and profiles
```

The choice (and the last model per tier) is saved in `<dataDir>/gateway.json` and re-read on every
request: it survives restarts.

```ts
gateway: {
  profiles: { free: "ollama/qwen2.5:7b", paid: "azure/gpt-4.1", rapide: "groq/llama-3.3-70b-versatile" },
  default: "free",   // on first start
},
```

### Monitoring

The tab shows calls since startup (count, errors, tokens, cumulative cost) and the last 50 calls.
Clicking a call opens its full detail (see below).

---

## LLM call capture

Every relayed call — through the gateway or through a bench server's proxy — is recorded
**separately**, with a unique identifier.

| Information | Detail |
| --- | --- |
| Summary | Call type (generation, JSON, tools, or `server.llmCallKind`), model, HTTP status, latency, tokens, cost, `finish_reason`, streaming |
| Messages | System prompt (deduplicated, shown on demand), **history sent back by your server** (collapsed), new message, model response |
| **Actual URL called** | Provider method and URL, host and **port** |
| **Key sent** | Header name and value (masked, "show" button) |
| Server call | URL called by your server, local port, client address and port |
| Request received from the server | Headers and body, as received |
| Request sent to the provider | Headers and body after model replacement and `adaptRequest` |
| Provider response | Status, headers, body (when streaming: one SSE event per item), size |

All JSON is shown indented and syntax-highlighted.

> **"I can see messages from previous requests"**: a chatbot sends the whole conversation back to the
> model on every turn. If your server keeps history per session and your requests send no session
> identifier (or always the same one), they share a single history. The "Request received from the
> server — body" block shows exactly what your server sent.

---

## Costs

- Each provider is `free` or `paid`; a free model costs 0.
- Prices are declared **per million tokens**, per model, in `pricing` (`"*"` for all unlisted
  models), or from the interface for an added paid model.
- The currency is `currency` (default `$`).
- Reports show the total cost, cost per call and per case; the gateway shows the cumulative cost.
  A paid model without a price is flagged "no price".

---

## Configuration reference

The full type and the documentation of each option are in [`src/config.ts`](src/config.ts);
a commented example in [`examples/minimal-chatbot/bench.config.ts`](examples/minimal-chatbot/bench.config.ts).
In this repository, `defineConfig` provides autocompletion; elsewhere, `export default { … }` is enough.

### Full example

```ts
export default {
  name: "My chatbot",
  currency: "€",

  providers: {
    ollama: { kind: "ollama", baseUrl: "http://localhost:11434/v1", tier: "free" },
    azure: { baseUrl: process.env.AZURE_ENDPOINT, apiKey: process.env.AZURE_KEY, tier: "paid",
             models: ["gpt-4.1"], pricing: { "gpt-4.1": { input: 2, output: 8 } } },
  },

  prompt: {
    system: { module: "../src/prompts.ts", export: "SYSTEM_PROMPT" },
    request: (model) => ({ temperature: 0, response_format: { type: "json_object" } }),
    checks: { /* business checks */ },
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

### Root

| Option | Default | Description |
| --- | --- | --- |
| `name` | — | Name shown in the interface |
| `providers` | **required** | Providers (at least one; names: letters, digits, `-`, `_`) |
| `dataDir` | config folder | Where cases, reports and generated files are stored |
| `port` | `4317` | Port of the interface, the proxy and the gateway |
| `currency` | `$` | Price currency |
| `prompt` | — | Prompt bench (optional) |
| `server` | — | Server bench (optional) |
| `gateway` | — | Gateway profiles (optional) |

### `providers.<name>`

| Option | Default | Description |
| --- | --- | --- |
| `kind` | `"openai"` | `"openai"`: any compatible API; `"ollama"`: same + local model management |
| `label` | name | Displayed label |
| `baseUrl` | — | OpenAI-compatible URL, e.g. `http://localhost:11434/v1` |
| `apiKey` | — | API key (read it from `process.env`) |
| `apiKeyHeader` | `authorization` | Key header: `authorization` (`Bearer …`) or a name, e.g. `api-key` |
| `headers` | — | Headers added to every request |
| `tier` | `free` for Ollama, otherwise `paid` | Tier |
| `models` | — | Models offered (Ollama: installed models are added) |
| `listModels` | `false` | Queries `GET /models` to list the models |
| `pricing` | — | `{ "<model>" \| "*": { input, output } }`, per million tokens |
| `adaptRequest` | reasoning model adaptation | `(body, { provider, model }) => body` |

### `prompt`

| Option | Default | Description |
| --- | --- | --- |
| `system` | **required** | Text, function, `{ module, export }` or `{ file }` |
| `version` | text fingerprint | Text, function or `{ module, export }` |
| `user` | message as is | `(message, { history, today, tomorrow, case }) => string` |
| `request` | `temperature: 0`, `max_tokens: 4096` | `(model) => parameters` added to the body |
| `parse` | `"json"` | `"json"`, `"text"` or a function |
| `categories` | — | Categories offered in the editor |
| `checks` | — | Business checks |
| `newCase` | — | Defaults for a new case (category, checks) |

### `server`

| Option | Default | Description |
| --- | --- | --- |
| `start` | **required** | Start command |
| `source` | parent folder of the config | Project copied for each server |
| `instancesDir` | `../<project>-bench-servers` | Folder for the copies |
| `exclude` | — | Paths excluded from the copy (in addition to `node_modules`, `.git`…) |
| `envFile` | `.env` | Environment file copied |
| `env` | see [Variables](#environment-variables) | Names of the endpoint / key / model / port variables |
| `install` | none | Installation commands |
| `build` | none | Build commands (re-run on every ↻ Code) |
| `readyFile` | — | File that must exist before starting (e.g. `dist/main.js`) |
| `shareDirs` | `["node_modules"]` | Folders that can be shared via symbolic link |
| `health` | `/health` | Health route (ready on 2xx) |
| `startTimeoutMs` | 90 s | Maximum start time |
| `firstPort` | `3101` | First port assigned to servers |
| `chat` | see below | Shape of the chat API |
| `stepOptions` | — | Step options (fields), read by `chat.body` |
| `caseFields` | — | Extra case fields |
| `categories` | — | Categories offered |
| `checks` | — | Business checks |
| `llmCallKind` | generation / JSON / tools | `(body, systemPrompt) => name` shown for each LLM call |

### `server.chat`

| Option | Default | Description |
| --- | --- | --- |
| `path` | `/chat` | Chat route |
| `method` | `POST` | HTTP method |
| `timeoutMs` | 240 s | Timeout per step |
| `headers` | — | `(ctx) => headers` |
| `body` | `{ message, sessionId }` | `(ctx) => body`; `ctx`: `message`, `sessionId`, `index`, `step`, `case`, `memory` |
| `kind` | `success` if 2xx + JSON, otherwise `error` | `(status, json) => type`; `error` = technical error |
| `kinds` | — | Possible types (offered in the `kind` check) |
| `reply` | `json.reply ?? json.message` | Written message of the response |
| `summary` | — | Short summary of a step (e.g. "12 result(s)") |
| `remember` | — | `(json, memory) => void`: keeps parts for the following steps |
| `redactRequest` / `redactResponse` | — | Trimmed-down version saved in the report |

### `gateway`

| Option | Description |
| --- | --- |
| `profiles` | `{ name: "provider/model" }`: gateway shortcuts |
| `default` | Profile or model on first start |

---

## Command line

```sh
llm-bench doctor  [--yes | --no]
llm-bench init    [--dir bench] [--force]
llm-bench ui      [--open] [--port 4317] [--config bench/bench.config.ts]
llm-bench prompt  --models ollama/qwen2.5:7b,azure/gpt-4.1 [--cases a,b] [--runs 3] [--parallel 4] [--name "v2"] [--verbose]
llm-bench prompt  --tier free           # all available free models (free | paid | all)
llm-bench gateway use <profile|provider/model>
llm-bench gateway status
llm-bench --help
```

### Commands

#### `llm-bench doctor`

Checks the requirements and offers to install whatever is missing: Node.js 22+, npm dependencies,
Ollama (installed, server running, at least one model). Works before `npm install`
(`node bin/llm-bench.mjs doctor`). Details: [Check the requirements](#check-the-requirements).

- `--yes`: accepts every proposal (unattended setup) · `--no`: report only, installs nothing.
- Exit code `1` if a required item (Node.js, dependencies) is still missing.

```sh
llm-bench doctor            # interactive
llm-bench doctor --yes      # install everything that is missing without asking
```

#### `llm-bench init`

Run from the root of the project to test. Detects the stack, the model variables, the chat and health
routes and the system prompt, then creates `bench/bench.config.ts`, starter test cases
(`server-cases.json`, `prompt-cases.json`) and `bench/.gitignore`. Prints what it detected (✓ certain,
? to check); anything it couldn't infer is marked "TO CHECK" in the config. Details:
[Connecting your project](#connecting-your-project).

- `--dir <folder>`: config folder (default `bench`).
- `--force`: replaces an existing `bench.config.ts` (existing cases and `.gitignore` are kept).
- The generated comments follow the command line language (`LLM_BENCH_LANG`).

#### `llm-bench ui` (default command)

Starts the web interface, the server bench proxy (`/llm/<id>`) and the gateway (`/gateway/v1`) on
`127.0.0.1`, and prints their URLs. Runs in the foreground: **Ctrl+C** stops it, along with every
server it launched. `llm-bench` without a command does the same.

- `--open`: opens the interface in the browser.
- `--port <n>`: port of the interface, proxy and gateway (default: config, then `4317`).
- `--config <file>`: configuration to use (default: `bench.config.ts`, then `bench/bench.config.ts`
  in the current folder).

#### `llm-bench prompt`

Runs a prompt bench campaign without the interface (handy in a script or CI): sends each test case
to each model with the project's system prompt, prints each result (✅ passed, ❌ failed, 💥 error) and a
summary table per model (score, valid JSON, latency, tokens/s, cost), then writes the report as JSON
and Markdown to `results/`. Requires a `prompt` section in the config.

- `--models <a,b>`: models to test, as `provider/model`.
- `--tier <free|paid|all>`: without `--models`, every available model of that tier (default `free`).
- `--cases <a,b>`: run only these case ids · `--runs <n>`: repetitions per case.
- `--parallel <n>`: simultaneous calls to remote models; local models stay sequential.
- `--name <text>`: report name · `--verbose`: also prints the raw response of each call.

```sh
llm-bench prompt --tier free --runs 3
llm-bench prompt --models ollama/qwen2.5:7b,openai/gpt-4.1-mini --cases search-author --verbose
```

The reports also appear in the interface (**Prompt bench → Reports**).

#### `llm-bench gateway use <target>`

Chooses the model behind the gateway: a profile from the config (`free`, `paid`…) or a
`provider/model`. Takes effect immediately on a running gateway (the choice is saved in
`gateway.json` and read on every request), with no restart of your project. Fails if the provider is
unknown or unusable (e.g. missing API key).

```sh
llm-bench gateway use paid
llm-bench gateway use ollama/qwen2.5:7b
```

#### `llm-bench gateway status`

Prints the gateway URL, the current model (with its tier and profile) and the profiles declared in
the config.

#### `llm-bench --help`

Lists the commands and options in the current language.

### Options

| Option | Commands | Description |
| --- | --- | --- |
| `-c, --config <file>` | all | Configuration file |
| `--port <n>` | all | Port of the interface and the gateway |
| `--open` | `ui` | Opens the browser |
| `--dir`, `--force` | `init` | Config folder; replace an existing config |
| `--models <a,b>` | `prompt` | Models to test |
| `--tier <free\|paid\|all>` | `prompt` | Without `--models`: all models of the tier (default `free`) |
| `--cases <a,b>` | `prompt` | Run only these cases |
| `--runs <n>` | `prompt` | Repetitions per case (default 1) |
| `--parallel <n>` | `prompt` | Simultaneous calls to remote models (default 1) |
| `--name <text>` | `prompt` | Report name |
| `--verbose` | `prompt` | Shows the raw response of each call |

### Environment variables

| Variable | Role |
| --- | --- |
| `BENCH_PORT` | Interface port (takes precedence over the config) |
| `BENCH_INSTANCES_DIR` | Folder for server copies |
| `BENCH_SERVER_PORT` | First server port |
| `LLM_BENCH_LANG` | Command line language: `fr` or `en` (see [Language](#language)) |

---

## Files and storage

| What | Where | Lifetime |
| --- | --- | --- |
| Configuration, test cases | `bench.config.ts`, `prompt-cases.json`, `server-cases.json` | Versioned with the project |
| Prompt bench reports | `<dataDir>/results/*.json` (+ `.md` from the CLI) | On disk |
| Server bench reports (with LLM calls, keys masked) | `<dataDir>/results-servers/` | On disk |
| Gateway model, last model per tier | `<dataDir>/gateway.json` | On disk |
| Models and keys entered in the interface | `<dataDir>/providers.local.json` | On disk, **keys in plain text** |
| System prompt pasted in the interface | `system-prompt.md`, next to the config | Can be versioned |
| Server copies | `instancesDir` (default `../<project>-bench-servers`) | Until deleted |
| Gateway calls | **In memory** (last 200) | Cleared on restart |

`<dataDir>` is the config folder, unless `dataDir` is set. `init` creates a `.gitignore` that
excludes the generated files.

---

## Security

- The interface, the proxy and the gateway listen only on **`127.0.0.1`**: they cannot be reached
  from the network.
- API keys stay on the bench side: your server and its copies receive a dummy key, the real one is
  added when relaying.
- `providers.local.json` contains keys **in plain text**: it is ignored by git, do not share it.
- In reports written to disk, keys are **masked**. In the gateway (memory only), the key is kept for
  call details and masked on display by default.
- The config is executed code: only use trusted configurations.

---

## Troubleshooting

| Symptom | Likely cause | Solution |
| --- | --- | --- |
| "API key missing" | Environment variable not loaded | Check the `.env` read by the config, or 🔑 in **Models** |
| HTTP 429 | Free tier rate limit | Lower the parallelism, space out campaigns |
| "context probably truncated" | Ollama context too small for the prompt | Increase `OLLAMA_CONTEXT_LENGTH` and restart Ollama |
| The gateway responds 503 | No model chosen | **Gateway** tab or `llm-bench gateway use <profile>` |
| A server does not start | Command, build or health route | Server **📄 log**; check `start`, `health`, `readyFile` |
| The server's LLM calls are not captured | The server does not use the endpoint variable | **Server bench → Variables**: check that the code actually reads that name |
| History accumulates from one request to the next | Your server keeps the conversation per session | Send a new session identifier, or restart your server |
| A reasoning model rejects a parameter | `temperature`, `max_tokens`… not supported | `adaptRequest` on the provider |

---

## Development

```sh
npm install
npm run typecheck      # tsc --noEmit
npm run i18n:check     # missing English translations
```

| File | Role |
| --- | --- |
| `bin/llm-bench.mjs` | Entry point (runs `src/cli.ts` via tsx) |
| `bin/doctor.mjs` | `llm-bench doctor`: requirements check and install (plain JS, no dependency) |
| `src/cli.ts` | Command line |
| `src/config.ts` | Configuration types and loading |
| `src/http.ts` | HTTP server: interface API, `/llm/<id>` proxy, `/gateway` gateway |
| `src/providers.ts` | Providers, calls, costs, request adaptation |
| `src/capture.ts` | Relaying and capture of LLM calls |
| `src/gateway.ts` | Gateway |
| `src/prompt-bench.ts` | Prompt bench |
| `src/server-bench.ts` | Server bench |
| `src/instances.ts` | Server copies (copy, install, build, start) |
| `src/checks.ts` | Built-in checks |
| `src/prompt-source.ts` | System prompt detection and reading |
| `src/init.ts` | `init` command |
| `src/stacks.ts` | Stack detection (Node, Python, Go, Java, .NET, Ruby, PHP) and generated commands |
| `src/ollama.ts` | Local models and Ollama catalog |
| `src/i18n.ts` | Current language and translation (`tr`) |
| `src/i18n/` | English translations (`en-*.ts`) for the server and CLI |
| `scripts/i18n-check.mjs` | Lists missing translations (`npm run i18n:check`) |
| `ui/index.html` | Interface (single file, no build) |
| `examples/minimal-chatbot/` | Example chatbot and its configuration |

## License

[MIT](LICENSE) © ennosof
