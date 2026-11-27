/**
 * Bench serveur : des conversations (cas de server-cases.json) envoyées au chatbot HTTP de chaque
 * serveur du bench, de bout en bout, une session neuve par cas et une requête par étape.
 *
 * La forme des requêtes et la lecture des réponses viennent de la config (server.chat).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { peekPrompts, takeCalls, takePrompts, watchCalls, type LlmCall } from "./capture.js";
import { COMMON_CHECKS, resolveDates, runChecks, serverBuiltinChecks, type CheckResult } from "./checks.js";
import { tr } from "./i18n.js";
import { config, type CheckType, type ServerCase, type ServerStep, type StepContext } from "./config.js";
import { getInstance, type Instance } from "./instances.js";
import { costOf, isLocalProvider, pool, sumCosts, tierOf } from "./providers.js";

export const serverCasesFile = () => join(config().dataDir, "server-cases.json");
export const serverResultsDir = () => join(config().dataDir, "results-servers");

const DEFAULT_KINDS = ["success", "error"];

function target() {
  const s = config().server;
  if (!s) throw new Error(tr("pas de bench serveur : section « server » absente de la config"));
  return s;
}

export const kinds = () => target().chat?.kinds ?? DEFAULT_KINDS;

export function serverCheckTypes(): Record<string, CheckType> {
  return { ...serverBuiltinChecks(kinds()), ...COMMON_CHECKS, ...(config().server?.checks ?? {}) };
}

// =================================================================================================
// Cas de test
// =================================================================================================

export function loadServerCases(): ServerCase[] {
  return existsSync(serverCasesFile()) ? JSON.parse(readFileSync(serverCasesFile(), "utf8")) : [];
}

export function saveServerCases(cases: ServerCase[]) {
  mkdirSync(config().dataDir, { recursive: true });
  writeFileSync(serverCasesFile(), JSON.stringify(cases, null, 2) + "\n");
}

export function validateServerCase(c: any): string | null {
  if (!c || typeof c !== "object") return tr("cas invalide");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(c.id ?? "")) return tr("id : lettres, chiffres, - et _ uniquement (64 max)");
  if (!Array.isArray(c.steps) || !c.steps.length) return tr("au moins une étape");
  const types = serverCheckTypes();
  const options = target().stepOptions ?? [];
  for (const [i, s] of c.steps.entries()) {
    if (!String(s?.message ?? "").trim()) return tr("étape {n} : message obligatoire", { n: i + 1 });
    for (const o of options) if (o.notFirst && i === 0 && s[o.name]) return tr("étape 1 : option « {option} » impossible", { option: o.label });
    for (const k of s.checks ?? []) if (!types[k.type]) return tr("vérification inconnue : {type}", { type: k.type });
  }
  return null;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === false;

/** Ne garde que les champs connus ; les valeurs par défaut et options décochées ne sont pas écrites. */
export function cleanServerCase(c: any): ServerCase {
  const t = target();
  const fields: Record<string, unknown> = {};
  for (const f of t.caseFields ?? []) {
    const v = typeof c[f.name] === "string" ? c[f.name].trim() : c[f.name];
    if (!isEmpty(v) && v !== f.default) fields[f.name] = v;
  }
  return {
    id: c.id.trim(),
    ...(c.description?.trim() ? { description: c.description.trim() } : {}),
    ...(c.category?.trim() ? { category: c.category.trim() } : {}),
    ...fields,
    steps: c.steps.map((s: any) => {
      const opts: Record<string, unknown> = {};
      for (const o of t.stepOptions ?? []) if (!isEmpty(s[o.name])) opts[o.name] = s[o.name];
      return { message: s.message, ...opts, ...(s.checks?.length ? { checks: s.checks } : {}) };
    }),
  };
}

// =================================================================================================
// Exécution d'un cas
// =================================================================================================

export interface StepResult {
  message: string;
  status: "pass" | "fail" | "error";
  kind: string;
  latencyMs: number;
  httpStatus?: number;
  reply?: string;
  summary?: string;
  checks: CheckResult[];
  llmCalls: LlmCall[]; // appels LLM faits par le serveur pendant cette étape
  request: unknown;
  response?: unknown;
  error?: string;
}

export interface ServerResult {
  id: string;
  serverId: string;
  caseId: string;
  run: number;
  status: "pass" | "fail" | "error";
  latencyMs: number; // somme des étapes
  steps: StepResult[];
  failures: string[];
  prompts?: Record<string, string>; // prompts système (hash → texte), déplacés dans le rapport
  at: string;
}

export interface ServerReport {
  id: string;
  name?: string;
  date: string;
  status: "running" | "done" | "aborted";
  runs: number;
  servers: Array<Pick<Instance, "id" | "name" | "provider" | "model" | "port" | "sourceCommit" | "updatedAt">>;
  cases: ServerCase[];
  results: ServerResult[];
  prompts: Record<string, string>;
}

const newId = () => Math.random().toString(36).slice(2, 10);

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

function defaultKind(status: number, json: any) {
  return status >= 200 && status < 300 && json !== null ? "success" : "error";
}

function defaultReply(json: any) {
  const v = json?.reply ?? json?.message ?? json?.content ?? json?.text;
  return typeof v === "string" ? v : undefined;
}

/**
 * Réponse gardée pour l'affichage : redactResponse, sinon tronquée au-delà de 50 ko pour les rapports écrits
 * sur disque (`full` : chat, rien n'est écrit, la réponse reste entière).
 */
function storedResponse(json: any, text: string, full = false) {
  const chat = target().chat ?? {};
  if (json === null) return full ? text : text.slice(0, 2000);
  if (chat.redactResponse) return safe(() => chat.redactResponse!(json), json);
  if (full) return json;
  const s = JSON.stringify(json);
  return s.length > 50_000 ? `${s.slice(0, 50_000)}… ${tr("(tronqué)")}` : json;
}

async function send(port: number, ctx: StepContext, signal?: AbortSignal, onBody?: (body: unknown) => void) {
  const chat = target().chat ?? {};
  const body = chat.body ? chat.body(ctx) : { message: ctx.message, sessionId: ctx.sessionId };
  onBody?.(body);
  const headers = { "Content-Type": "application/json", ...(chat.headers?.(ctx) ?? {}) };
  const method = chat.method ?? "POST";
  const timeout = AbortSignal.timeout(chat.timeoutMs ?? 240_000);
  const res = await fetch(`http://127.0.0.1:${port}${chat.path ?? "/chat"}`, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // réponse non JSON
  }
  return { body, status: res.status, json, text };
}

/**
 * Joue une étape : requête au serveur, lecture de la réponse, appels LLM capturés, mémoire mise à jour.
 * Sans vérification : l'étape est "error" sur erreur technique, "fail" si la réponse est de type erreur.
 * `fatal` : exception (timeout, connexion…), la suite de la conversation n'a plus de sens.
 */
export async function playStep(
  s: Pick<Instance, "id" | "port">,
  ctx: StepContext,
  opts: { signal?: AbortSignal; onRequest?: (request: unknown) => void; fullResponse?: boolean } = {},
): Promise<{ step: StepResult; json: any; text: string; fatal: boolean }> {
  const chat = target().chat ?? {};
  const started = performance.now();
  let request: unknown = null;
  try {
    const { status, json, text } = await send(s.port, ctx, opts.signal, (b) => {
      request = chat.redactRequest ? safe(() => chat.redactRequest!(b, ctx), b) : b;
      opts.onRequest?.(request);
    });
    const latencyMs = Math.round(performance.now() - started);
    const kind = safe(() => (chat.kind ?? defaultKind)(status, json), defaultKind(status, json));
    const reply = safe(() => (chat.reply ?? defaultReply)(json), undefined);
    if (json !== null && chat.remember) safe(() => chat.remember!(json, ctx.memory), undefined);
    const technical = status < 200 || status >= 300 || json === null;
    return {
      json, text, fatal: false,
      step: {
        message: ctx.message,
        status: technical ? "error" : kind === "error" ? "fail" : "pass",
        kind,
        latencyMs,
        httpStatus: status,
        reply,
        summary: chat.summary ? safe(() => chat.summary!(json), undefined) : undefined,
        checks: [],
        llmCalls: takeCalls(s.id),
        request,
        response: storedResponse(json, text, opts.fullResponse),
        ...(status < 200 || status >= 300 ? { error: `HTTP ${status}` } : json === null ? { error: tr("réponse non JSON") } : {}),
      },
    };
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    return {
      json: null, text: "", fatal: true,
      step: { message: ctx.message, status: "error", kind: "error", latencyMs: Math.round(performance.now() - started), checks: [], llmCalls: takeCalls(s.id), request, error: String(error) },
    };
  }
}

export async function runServerCase(s: Pick<Instance, "id" | "port">, c: ServerCase, run: number, signal?: AbortSignal): Promise<ServerResult> {
  const types = serverCheckTypes();
  const sessionId = `bench-${newId()}`; // session neuve par cas
  const memory: Record<string, any> = {};
  const steps: StepResult[] = [];
  takeCalls(s.id);
  takePrompts(s.id);

  for (const [index, step] of c.steps.entries()) {
    const ctx: StepContext = { index, step, case: c, sessionId, memory, message: resolveDates(step.message) };
    const { step: st, json, text, fatal } = await playStep(s, ctx, { signal });
    if (!fatal) {
      st.checks = runChecks(types, step.checks ?? [], { json, text: st.reply ?? (json === null ? text : ""), latencyMs: st.latencyMs, status: st.httpStatus, kind: st.kind, message: ctx.message });
      // Sans vérification, une étape réussit si elle n'est pas une erreur technique.
      const failed = step.checks?.length ? st.checks.some((k) => k.pass === false) : st.kind === "error";
      if (st.status !== "error") st.status = failed ? "fail" : "pass";
    }
    steps.push(st);
    if (fatal) break; // la suite de la conversation n'a plus de sens
  }

  const failures = steps.flatMap((st, i) => {
    const prefix = c.steps.length > 1 ? tr("étape {n} : ", { n: i + 1 }) : "";
    if (st.error) return [prefix + st.error];
    const bad = st.checks.filter((k) => k.pass === false).map((k) => prefix + k.label);
    return bad.length || st.status === "pass" ? bad : [prefix + tr("réponse {kind}", { kind: st.kind })];
  });
  if (steps.length < c.steps.length) failures.push(tr("{n} étape(s) non jouée(s)", { n: c.steps.length - steps.length }));

  return {
    id: newId(),
    serverId: s.id,
    caseId: c.id,
    run,
    status: steps.some((st) => st.status === "error") ? "error" : failures.length ? "fail" : "pass",
    latencyMs: steps.reduce((a, st) => a + st.latencyMs, 0),
    steps,
    failures,
    prompts: takePrompts(s.id),
    at: new Date().toISOString(),
  };
}

// =================================================================================================
// Rapports
// =================================================================================================

const reportPath = (id: string) => {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error(tr("id de rapport invalide"));
  return join(serverResultsDir(), `${id}.json`);
};

export function saveServerReport(r: ServerReport) {
  mkdirSync(serverResultsDir(), { recursive: true });
  writeFileSync(reportPath(r.id), JSON.stringify(r, null, 2));
}

export function loadServerReport(id: string): ServerReport {
  return JSON.parse(readFileSync(reportPath(id), "utf8"));
}

export function deleteServerReport(id: string) {
  rmSync(reportPath(id), { force: true });
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

function llmStats(calls: LlmCall[], fallbackModel: string) {
  const ok = calls.filter((c) => !c.error);
  const cost = sumCosts(ok.map((c) => (c.cost === undefined ? costOf(c.model?.includes("/") ? c.model : fallbackModel, c.promptTokens, c.completionTokens) : c.cost)));
  return {
    llmCalls: calls.length,
    llmErrors: calls.length - ok.length,
    avgLlmMs: avg(ok.map((c) => c.latencyMs)),
    avgPromptTokens: avg(ok.flatMap((c) => (c.promptTokens ? [c.promptTokens] : []))),
    avgCompletionTokens: avg(ok.flatMap((c) => (c.completionTokens ? [c.completionTokens] : []))),
    totalCost: ok.length ? cost : null,
  };
}

export function summarizeServers(r: ServerReport) {
  return r.servers.map((s) => {
    const rs = r.results.filter((x) => x.serverId === s.id);
    const steps = rs.flatMap((x) => x.steps).filter((st) => st.status !== "error");
    const checks = rs.flatMap((x) => x.steps.flatMap((st) => st.checks));
    const stats = llmStats(rs.flatMap((x) => x.steps.flatMap((st) => st.llmCalls ?? [])), `${s.provider}/${s.model}`);
    return {
      serverId: s.id,
      name: s.name,
      model: s.model,
      provider: s.provider,
      tier: config().providers[s.provider] ? tierOf(s.provider) : null,
      total: rs.length,
      passed: rs.filter((x) => x.status === "pass").length,
      failed: rs.filter((x) => x.status === "fail").length,
      errors: rs.filter((x) => x.status === "error").length,
      checksOk: checks.filter((k) => k.pass).length,
      checksTotal: checks.filter((k) => k.pass !== null).length,
      avgStepMs: avg(steps.map((st) => st.latencyMs)),
      medianStepMs: median(steps.map((st) => st.latencyMs)),
      maxStepMs: steps.length ? Math.max(...steps.map((st) => st.latencyMs)) : null,
      technicalErrors: rs.flatMap((x) => x.steps).filter((st) => st.kind === "error").length,
      ...stats,
      costPerCase: stats.totalCost != null && rs.length ? stats.totalCost / rs.length : null,
    };
  });
}

export function listServerReports() {
  if (!existsSync(serverResultsDir())) return [];
  return readdirSync(serverResultsDir())
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const r = loadServerReport(f.replace(/\.json$/, ""));
        return [{ id: r.id, name: r.name, date: r.date, status: r.status, runs: r.runs, caseCount: r.cases.length, summary: summarizeServers(r) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function closeStaleServerReports() {
  for (const r of listServerReports()) {
    if (r.status !== "running") continue;
    const full = loadServerReport(r.id);
    full.status = "aborted";
    saveServerReport(full);
  }
}

// =================================================================================================
// Serveurs occupés
// =================================================================================================

/**
 * Serveurs en cours d'utilisation (campagne, rejeu, chat) → raison. Les appels LLM sont capturés par serveur,
 * pas par requête : deux échanges en même temps sur un serveur mélangeraient leurs appels.
 */
const busy = new Map<string, string>();

function claim(s: Pick<Instance, "id" | "name">, reason: string) {
  const current = busy.get(s.id);
  if (current) throw new Error(tr("le serveur {name} est occupé ({reason})", { name: s.name, reason: current }));
  busy.set(s.id, reason);
}

// =================================================================================================
// Campagnes
// =================================================================================================

export type ServerRunEvent =
  | { type: "start"; reportId: string; total: number }
  | { type: "server"; serverId: string; status?: "start" | "done" }
  | { type: "result"; result: ServerResult; done: number; total: number }
  | { type: "done"; reportId: string };

export async function runServerCampaign(
  opts: { serverIds: string[]; cases: ServerCase[]; runs: number; name?: string; parallel?: number },
  onEvent: (e: ServerRunEvent) => void,
  signal?: AbortSignal,
) {
  const servers = opts.serverIds.map(getInstance);
  const notRunning = servers.filter((s) => s.phase !== "running");
  if (notRunning.length) throw new Error(tr("serveur(s) arrêté(s) : {names}", { names: notRunning.map((s) => s.name).join(", ") }));
  const taken = servers.filter((s) => busy.has(s.id));
  if (taken.length) throw new Error(tr("serveur(s) occupé(s) : {names}", { names: taken.map((s) => `${s.name} (${busy.get(s.id)})`).join(", ") }));
  for (const s of servers) claim(s, tr("campagne"));

  const report: ServerReport = {
    id: new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
    name: opts.name,
    date: new Date().toISOString(),
    status: "running",
    runs: opts.runs,
    servers: servers.map(({ id, name, provider, model, port, sourceCommit, updatedAt }) => ({ id, name, provider, model, port, sourceCommit, updatedAt })),
    cases: opts.cases,
    results: [],
    prompts: {},
  };
  const total = servers.length * opts.cases.length * opts.runs;
  let done = 0;
  saveServerReport(report);
  onEvent({ type: "start", reportId: report.id, total });

  // Cas d'un serveur toujours l'un après l'autre : ses appels LLM sont capturés par serveur, pas par cas.
  const runServer = async (s: (typeof servers)[number]) => {
    if (signal?.aborted) return;
    onEvent({ type: "server", serverId: s.id, status: "start" });
    for (const c of opts.cases) {
      for (let run = 1; run <= opts.runs; run++) {
        if (signal?.aborted) return;
        let result: ServerResult;
        try {
          result = await runServerCase(s, c, run, signal);
        } catch {
          return; // arrêt demandé
        }
        Object.assign(report.prompts, result.prompts);
        delete result.prompts;
        report.results.push(result);
        saveServerReport(report);
        onEvent({ type: "result", result, done: ++done, total });
      }
    }
    onEvent({ type: "server", serverId: s.id, status: "done" });
  };

  try {
    const parallel = Math.max(1, Math.floor(opts.parallel ?? 1));
    if (parallel === 1) {
      // Un serveur après l'autre : deux modèles locaux en parallèle se disputeraient la mémoire.
      for (const s of servers) await runServer(s);
    } else {
      // Serveurs sur modèle local : l'un après l'autre ; serveurs sur modèle distant : jusqu'à `parallel` à la fois.
      const local = servers.filter((s) => isLocalProvider(s.provider));
      const remote = servers.filter((s) => !local.includes(s));
      await Promise.all([(async () => { for (const s of local) await runServer(s); })(), pool(remote, parallel, runServer)]);
      const si = (id: string) => opts.serverIds.indexOf(id), ci = (id: string) => opts.cases.findIndex((c) => c.id === id);
      report.results.sort((x, y) => si(x.serverId) - si(y.serverId) || ci(x.caseId) - ci(y.caseId) || x.run - y.run);
    }
  } finally {
    for (const s of servers) busy.delete(s.id);
    report.status = signal?.aborted ? "aborted" : "done";
    saveServerReport(report);
    onEvent({ type: "done", reportId: report.id });
  }
  return report;
}

/** Rejoue un résultat (version actuelle du cas si elle existe encore). Le serveur doit tourner. */
export async function replayServerResult(report: ServerReport, resultId: string) {
  const index = report.results.findIndex((r) => r.id === resultId);
  if (index === -1) throw new Error(tr("résultat introuvable"));
  const old = report.results[index];
  const current = loadServerCases().find((x) => x.id === old.caseId);
  const snapshot = report.cases.findIndex((x) => x.id === old.caseId);
  const c = current ?? report.cases[snapshot];
  if (!c) throw new Error(tr("cas {id} introuvable", { id: old.caseId }));
  if (current && snapshot !== -1) report.cases[snapshot] = current;
  const s = getInstance(old.serverId);
  if (s.phase !== "running") throw new Error(tr("le serveur {name} est arrêté", { name: s.name }));
  claim(s, tr("rejeu"));
  let fresh: ServerResult;
  try {
    fresh = await runServerCase(s, c, old.run);
  } finally {
    busy.delete(s.id);
  }
  fresh.id = old.id;
  report.prompts = { ...report.prompts, ...fresh.prompts };
  delete fresh.prompts;
  report.results[index] = fresh;
  saveServerReport(report);
  return fresh;
}

// =================================================================================================
// Chat : messages libres envoyés au serveur, sans vérification
// =================================================================================================

/** Conversation du chat : une session du serveur testé, comme un cas dont les étapes s'ajoutent au fil des messages. */
interface ServerChat {
  id: string;
  serverId: string;
  sessionId: string;
  memory: Record<string, any>;
  case: ServerCase;
}

const chats = new Map<string, ServerChat>();
const MAX_CHATS = 50;

export type ChatServerEvent =
  | { type: "request"; target: string; chatId: string; index: number; request: unknown }
  | { type: "llm-call"; target: string; call: LlmCall; prompts: Record<string, string> }
  | { type: "response"; target: string; chatId: string; step: StepResult; prompts: Record<string, string> };

/**
 * Envoie un message au serveur dans la conversation `chatId` (nouvelle si absente ou inconnue) : même requête
 * qu'une étape de cas (session, mémoire, options d'étape, champs du cas). Les appels LLM du serveur sont
 * transmis au fil de l'eau. Vérifie le serveur avant de commencer : une erreur ici précède tout événement.
 */
export function chatServer(opts: { chatId?: string; serverId: string; message: string; options?: Record<string, unknown>; fields?: Record<string, unknown> }) {
  const s = getInstance(opts.serverId);
  if (s.phase !== "running") throw new Error(tr("le serveur {name} est arrêté", { name: s.name }));
  if (!opts.message.trim()) throw new Error(tr("message vide"));
  let chat = opts.chatId ? chats.get(opts.chatId) : undefined;
  if (!chat || chat.serverId !== s.id) {
    const t = target();
    const fields = Object.fromEntries((t.caseFields ?? []).flatMap((f) => (isEmpty(opts.fields?.[f.name]) ? [] : [[f.name, opts.fields![f.name]]])));
    chat = { id: `chat-${newId()}`, serverId: s.id, sessionId: `bench-${newId()}`, memory: {}, case: { id: "chat", ...fields, steps: [] } };
    chats.set(chat.id, chat);
    if (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value!);
  }
  const options = Object.fromEntries((target().stepOptions ?? []).flatMap((o) => (isEmpty(opts.options?.[o.name]) || (o.notFirst && !chat!.case.steps.length) ? [] : [[o.name, opts.options![o.name]]])));
  claim(s, tr("chat"));
  const current = chat;

  return async (onEvent: (e: ChatServerEvent) => void, signal?: AbortSignal) => {
    const step: ServerStep = { message: opts.message, ...options };
    const index = current.case.steps.length;
    const ctx: StepContext = { index, step, case: { ...current.case, steps: [...current.case.steps, step] }, sessionId: current.sessionId, memory: current.memory, message: resolveDates(step.message) };
    takeCalls(s.id);
    takePrompts(s.id);
    const unwatch = watchCalls(s.id, (call) => onEvent({ type: "llm-call", target: s.id, call, prompts: peekPrompts(s.id) }));
    try {
      const { step: result, fatal } = await playStep(s, ctx, { signal, fullResponse: true, onRequest: (request) => onEvent({ type: "request", target: s.id, chatId: current.id, index, request }) });
      // Étape en erreur technique : pas gardée dans la conversation, le message suivant reprend au même point.
      if (!fatal) current.case.steps.push(step);
      onEvent({ type: "response", target: s.id, chatId: current.id, step: result, prompts: takePrompts(s.id) });
      return result;
    } finally {
      unwatch();
      busy.delete(s.id);
    }
  };
}
