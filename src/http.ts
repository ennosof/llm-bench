/**
 * Serveur du bench : interface web, API, proxy d'enregistrement des serveurs et passerelle.
 *
 *   /                      interface
 *   /api/…                 API de l'interface
 *   /llm/<serveur>/…       proxy des appels LLM d'un serveur du bench
 *   /gateway/v1/…          passerelle : modèle choisi dans l'interface ou par `llm-bench gateway use`
 *
 * N'écoute que sur 127.0.0.1.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { peekCalls, relay } from "./capture.js";
import { checkTypesForUi } from "./checks.js";
import { DEFAULT_SERVER_ENV, config, saveServerEnv } from "./config.js";
import { parseLang, withLang, defaultLang, tr } from "./i18n.js";
import { GATEWAY_CHANNEL, gatewayStatus, gatewayTarget, onGatewayCall, setGateway } from "./gateway.js";
import {
  changeInstanceModel, createInstance, deleteInstance, getInstance, instanceDetails, instanceTarget, instancesDir, listInstances, projectLlmEnv, readLog,
  refreshInstance, reinstallInstance, setLlmProxyBase, startInstance, stopAllSync, stopInstance,
} from "./instances.js";
import { codeEnvNames, envFileNames } from "./init.js";
import { deleteModel, libraryTags, listLocalModels, ollamaProvider, ollamaVersion, pullModel, searchLibrary } from "./ollama.js";
import {
  cleanCase, closeStaleReports, deleteReport, listReports, loadCases, loadReport, promptCheckTypes, replayResult, runCampaign,
  saveCases, summarize, systemPrompt, validateCase,
} from "./prompt-bench.js";
import { describeSource, detectPrompts, evalExports, projectRoot, resolveVersion, savePromptSource } from "./prompt-source.js";
import { addUiProvider, availableModels, providersForUi, removeUiModel, removeUiProvider, setConfigProviderKey } from "./providers.js";
import {
  cleanServerCase, closeStaleServerReports, deleteServerReport, kinds, listServerReports, loadServerCases, loadServerReport,
  replayServerResult, runServerCampaign, saveServerCases, serverCheckTypes, summarizeServers, validateServerCase,
} from "./server-bench.js";

const UI_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "index.html");

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const fail = (status: number) => (error: unknown) => {
  throw new HttpError(status, error instanceof Error ? error.message : String(error));
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, tr("JSON invalide"));
  }
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<unknown> | unknown;
const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
const route = (method: string, pattern: RegExp, handler: Handler) => routes.push({ method, pattern, handler });

/** Enregistre ou remplace un cas dans une liste (id unique, renommage possible). */
function upsert<T extends { id: string }>(list: T[], item: T, originalId?: string) {
  const index = list.findIndex((x) => x.id === (originalId ?? item.id));
  if (list.some((x, i) => x.id === item.id && i !== index)) throw new HttpError(409, tr("un cas \"{id}\" existe déjà", { id: item.id }));
  if (index === -1) list.push(item);
  else list[index] = item;
  return list;
}

const runsParam = (v: unknown) => Math.min(10, Math.max(1, Number(v) || 1));
const nameParam = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// =================================================================================================
// État en mémoire
// =================================================================================================

interface ActiveRun {
  reportId: string;
  done: number;
  total: number;
  current?: string;
  phase?: "loading" | "running";
  controller: AbortController;
  /** En parallèle : modèles ou serveurs en cours (current les liste). */
  running?: Set<string>;
}

const parallelParam = (v: unknown) => Math.min(16, Math.max(1, Math.floor(Number(v)) || 1));
let activeRun: ActiveRun | null = null;
let activeServerRun: ActiveRun | null = null;

interface PullState {
  name: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
  controller: AbortController;
}
const pulls = new Map<string, PullState>();

const publicRun = (r: ActiveRun | null) => (r ? { reportId: r.reportId, done: r.done, total: r.total, current: r.current, phase: r.phase } : null);

function ollamaBase() {
  const o = ollamaProvider();
  if (!o) throw new HttpError(404, tr("aucun fournisseur Ollama dans la config"));
  return o.url;
}

// =================================================================================================
// Statut et fournisseurs
// =================================================================================================

route("GET", /^\/api\/status$/, async () => {
  const cfg = config();
  const o = ollamaProvider();
  return {
    name: cfg.name ?? "llm-bench",
    configFile: cfg.file,
    dataDir: cfg.dataDir,
    currency: cfg.currency,
    port: cfg.port,
    ollama: o ? { provider: o.name, url: o.url, ...(await ollamaVersion(o.url)) } : null,
    providers: providersForUi(),
    prompt: cfg.prompt
      ? { version: typeof cfg.prompt.version === "string" ? cfg.prompt.version : null, categories: cfg.prompt.categories ?? [], checkTypes: checkTypesForUi(promptCheckTypes()), newCase: cfg.prompt.newCase ?? null }
      : null,
    server: cfg.server
      ? {
          instancesDir: instancesDir(),
          source: cfg.server.source,
          commands: { install: cfg.server.install ?? [], build: cfg.server.build ?? [], start: cfg.server.start },
          env: cfg.server.env,
          chatPath: `${cfg.server.chat?.method ?? "POST"} ${cfg.server.chat?.path ?? "/chat"}`,
          health: cfg.server.health ?? "/health",
          shareDirs: cfg.server.shareDirs ?? ["node_modules"],
          kinds: kinds(),
          categories: cfg.server.categories ?? [],
          stepOptions: cfg.server.stepOptions ?? [],
          caseFields: cfg.server.caseFields ?? [],
          checkTypes: checkTypesForUi(serverCheckTypes()),
        }
      : null,
  };
});

route("GET", /^\/api\/available-models$/, () => availableModels());

// =================================================================================================
// Variables d'environnement du bench serveur
// =================================================================================================

/** Noms actuels, valeurs par défaut et variables trouvées dans le projet (noms seulement, jamais les valeurs). */
route("GET", /^\/api\/server\/env$/, () => {
  const cfg = config();
  if (!cfg.server) throw new HttpError(404, tr("pas de section « server » dans la config"));
  const source = cfg.server.source!;
  return {
    names: cfg.server.env,
    defaults: DEFAULT_SERVER_ENV,
    configFile: cfg.file,
    envFile: cfg.server.envFile ?? ".env",
    inEnvFiles: envFileNames(source).sort(),
    inCode: codeEnvNames(source).sort(),
    proxyBase: `http://127.0.0.1:${cfg.port}/llm/<serveur>`,
    firstPort: cfg.server.firstPort ?? 3101,
  };
});

route("PUT", /^\/api\/server\/env$/, async (req) => {
  const { names } = await readBody(req);
  try {
    return { names: saveServerEnv(names ?? {}) };
  } catch (error) {
    return fail(400)(error);
  }
});

/** Valeurs LLM du .env du projet ; la clé n'est jamais renvoyée, seulement sa présence. */
route("GET", /^\/api\/providers\/project-env$/, () => {
  const e = projectLlmEnv();
  return e && { file: e.file, names: e.names, baseUrl: e.baseUrl, model: e.model, hasKey: Boolean(e.apiKey) };
});

route("POST", /^\/api\/providers$/, async (req) => {
  const body = await readBody(req);
  const apiKey = body.useProjectKey ? projectLlmEnv()?.apiKey : body.apiKey;
  if (body.useProjectKey && !apiKey) throw new HttpError(400, tr("aucune clé dans le .env du projet"));
  try {
    return addUiProvider({ ...body, apiKey: apiKey ?? undefined });
  } catch (error) {
    return fail(400)(error);
  }
});

/** Clé d'un fournisseur de la config : { apiKey } ou { useProjectKey: true } ; DELETE rétablit celle de la config. */
route("PUT", /^\/api\/providers\/([\w-]+)\/key$/, async (req, _res, [name]) => {
  const body = await readBody(req);
  const apiKey = body.useProjectKey ? projectLlmEnv()?.apiKey : String(body.apiKey ?? "").trim();
  if (!apiKey) throw new HttpError(400, body.useProjectKey ? tr("aucune clé dans le .env du projet") : tr("clé obligatoire"));
  try {
    setConfigProviderKey(name, apiKey);
  } catch (error) {
    fail(400)(error);
  }
  return { ok: true };
});

route("DELETE", /^\/api\/providers\/([\w-]+)\/key$/, (_req, _res, [name]) => {
  try {
    setConfigProviderKey(name, null);
  } catch (error) {
    fail(400)(error);
  }
  return { ok: true };
});

route("DELETE", /^\/api\/providers\/([\w-]+)\/models\/([^/]+)$/, (_req, _res, [name, model]) => {
  try {
    removeUiModel(name, decodeURIComponent(model));
  } catch (error) {
    fail(400)(error);
  }
  return { ok: true };
});

route("DELETE", /^\/api\/providers\/([\w-]+)$/, (_req, _res, [name]) => {
  try {
    removeUiProvider(name);
  } catch (error) {
    fail(400)(error);
  }
  return { ok: true };
});

// =================================================================================================
// Bench prompt
// =================================================================================================

route("GET", /^\/api\/prompt\/system$/, async () => {
  const text = await systemPrompt().catch(fail(500));
  return { text, version: await resolveVersion(config().prompt!, text) };
});

/** Source actuelle du prompt (null si aucune) ; le texte est résolu à part (GET /api/prompt/system). */
route("GET", /^\/api\/prompt\/source$/, () => ({ source: describeSource(config().prompt), root: projectRoot(), configFile: config().file }));

route("GET", /^\/api\/prompt\/candidates$/, () => detectPrompts());

/** Essai d'une source avant de l'enregistrer : { kind: "module", module, export } ou { kind: "file", file } (chemins relatifs au projet). */
route("POST", /^\/api\/prompt\/test$/, async (req) => {
  const b = await readBody(req);
  const root = projectRoot();
  if (b.kind === "file") {
    const p = resolve(root, String(b.file ?? ""));
    if (!existsSync(p)) throw new HttpError(400, tr("fichier introuvable : {file}", { file: b.file }));
    const text = readFileSync(p, "utf8");
    return { ok: true, text, length: text.length };
  }
  const p = resolve(root, String(b.module ?? ""));
  if (!existsSync(p)) throw new HttpError(400, tr("fichier introuvable : {file}", { file: b.module }));
  const [r] = await evalExports([{ module: p, export: String(b.export ?? "") }]);
  return r.ok ? { ...r, length: r.text.length } : r;
});

route("PUT", /^\/api\/prompt\/source$/, async (req) => {
  try {
    return { source: savePromptSource(await readBody(req)) };
  } catch (error) {
    return fail(400)(error);
  }
});

route("GET", /^\/api\/cases$/, () => loadCases());

route("POST", /^\/api\/cases$/, async (req) => {
  const { case: c, originalId } = await readBody(req);
  const error = validateCase(c);
  if (error) throw new HttpError(400, error);
  const clean = cleanCase(c);
  saveCases(upsert(loadCases(), clean, originalId));
  return clean;
});

route("DELETE", /^\/api\/cases\/([^/]+)$/, (_req, _res, [id]) => {
  const cases = loadCases();
  const next = cases.filter((c) => c.id !== decodeURIComponent(id));
  if (next.length === cases.length) throw new HttpError(404, tr("cas introuvable"));
  saveCases(next);
  return { ok: true };
});

route("GET", /^\/api\/runs\/active$/, () => publicRun(activeRun));

route("POST", /^\/api\/runs$/, async (req) => {
  if (activeRun) throw new HttpError(409, tr("une campagne est déjà en cours"));
  const { models, caseIds, runs, name, parallel } = await readBody(req);
  if (!Array.isArray(models) || !models.length) throw new HttpError(400, tr("choisir au moins un modèle"));
  const cases = Array.isArray(caseIds) ? loadCases().filter((c) => caseIds.includes(c.id)) : [];
  if (!cases.length) throw new HttpError(400, tr("choisir au moins un cas"));
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    runCampaign(
      { models, cases, runs: runsParam(runs), name: nameParam(name), parallel: parallelParam(parallel) },
      (e) => {
        if (e.type === "start") {
          activeRun = { reportId: e.reportId, done: 0, total: e.total, phase: "loading", controller };
          resolve({ reportId: e.reportId });
        }
        if (e.type === "model" && activeRun) {
          const running = (activeRun.running ??= new Set());
          if (e.status === "done" || e.status === "error") running.delete(e.model);
          else running.add(e.model);
          activeRun.current = [...running].join(", ");
          activeRun.phase = e.status === "loading" ? "loading" : "running";
        }
        if (e.type === "result" && activeRun) activeRun.done = e.done;
        if (e.type === "done") activeRun = null;
      },
      controller.signal,
    ).catch((error) => {
      console.error(tr("Campagne interrompue :"), error);
      activeRun = null;
      reject(new HttpError(400, error instanceof Error ? error.message : String(error)));
    });
  });
});

route("POST", /^\/api\/runs\/stop$/, () => {
  activeRun?.controller.abort();
  return { ok: true };
});

route("GET", /^\/api\/reports$/, () => listReports());

route("GET", /^\/api\/reports\/([\w-]+)$/, (_req, _res, [id]) => {
  try {
    const report = loadReport(id);
    return { ...report, summary: summarize(report) };
  } catch {
    throw new HttpError(404, tr("rapport introuvable"));
  }
});

route("DELETE", /^\/api\/reports\/([\w-]+)$/, (_req, _res, [id]) => {
  if (activeRun?.reportId === id) throw new HttpError(409, tr("campagne en cours sur ce rapport"));
  deleteReport(id);
  return { ok: true };
});

route("POST", /^\/api\/reports\/([\w-]+)\/replay$/, async (req, _res, [id]) => {
  if (activeRun?.reportId === id) throw new HttpError(409, tr("campagne en cours sur ce rapport"));
  const { resultId } = await readBody(req);
  return replayResult(loadReport(id), resultId).catch(fail(400));
});

// =================================================================================================
// Modèles Ollama
// =================================================================================================

route("GET", /^\/api\/models$/, async () => {
  const base = ollamaBase();
  return listLocalModels(base).catch(fail(502));
});

route("DELETE", /^\/api\/models\/(.+)$/, async (_req, _res, [name]) => {
  await deleteModel(ollamaBase(), decodeURIComponent(name));
  return { ok: true };
});

route("GET", /^\/api\/pulls$/, () => [...pulls.values()].map(({ controller: _c, ...p }) => p));

route("POST", /^\/api\/pulls$/, async (req) => {
  const base = ollamaBase();
  const { name } = await readBody(req);
  if (!/^[a-zA-Z0-9._:\-/]+$/.test(name ?? "")) throw new HttpError(400, tr("nom de modèle invalide"));
  const existing = pulls.get(name);
  if (existing && !existing.done) return { ok: true };

  const state: PullState = { name, status: tr("démarrage"), completed: 0, total: 0, done: false, controller: new AbortController() };
  pulls.set(name, state);
  (async () => {
    try {
      const stream = await pullModel(base, name, state.controller.signal);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of stream as any) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const ev = JSON.parse(line);
          if (ev.error) throw new Error(ev.error);
          state.status = ev.status ?? state.status;
          if (ev.total) {
            state.total = ev.total;
            state.completed = ev.completed ?? 0;
          }
        }
      }
      state.status = tr("terminé");
    } catch (error) {
      state.error = state.controller.signal.aborted ? tr("annulé") : String(error);
    } finally {
      state.done = true;
    }
  })();
  return { ok: true };
});

route("DELETE", /^\/api\/pulls\/(.+)$/, (_req, _res, [name]) => {
  const state = pulls.get(decodeURIComponent(name));
  if (state && !state.done) state.controller.abort();
  else pulls.delete(decodeURIComponent(name));
  return { ok: true };
});

route("GET", /^\/api\/library\/search$/, (_req, _res, _p, url) => searchLibrary(url.searchParams.get("q") ?? "").catch(fail(502)));
route("GET", /^\/api\/library\/tags$/, (_req, _res, _p, url) => libraryTags(url.searchParams.get("name") ?? "").catch(fail(502)));

// =================================================================================================
// Bench serveur
// =================================================================================================

route("GET", /^\/api\/server\/servers$/, () => listInstances());

route("POST", /^\/api\/server\/servers$/, async (req) => {
  const { model, name, linkModules } = await readBody(req);
  return createInstance({ model, name, linkModules }).catch(fail(400));
});

const SERVER_ACTIONS: Record<string, (id: string) => Promise<unknown>> = {
  start: startInstance,
  stop: stopInstance,
  refresh: refreshInstance,
  reinstall: reinstallInstance,
};

route("POST", /^\/api\/server\/servers\/([\w.-]+)\/(start|stop|refresh|reinstall)$/, async (_req, _res, [id, action]) => {
  if (action !== "start" && activeServerRun) throw new HttpError(409, tr("une campagne est en cours"));
  getInstance(id);
  return SERVER_ACTIONS[action](id).catch(fail(400));
});

route("POST", /^\/api\/server\/servers\/([\w.-]+)\/model$/, async (req, _res, [id]) => {
  if (activeServerRun) throw new HttpError(409, tr("une campagne est en cours"));
  const { model } = await readBody(req);
  return changeInstanceModel(id, model).catch(fail(400));
});

route("GET", /^\/api\/server\/servers\/([\w.-]+)\/details$/, (_req, _res, [id]) => {
  try {
    const calls = peekCalls(id);
    return { ...instanceDetails(id), pendingCalls: calls.length, lastCallAt: calls.at(-1)?.at ?? null };
  } catch (error) {
    return fail(404)(error);
  }
});

route("GET", /^\/api\/server\/servers\/([\w.-]+)\/log$/, (_req, _res, [id]) => ({ log: readLog(id) }));

route("DELETE", /^\/api\/server\/servers\/([\w.-]+)$/, async (_req, _res, [id]) => {
  if (activeServerRun) throw new HttpError(409, tr("une campagne est en cours"));
  await deleteInstance(id).catch(fail(400));
  return { ok: true };
});

route("GET", /^\/api\/server\/cases$/, () => loadServerCases());

route("POST", /^\/api\/server\/cases$/, async (req) => {
  const { case: c, originalId } = await readBody(req);
  const error = validateServerCase(c);
  if (error) throw new HttpError(400, error);
  const clean = cleanServerCase(c);
  saveServerCases(upsert(loadServerCases(), clean, originalId));
  return clean;
});

route("DELETE", /^\/api\/server\/cases\/([^/]+)$/, (_req, _res, [id]) => {
  const cases = loadServerCases();
  const next = cases.filter((c) => c.id !== decodeURIComponent(id));
  if (next.length === cases.length) throw new HttpError(404, tr("cas introuvable"));
  saveServerCases(next);
  return { ok: true };
});

route("GET", /^\/api\/server\/runs\/active$/, () => publicRun(activeServerRun));

route("POST", /^\/api\/server\/runs$/, async (req) => {
  if (activeServerRun) throw new HttpError(409, tr("une campagne est déjà en cours"));
  const { serverIds, caseIds, runs, name, parallel } = await readBody(req);
  if (!Array.isArray(serverIds) || !serverIds.length) throw new HttpError(400, tr("choisir au moins un serveur"));
  const cases = Array.isArray(caseIds) ? loadServerCases().filter((c) => caseIds.includes(c.id)) : [];
  if (!cases.length) throw new HttpError(400, tr("choisir au moins un cas"));
  const controller = new AbortController();

  return new Promise((resolve, reject) => {
    runServerCampaign(
      { serverIds, cases, runs: runsParam(runs), name: nameParam(name), parallel: parallelParam(parallel) },
      (e) => {
        if (e.type === "start") {
          activeServerRun = { reportId: e.reportId, done: 0, total: e.total, controller };
          resolve({ reportId: e.reportId });
        }
        if (e.type === "server" && activeServerRun) {
          const running = (activeServerRun.running ??= new Set());
          if (e.status === "done") running.delete(e.serverId);
          else running.add(e.serverId);
          activeServerRun.current = [...running].join(", ");
        }
        if (e.type === "result" && activeServerRun) activeServerRun.done = e.done;
        if (e.type === "done") activeServerRun = null;
      },
      controller.signal,
    ).catch((error) => {
      activeServerRun = null;
      reject(new HttpError(400, error instanceof Error ? error.message : String(error)));
    });
  });
});

route("POST", /^\/api\/server\/runs\/stop$/, () => {
  activeServerRun?.controller.abort();
  return { ok: true };
});

route("GET", /^\/api\/server\/reports$/, () => listServerReports());

route("GET", /^\/api\/server\/reports\/([\w-]+)$/, (_req, _res, [id]) => {
  try {
    const report = loadServerReport(id);
    return { ...report, summary: summarizeServers(report) };
  } catch {
    throw new HttpError(404, tr("rapport introuvable"));
  }
});

route("DELETE", /^\/api\/server\/reports\/([\w-]+)$/, (_req, _res, [id]) => {
  if (activeServerRun?.reportId === id) throw new HttpError(409, tr("campagne en cours sur ce rapport"));
  deleteServerReport(id);
  return { ok: true };
});

route("POST", /^\/api\/server\/reports\/([\w-]+)\/replay$/, async (req, _res, [id]) => {
  if (activeServerRun) throw new HttpError(409, tr("une campagne est en cours"));
  const { resultId } = await readBody(req);
  return replayServerResult(loadServerReport(id), resultId).catch(fail(400));
});

// =================================================================================================
// Passerelle
// =================================================================================================

route("GET", /^\/api\/gateway$/, () => gatewayStatus());

route("POST", /^\/api\/gateway$/, async (req) => {
  const { target } = await readBody(req);
  try {
    setGateway(String(target ?? ""));
  } catch (error) {
    fail(400)(error);
  }
  return gatewayStatus();
});

// =================================================================================================
// Serveur HTTP
// =================================================================================================

export function startHttp(opts: { onListening?: (url: string) => void } = {}) {
  const cfg = config();
  setLlmProxyBase(`http://127.0.0.1:${cfg.port}`);
  closeStaleReports();
  if (cfg.server) closeStaleServerReports();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Proxy des serveurs du bench : /llm/<id>/chat/completions
    const llm = url.pathname.match(/^\/llm\/([a-z0-9][a-z0-9._-]{0,80})(\/.*)$/);
    if (llm) {
      let target;
      try {
        target = instanceTarget(llm[1]);
      } catch {
        send(res, 404, { error: { message: tr("bench : serveur {id} inconnu", { id: llm[1] }) } });
        return;
      }
      await relay(req, res, { channel: llm[1], target, path: llm[2] + url.search, rewriteModel: false }).catch((e) => console.error(tr("Proxy LLM :"), e));
      return;
    }

    // Passerelle : /gateway/v1/chat/completions
    const gw = url.pathname.match(/^\/gateway(?:\/v1)?(\/.*)$/);
    if (gw) {
      const target = gatewayTarget();
      if (!target) {
        send(res, 503, { error: { message: tr("passerelle : aucun modèle choisi (interface, onglet Passerelle, ou `llm-bench gateway use <profil>`)") } });
        return;
      }
      await relay(req, res, { channel: GATEWAY_CHANNEL, target, path: gw[1] + url.search, rewriteModel: true, revealKey: true, onRecorded: onGatewayCall })
        .catch((e) => console.error(tr("Passerelle :"), e));
      return;
    }

    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(readFileSync(UI_FILE));
        return;
      }
      for (const r of routes) {
        const m = r.method === req.method ? url.pathname.match(r.pattern) : null;
        if (m) {
          send(res, 200, (await r.handler(req, res, m.slice(1), url)) ?? null);
          return;
        }
      }
      throw new HttpError(404, tr("route inconnue"));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      send(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  // Langue de chaque requête : celle choisie dans l'interface (en-tête x-llm-bench-lang), sinon celle du système.
  const server = createServer((req, res) => withLang(parseLang(req.headers["x-llm-bench-lang"]) ?? defaultLang(), () => handle(req, res)));

  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error(error.code === "EADDRINUSE" ? tr("Le port {port} est déjà utilisé (BENCH_PORT=… pour en changer).", { port: cfg.port }) : error);
    process.exit(1);
  });
  server.listen(cfg.port, "127.0.0.1", () => opts.onListening?.(`http://localhost:${cfg.port}`));

  // Les serveurs lancés par le bench s'arrêtent avec lui.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopAllSync();
      process.exit(0);
    });
  }
  process.on("exit", stopAllSync);
  return server;
}
