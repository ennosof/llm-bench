/**
 * Bench prompt : appel direct du modèle avec le prompt système du projet, vérification de la réponse.
 *
 * Pour trier rapidement des modèles et mettre au point un prompt, sans lancer le serveur.
 */
import { lang, tr } from "./i18n.js";
import { resolveSystem, resolveVersion } from "./prompt-source.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMON_CHECKS, checkLabel, dayFromToday, resolveDates, runChecks, type CheckResult } from "./checks.js";
import { config, type CheckType, type ChatMessage, type PromptCase } from "./config.js";
import { modelRuntimeInfo, ollamaUrlOf } from "./ollama.js";
import { adaptBody, complete, costOf, isLocalProvider, parseModelKey, pool, provider, sumCosts, tierOf } from "./providers.js";

export const casesFile = () => join(config().dataDir, "prompt-cases.json");
export const resultsDir = () => join(config().dataDir, "results");

function promptConfig() {
  const p = config().prompt;
  if (!p) throw new Error(tr("pas de bench prompt : section « prompt » absente de la config"));
  return p;
}

export function promptCheckTypes(): Record<string, CheckType> {
  return { ...COMMON_CHECKS, ...(config().prompt?.checks ?? {}) };
}

// =================================================================================================
// Cas de test
// =================================================================================================

export function loadCases(): PromptCase[] {
  return existsSync(casesFile()) ? JSON.parse(readFileSync(casesFile(), "utf8")) : [];
}

export function saveCases(cases: PromptCase[]) {
  mkdirSync(config().dataDir, { recursive: true });
  writeFileSync(casesFile(), JSON.stringify(cases, null, 2) + "\n");
}

export function validateCase(c: any): string | null {
  if (!c || typeof c !== "object") return tr("cas invalide");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(c.id ?? "")) return tr("id : lettres, chiffres, - et _ uniquement (64 max)");
  if (!String(c.message ?? "").trim()) return tr("message obligatoire");
  for (const h of c.history ?? []) if (!["user", "assistant"].includes(h.role) || typeof h.content !== "string") return tr("historique invalide");
  const types = promptCheckTypes();
  for (const k of c.checks ?? []) if (!types[k.type]) return tr("vérification inconnue : {type}", { type: k.type });
  return null;
}

export function cleanCase(c: any): PromptCase {
  return {
    id: c.id.trim(),
    ...(c.description?.trim() ? { description: c.description.trim() } : {}),
    ...(c.category?.trim() ? { category: c.category.trim() } : {}),
    message: c.message,
    ...(c.history?.length ? { history: c.history } : {}),
    checks: c.checks ?? [],
  };
}

// =================================================================================================
// Appel du modèle
// =================================================================================================

export async function systemPrompt() {
  return resolveSystem(promptConfig());
}

export function buildMessages(system: string, c: PromptCase): ChatMessage[] {
  const p = promptConfig();
  const history = (c.history ?? []).map((h) => ({ role: h.role, content: resolveDates(h.content) }));
  const message = resolveDates(c.message);
  const user = p.user ? p.user(message, { history, today: dayFromToday(0), tomorrow: dayFromToday(1), case: c }) : message;
  return [{ role: "system", content: system }, ...history, { role: "user", content: user }];
}

function requestParams(model: string) {
  const p = promptConfig();
  return p.request ? p.request(model) : { temperature: 0, max_tokens: 4096 };
}

/** Du premier "{" au dernier "}". */
export function extractJson(text: string): any {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

function parse(text: string): { json: any; valid: boolean } {
  const mode = promptConfig().parse ?? "json";
  if (mode === "text") return { json: null, valid: true };
  if (typeof mode === "function") {
    try {
      const json = mode(text);
      return { json, valid: json != null };
    } catch {
      return { json: null, valid: false };
    }
  }
  const json = extractJson(text);
  return { json, valid: json !== null };
}

export const systemPlaceholder = () => tr("<prompt système — voir « Prompt système » dans le rapport>");

export interface RunResult {
  id: string;
  model: string; // fournisseur/modèle
  caseId: string;
  run: number;
  status: "pass" | "fail" | "error";
  jsonValid: boolean;
  checks: CheckResult[];
  failures: string[];
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSec?: number;
  /** Tokens d'entrée attendus (≈ caractères / 4), comparés à promptTokens. */
  expectedPromptTokens?: number;
  /** Ollama : entrée nettement plus courte que prévu, contexte probablement tronqué (OLLAMA_CONTEXT_LENGTH). */
  contextTruncated?: boolean;
  cost?: number | null;
  finishReason?: string;
  request: { model: string; body: any };
  raw?: string;
  parsed?: any;
  error?: string;
  at: string;
  previous?: Array<Pick<RunResult, "status" | "failures" | "latencyMs" | "raw" | "at">>;
}

const newId = () => Math.random().toString(36).slice(2, 10);

export async function runCase(system: string, key: string, c: PromptCase, run: number, signal?: AbortSignal): Promise<RunResult> {
  const ref = parseModelKey(key);
  const messages = buildMessages(system, c);
  const body = { ...requestParams(ref.model), messages };
  const types = promptCheckTypes();
  const checkDefs = c.checks ?? [];
  const base = {
    id: newId(),
    model: key,
    caseId: c.id,
    run,
    at: new Date().toISOString(),
    // Corps tel qu'envoyé (après adaptation au modèle) ; le prompt système est stocké une seule fois dans le rapport.
    request: { model: key, body: { ...adaptBody(ref.provider, ref.model, { ...body, model: ref.model }), messages: [{ role: "system", content: systemPlaceholder() }, ...messages.slice(1)] } },
  };
  const started = performance.now();

  try {
    const r = await complete(ref, body, { signal });
    const latencyMs = Math.round(performance.now() - started);
    const tokensPerSec = r.completionTokens ? Math.round((r.completionTokens / latencyMs) * 10000) / 10 : undefined;
    // Ollama coupe le début d'une entrée trop longue pour son contexte, sans erreur : à signaler.
    const expectedPromptTokens = Math.round(messages.reduce((n, m) => n + String(m.content).length, 0) / 4);
    const contextTruncated = provider(ref.provider).kind === "ollama" && !!r.promptTokens && r.promptTokens < expectedPromptTokens * 0.7;
    const metrics = {
      latencyMs, promptTokens: r.promptTokens, completionTokens: r.completionTokens, tokensPerSec, expectedPromptTokens,
      ...(contextTruncated ? { contextTruncated } : {}),
      cost: costOf(key, r.promptTokens, r.completionTokens), finishReason: r.finishReason, raw: r.text,
    };
    const { json, valid } = parse(r.text);
    if (!valid) {
      return {
        ...base, ...metrics, status: "fail", jsonValid: false,
        checks: checkDefs.map((k) => ({ label: checkLabel(types, k), pass: null })),
        failures: [tr("JSON absent ou invalide")],
      };
    }
    const checks = runChecks(types, checkDefs, { json, text: r.text, latencyMs, message: resolveDates(c.message) });
    const failures = checks.filter((k) => k.pass === false).map((k) => k.label);
    return { ...base, ...metrics, status: failures.length ? "fail" : "pass", jsonValid: true, parsed: json ?? undefined, checks, failures };
  } catch (error) {
    return {
      ...base,
      status: "error",
      jsonValid: false,
      checks: checkDefs.map((k) => ({ label: checkLabel(types, k), pass: null })),
      failures: [tr("erreur d'appel")],
      latencyMs: Math.round(performance.now() - started),
      error: String(error),
    };
  }
}

// =================================================================================================
// Rapports
// =================================================================================================

export interface ModelInfo {
  name: string; // fournisseur/modèle
  loadMs?: number;
  runtime?: { size: number; sizeVram: number; contextLength?: number } | null;
  error?: string;
}

export interface Report {
  id: string;
  name?: string;
  date: string;
  status: "running" | "done" | "aborted";
  promptVersion?: string;
  systemPrompt: string;
  runs: number;
  models: ModelInfo[];
  cases: PromptCase[]; // copie des cas au moment du lancement
  results: RunResult[];
}

const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

function tierOfKey(key: string) {
  try {
    return tierOf(parseModelKey(key).provider);
  } catch {
    return null;
  }
}

export function summarize(report: Report) {
  return report.models.map((m) => {
    const rs = report.results.filter((r) => r.model === m.name);
    const tps = rs.flatMap((r) => (r.tokensPerSec ? [r.tokensPerSec] : []));
    const ok = rs.filter((r) => r.status !== "error");
    const totalCost = sumCosts(ok.map((r) => (r.cost === undefined ? costOf(r.model, r.promptTokens, r.completionTokens) : r.cost)));
    return {
      model: m.name,
      tier: tierOfKey(m.name),
      total: rs.length,
      passed: rs.filter((r) => r.status === "pass").length,
      jsonOk: rs.filter((r) => r.jsonValid).length,
      errors: rs.filter((r) => r.status === "error").length,
      truncated: rs.filter((r) => r.contextTruncated).length,
      avgLatencyMs: avg(rs.map((r) => r.latencyMs)),
      medianLatencyMs: median(rs.map((r) => r.latencyMs)),
      avgPromptTokens: avg(rs.flatMap((r) => (r.promptTokens ? [r.promptTokens] : []))),
      avgCompletionTokens: avg(rs.flatMap((r) => (r.completionTokens ? [r.completionTokens] : []))),
      avgTokensPerSec: tps.length ? Math.round((tps.reduce((a, b) => a + b, 0) / tps.length) * 10) / 10 : null,
      totalCost,
      costPerCall: totalCost != null && ok.length ? totalCost / ok.length : null,
      loadMs: m.loadMs ?? null,
      runtime: m.runtime ?? null,
      error: m.error,
    };
  });
}

const reportPath = (id: string) => {
  if (!/^[\w-]{1,80}$/.test(id)) throw new Error(tr("id de rapport invalide"));
  return join(resultsDir(), `${id}.json`);
};

export function saveReport(report: Report) {
  mkdirSync(resultsDir(), { recursive: true });
  writeFileSync(reportPath(report.id), JSON.stringify(report, null, 2));
}

export function loadReport(id: string): Report {
  return JSON.parse(readFileSync(reportPath(id), "utf8")) as Report;
}

export function deleteReport(id: string) {
  const p = reportPath(id);
  if (existsSync(p)) unlinkSync(p);
  const md = p.replace(/\.json$/, ".md");
  if (existsSync(md)) unlinkSync(md);
}

export function listReports() {
  if (!existsSync(resultsDir())) return [];
  return readdirSync(resultsDir())
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const r = loadReport(f.replace(/\.json$/, ""));
        if (!Array.isArray(r.results) || !Array.isArray(r.models)) return [];
        return [{ id: r.id, name: r.name, date: r.date, status: r.status, promptVersion: r.promptVersion, runs: r.runs, caseCount: r.cases.length, summary: summarize(r) }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Classement des modèles sur toutes les campagnes du bench prompt : réussite, JSON valide, latence et
 * débit médians, coût moyen par appel, date du dernier test. Sert à la page Modèles et aux estimations.
 */
export function modelLeaderboard() {
  if (!existsSync(resultsDir())) return [];
  const by = new Map<string, RunResult[]>();
  for (const f of readdirSync(resultsDir()).filter((f) => f.endsWith(".json"))) {
    try {
      const r = loadReport(f.replace(/\.json$/, ""));
      for (const x of r.results ?? []) by.set(x.model, [...(by.get(x.model) ?? []), x]);
    } catch {
      // rapport illisible : ignoré
    }
  }
  return [...by.entries()].map(([model, rs]) => {
    const ok = rs.filter((r) => !r.error);
    const costs = ok.map((r) => (r.cost === undefined ? costOf(r.model, r.promptTokens, r.completionTokens) : r.cost));
    const total = sumCosts(costs);
    return {
      model,
      tier: config().providers[parseModelKey(model).provider] ? tierOf(parseModelKey(model).provider) : null,
      total: rs.length,
      passed: rs.filter((r) => r.status === "pass").length,
      jsonOk: rs.filter((r) => r.jsonValid).length,
      errors: rs.filter((r) => r.status === "error").length,
      medianLatencyMs: median(rs.map((r) => r.latencyMs).filter((v) => v != null)),
      medianTokensPerSec: median(rs.flatMap((r) => (r.tokensPerSec ? [r.tokensPerSec] : []))),
      costPerCall: total != null && ok.length ? total / ok.length : null,
      lastAt: rs.reduce((a, r) => (r.at > a ? r.at : a), ""),
    };
  }).sort((a, b) => b.passed / b.total - a.passed / a.total);
}

/** Marque "interrompu" les rapports restés "en cours" (processus arrêté pendant une campagne). */
export function closeStaleReports() {
  for (const r of listReports()) {
    if (r.status !== "running") continue;
    const full = loadReport(r.id);
    full.status = "aborted";
    saveReport(full);
  }
}

/** Rejoue un résultat : version actuelle du cas si elle existe encore, sinon la copie du rapport. */
export async function replayResult(report: Report, resultId: string) {
  const index = report.results.findIndex((r) => r.id === resultId);
  if (index === -1) throw new Error(tr("résultat introuvable"));
  const old = report.results[index];
  const current = loadCases().find((c) => c.id === old.caseId);
  const snapshotIndex = report.cases.findIndex((c) => c.id === old.caseId);
  const c = current ?? report.cases[snapshotIndex];
  if (!c) throw new Error(tr("cas {id} introuvable", { id: old.caseId }));
  if (current && snapshotIndex !== -1) report.cases[snapshotIndex] = current;

  const fresh = await runCase(report.systemPrompt, old.model, c, old.run);
  fresh.id = old.id;
  fresh.previous = [{ status: old.status, failures: old.failures, latencyMs: old.latencyMs, raw: old.raw, at: old.at }, ...(old.previous ?? [])];
  report.results[index] = fresh;
  saveReport(report);
  return fresh;
}

const money = (v: number | null) => (v == null ? "–" : `${v < 0.01 && v > 0 ? v.toFixed(5) : v.toFixed(3)} ${config().currency}`);

export function reportToMarkdown(report: Report) {
  const summary = summarize(report);
  const pct = (n: number, t: number) => (t ? `${Math.round((n / t) * 100)}%` : "–");
  return [
    tr("# Bench prompt — {date}", { date: new Date(report.date).toLocaleString(lang() === "en" ? "en-GB" : "fr-FR") }),
    "",
    `${report.promptVersion ? `Prompt v${report.promptVersion} · ` : ""}${tr("{cases} cas × {runs} run(s)", { cases: report.cases.length, runs: report.runs })}`,
    "",
    tr("| Modèle | Offre | Score | JSON valide | Latence moy. | Tokens sortie moy. | tok/s | Coût total |"),
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summary.map((s) => `| ${s.model} | ${s.tier ?? "–"} | ${pct(s.passed, s.total)} | ${pct(s.jsonOk, s.total)} | ${((s.avgLatencyMs ?? 0) / 1000).toFixed(1)}s | ${s.avgCompletionTokens ?? "–"} | ${s.avgTokensPerSec ?? "–"} | ${money(s.totalCost)} |`),
    "",
    tr("## Détail par cas"),
    "",
    `| ${tr("Cas")} | ${summary.map((s) => s.model).join(" | ")} |`,
    `| --- | ${summary.map(() => "---").join(" | ")} |`,
    ...report.cases.map((c) => {
      const cells = summary.map((s) => {
        const rs = report.results.filter((r) => r.model === s.model && r.caseId === c.id);
        const why = rs.find((r) => r.status !== "pass")?.failures.join(" ; ") ?? "";
        return `${rs.filter((r) => r.status === "pass").length}/${rs.length}${why ? ` (${why})` : ""}`;
      });
      return `| ${c.id} | ${cells.join(" | ")} |`;
    }),
    "",
  ].join("\n");
}

// =================================================================================================
// Campagne (CLI et interface)
// =================================================================================================

export type RunEvent =
  | { type: "start"; reportId: string; total: number }
  | { type: "model"; model: string; status: "loading" | "ready" | "error" | "done"; info?: ModelInfo }
  | { type: "result"; result: RunResult; done: number; total: number }
  | { type: "done"; reportId: string; status: Report["status"] };

export async function runCampaign(
  opts: { models: string[]; cases: PromptCase[]; runs: number; name?: string; parallel?: number },
  onEvent: (e: RunEvent) => void,
  signal?: AbortSignal,
): Promise<Report> {
  for (const m of opts.models) provider(parseModelKey(m).provider); // vérifie les fournisseurs avant de commencer
  const system = await systemPrompt();
  const report: Report = {
    id: new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
    name: opts.name,
    date: new Date().toISOString(),
    status: "running",
    promptVersion: await resolveVersion(promptConfig(), system),
    systemPrompt: system,
    runs: opts.runs,
    models: opts.models.map((name) => ({ name })),
    cases: opts.cases,
    results: [],
  };
  const total = opts.models.length * opts.cases.length * opts.runs;
  let done = 0;
  saveReport(report);
  onEvent({ type: "start", reportId: report.id, total });

  const parallel = Math.max(1, Math.floor(opts.parallel ?? 1));
  const push = (result: RunResult) => {
    report.results.push(result);
    saveReport(report);
    onEvent({ type: "result", result, done: ++done, total });
  };

  // Un modèle local : chargement mesuré à part, puis ses cas un par un.
  const runSequential = async (info: ModelInfo) => {
    if (signal?.aborted) return;
    const ref = parseModelKey(info.name);
    const p = provider(ref.provider);
    onEvent({ type: "model", model: info.name, status: "loading" });
    if (p.kind === "ollama") {
      // Premier appel non mesuré : charge le modèle en mémoire.
      const t0 = performance.now();
      try {
        await complete(ref, { messages: [{ role: "user", content: 'Réponds {"ok":true}' }], max_tokens: 16 }, { signal });
        info.loadMs = Math.round(performance.now() - t0);
        info.runtime = await modelRuntimeInfo(ollamaUrlOf(p), ref.model);
      } catch (error) {
        if (signal?.aborted) return;
        info.error = String(error);
        done += opts.cases.length * opts.runs;
        saveReport(report);
        onEvent({ type: "model", model: info.name, status: "error", info });
        return;
      }
    }
    onEvent({ type: "model", model: info.name, status: "ready", info });
    for (const c of opts.cases) {
      for (let run = 1; run <= opts.runs; run++) {
        if (signal?.aborted) return;
        const result = await runCase(system, info.name, c, run, signal);
        if (signal?.aborted) return;
        push(result);
      }
    }
    onEvent({ type: "model", model: info.name, status: "done", info });
  };

  try {
    if (parallel === 1) {
      for (const info of report.models) await runSequential(info);
    } else {
      // Modèles locaux l'un après l'autre (mémoire, GPU) ; modèles distants en parallèle, cas entrelacés
      // entre modèles, au plus `parallel` appels simultanés.
      const local = report.models.filter((m) => isLocalProvider(parseModelKey(m.name).provider));
      const remote = report.models.filter((m) => !local.includes(m));
      const tasks = opts.cases.flatMap((c) => Array.from({ length: opts.runs }, (_, i) => remote.map((info) => ({ info, c, run: i + 1 })))).flat();
      const left = new Map(remote.map((m) => [m.name, opts.cases.length * opts.runs]));
      for (const info of remote) onEvent({ type: "model", model: info.name, status: "ready", info });
      await Promise.all([
        (async () => { for (const info of local) await runSequential(info); })(),
        pool(tasks, parallel, async ({ info, c, run }) => {
          if (signal?.aborted) return;
          const result = await runCase(system, info.name, c, run, signal);
          if (signal?.aborted) return;
          push(result);
          left.set(info.name, left.get(info.name)! - 1);
          if (!left.get(info.name)) onEvent({ type: "model", model: info.name, status: "done", info });
        }),
      ]);
      // Ordre stable dans le rapport : modèle, cas, run.
      const mi = (n: string) => opts.models.indexOf(n), ci = (id: string) => opts.cases.findIndex((c) => c.id === id);
      report.results.sort((x, y) => mi(x.model) - mi(y.model) || ci(x.caseId) - ci(y.caseId) || x.run - y.run);
    }
  } finally {
    report.status = signal?.aborted ? "aborted" : "done";
    saveReport(report);
    onEvent({ type: "done", reportId: report.id, status: report.status });
  }
  return report;
}
