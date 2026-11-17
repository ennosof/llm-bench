/**
 * Fournisseurs de modèles : appels compatibles OpenAI, liste des modèles, coût des tokens.
 *
 * Un modèle est désigné par "fournisseur/modèle", ex. "ollama/qwen2.5:7b" ou
 * "openrouter/meta-llama/llama-3.3-70b-instruct:free" (seul le premier "/" sépare).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_PROVIDERS_FILE, config, configKeys, uiKeys, uiProviders, type ProviderConfig, type Tier } from "./config.js";
import { listLocalModels, ollamaUrlOf } from "./ollama.js";
import { tr } from "./i18n.js";

export interface ModelRef {
  provider: string;
  model: string;
}

export function parseModelKey(key: string): ModelRef {
  const i = String(key ?? "").indexOf("/");
  if (i <= 0 || i === key.length - 1) throw new Error(tr("modèle \"{key}\" : format attendu fournisseur/modèle", { key }));
  return { provider: key.slice(0, i), model: key.slice(i + 1) };
}

export const modelKey = (r: ModelRef) => `${r.provider}/${r.model}`;

export function provider(name: string): ProviderConfig {
  const p = config().providers[name];
  if (!p) throw new Error(tr("fournisseur inconnu : {name}", { name }));
  return p;
}

export const tierOf = (name: string): Tier => config().providers[name]?.tier ?? (config().providers[name]?.kind === "ollama" ? "free" : "paid");

/** Modèle exécuté sur cette machine (Ollama ou endpoint local) : jamais lancé en parallèle d'un autre. */
export function isLocalProvider(name: string): boolean {
  const p = config().providers[name];
  return p?.kind === "ollama" || /\/\/(localhost|127\.0\.0\.1|\[::1\])\b/.test(p?.baseUrl ?? "");
}

/** Exécute `fn` sur chaque élément avec au plus `limit` appels simultanés (ordre de démarrage conservé). */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** Raison pour laquelle un fournisseur est inutilisable, ou null. */
export function unavailable(name: string): string | null {
  const p = config().providers[name];
  if (!p) return tr("fournisseur inconnu");
  if (!p.baseUrl) return tr("baseUrl absente");
  if (p.kind !== "ollama" && !p.apiKey && !/localhost|127\.0\.0\.1/.test(p.baseUrl)) return tr("clé API absente");
  return null;
}

export function providersForUi() {
  return Object.entries(config().providers).map(([name, p]) => ({
    name,
    label: p.label ?? name,
    kind: p.kind ?? "openai",
    tier: tierOf(name),
    baseUrl: p.baseUrl ?? "",
    models: p.models ?? [],
    priced: Object.keys(p.pricing ?? {}),
    unavailable: unavailable(name),
    fromUi: uiProviders.has(name),
    keyFromUi: uiKeys.has(name),
    prices: p.pricing ?? {},
    apiKeyHeader: p.apiKeyHeader ?? "authorization",
  }));
}

// =================================================================================================
// Fournisseurs ajoutés depuis l'interface
// =================================================================================================

export interface UiProviderInput {
  name: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  tier?: Tier;
  model: string;
  /** Prix par million de tokens du modèle ajouté. */
  input?: number | null;
  output?: number | null;
  /** Modification : modèle remplacé (renommage). */
  originalModel?: string;
}

const localFile = () => join(config().dataDir, LOCAL_PROVIDERS_FILE);

function readLocal(): Record<string, ProviderConfig> {
  return existsSync(localFile()) ? JSON.parse(readFileSync(localFile(), "utf8")) : {};
}

function writeLocal(local: Record<string, ProviderConfig>) {
  mkdirSync(config().dataDir, { recursive: true });
  writeFileSync(localFile(), JSON.stringify(local, null, 2) + "\n", { mode: 0o600 });
  // Le fichier contient des clés : l'ajouter au .gitignore du dossier de données s'il existe.
  const ignore = join(config().dataDir, ".gitignore");
  if (existsSync(ignore) && !readFileSync(ignore, "utf8").split("\n").includes(LOCAL_PROVIDERS_FILE)) {
    const text = readFileSync(ignore, "utf8");
    appendFileSync(ignore, (text.endsWith("\n") || !text ? "" : "\n") + LOCAL_PROVIDERS_FILE + "\n");
  }
}

/** Ajoute un fournisseur, ou un modèle à un fournisseur déjà ajouté depuis l'interface. */
export function addUiProvider(input: UiProviderInput) {
  const name = String(input.name ?? "").trim();
  const model = String(input.model ?? "").trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(tr("nom du fournisseur : lettres, chiffres, - et _ uniquement"));
  if (!model) throw new Error(tr("modèle obligatoire"));
  const cfg = config();
  if (cfg.providers[name] && !uiProviders.has(name)) throw new Error(tr("\"{name}\" est déclaré dans {file} : choisir un autre nom", { name, file: cfg.file }));

  const local = readLocal();
  const prev = local[name];
  const baseUrl = input.baseUrl?.trim() || prev?.baseUrl;
  if (!baseUrl || !/^https?:\/\//.test(baseUrl)) throw new Error(tr("endpoint : URL http(s) obligatoire"));
  const apiKey = input.apiKey?.trim() || prev?.apiKey;
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) throw new Error(tr("clé API obligatoire"));

  const p: ProviderConfig = {
    ...prev,
    label: input.label?.trim() || prev?.label || name,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    tier: input.tier ?? prev?.tier ?? "paid",
    models: [...new Set([...(prev?.models ?? []).filter((m) => m !== input.originalModel), model])],
  };
  if (input.originalModel && input.originalModel !== model && p.pricing?.[input.originalModel]) {
    const { [input.originalModel]: _, ...rest } = p.pricing;
    p.pricing = rest;
  }
  const header = input.apiKeyHeader?.trim().toLowerCase();
  if (header && header !== "authorization") p.apiKeyHeader = header;
  else if (header) delete p.apiKeyHeader;
  if (input.input != null && input.output != null && Number.isFinite(+input.input) && Number.isFinite(+input.output)) {
    p.pricing = { ...p.pricing, [model]: { input: +input.input, output: +input.output } };
  } else if (input.originalModel != null && p.pricing?.[model]) {
    const { [model]: _, ...rest } = p.pricing; // modification sans prix : prix retiré
    p.pricing = rest;
  }

  local[name] = p;
  writeLocal(local);
  cfg.providers = { ...cfg.providers, [name]: p };
  uiProviders.add(name);
  return { key: modelKey({ provider: name, model }) };
}

/** Clé d'un fournisseur de la config, saisie dans l'interface ; null rétablit la clé de la config. */
export function setConfigProviderKey(name: string, apiKey: string | null) {
  const cfg = config();
  if (!cfg.providers[name] || uiProviders.has(name)) throw new Error(tr("\"{name}\" n'est pas un fournisseur de la config", { name }));
  const local = readLocal();
  if (apiKey) {
    local[name] = { apiKey };
    uiKeys.add(name);
  } else {
    delete local[name];
    uiKeys.delete(name);
  }
  writeLocal(local);
  cfg.providers = { ...cfg.providers, [name]: { ...cfg.providers[name], apiKey: apiKey || configKeys.get(name) } };
}

/** Retire un modèle d'un fournisseur ajouté depuis l'interface ; le fournisseur part avec son dernier modèle. */
export function removeUiModel(name: string, model: string) {
  if (!uiProviders.has(name)) throw new Error(tr("\"{name}\" est déclaré dans la config : le modifier dans {file}", { name, file: config().file }));
  const local = readLocal();
  const p = local[name];
  if (!p?.models?.includes(model)) throw new Error(tr("modèle inconnu : {model}", { model: `${name}/${model}` }));
  const models = p.models.filter((m) => m !== model);
  if (!models.length) return removeUiProvider(name);
  const { [model]: _, ...pricing } = p.pricing ?? {};
  local[name] = { ...p, models, pricing };
  writeLocal(local);
  config().providers = { ...config().providers, [name]: local[name] };
}

/** Retire un fournisseur ajouté depuis l'interface (ceux de la config ne se retirent pas d'ici). */
export function removeUiProvider(name: string) {
  if (!uiProviders.has(name)) throw new Error(tr("\"{name}\" n'a pas été ajouté depuis l'interface", { name }));
  const local = readLocal();
  delete local[name];
  writeLocal(local);
  const { [name]: _, ...rest } = config().providers;
  config().providers = rest;
  uiProviders.delete(name);
}

// =================================================================================================
// Requêtes
// =================================================================================================

const trimSlash = (s: string) => s.replace(/\/+$/, "");

/** En-têtes d'authentification et en-têtes fixes du fournisseur. */
export function authHeaders(p: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { ...(p.headers ?? {}) };
  const key = p.apiKey ?? (p.kind === "ollama" ? "ollama" : "");
  if (key) {
    const header = (p.apiKeyHeader ?? "authorization").toLowerCase();
    h[header] = header === "authorization" ? `Bearer ${key}` : key;
  }
  return h;
}

export function upstreamUrl(name: string, path: string) {
  const p = provider(name);
  if (!p.baseUrl) throw new Error(tr("{provider} : baseUrl absente", { provider: name }));
  return trimSlash(p.baseUrl) + (path.startsWith("/") ? path : `/${path}`);
}

/** Modèles de raisonnement OpenAI (o1, o3, o4-mini…, gpt-5 et suivants), y compris derrière un préfixe « fournisseur/ ». */
const isReasoningModel = (model: string) => /^(o\d|gpt-[5-9])/i.test(model.split("/").pop() ?? "");

/**
 * Ces modèles refusent max_tokens (« Unsupported parameter ») et toute temperature autre que 1
 * (« Unsupported value ») : max_tokens devient max_completion_tokens, temperature est retirée.
 */
function adaptReasoning(model: string, body: any) {
  if (!isReasoningModel(model) || !body || typeof body !== "object") return body;
  const { max_tokens, temperature, ...rest } = body;
  return { ...rest, ...(max_tokens !== undefined && rest.max_completion_tokens === undefined ? { max_completion_tokens: max_tokens } : {}) };
}

/** Applique adaptRequest du fournisseur (paramètres non supportés par certains modèles…), sinon l'adaptation par défaut. */
export function adaptBody(name: string, model: string, body: any) {
  const p = provider(name);
  return p.adaptRequest ? p.adaptRequest(structuredClone(body), { provider: name, model }) ?? body : adaptReasoning(model, body);
}

export interface Completion {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
}

export async function complete(ref: ModelRef, body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Completion> {
  const p = provider(ref.provider);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180_000);
  const res = await fetch(upstreamUrl(ref.provider, "/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(p) },
    body: JSON.stringify(adaptBody(ref.provider, ref.model, { ...body, model: ref.model })),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as any;
  return {
    text: String(json.choices?.[0]?.message?.content ?? "").trim(),
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
    finishReason: json.choices?.[0]?.finish_reason,
  };
}

// =================================================================================================
// Modèles disponibles
// =================================================================================================

export interface AvailableModel {
  key: string;
  provider: string;
  model: string;
  tier: Tier;
  details?: string;
  loaded?: boolean;
}

export async function modelsOf(name: string): Promise<AvailableModel[]> {
  const p = provider(name);
  const tier = tierOf(name);
  const out = new Map<string, AvailableModel>();
  const add = (model: string, extra: Partial<AvailableModel> = {}) => out.set(model, { key: modelKey({ provider: name, model }), provider: name, model, tier, ...extra });
  for (const m of p.models ?? []) add(m);
  if (p.kind === "ollama") {
    for (const m of await listLocalModels(ollamaUrlOf(p))) {
      add(m.name, { details: [m.parameterSize, m.quantization].filter(Boolean).join(" · "), loaded: Boolean(m.loaded) });
    }
  } else if (p.listModels && p.baseUrl) {
    const res = await fetch(upstreamUrl(name, "/models"), { headers: authHeaders(p), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GET /models → ${res.status}`);
    for (const m of ((await res.json()) as any).data ?? []) if (m?.id) add(String(m.id));
  }
  return [...out.values()].sort((a, b) => a.model.localeCompare(b.model));
}

/** Tous les modèles des fournisseurs utilisables ; un fournisseur injoignable est signalé sans bloquer les autres. */
export async function availableModels() {
  const names = Object.keys(config().providers);
  const lists = await Promise.all(
    names.map(async (name) => {
      const why = unavailable(name);
      if (why) return { name, models: [] as AvailableModel[], error: why };
      try {
        return { name, models: await modelsOf(name) };
      } catch (error) {
        return { name, models: [] as AvailableModel[], error: String(error instanceof Error ? error.message : error) };
      }
    }),
  );
  return lists;
}

// =================================================================================================
// Coût
// =================================================================================================

/** Coût d'un appel dans la devise de la config ; 0 pour un fournisseur gratuit, null si le prix est inconnu. */
export function costOf(key: string, promptTokens?: number, completionTokens?: number): number | null {
  let ref: ModelRef;
  try {
    ref = parseModelKey(key);
  } catch {
    return null;
  }
  const p = config().providers[ref.provider];
  if (!p) return null;
  if (tierOf(ref.provider) === "free") return 0;
  const price = p.pricing?.[ref.model] ?? p.pricing?.["*"];
  if (!price || (promptTokens == null && completionTokens == null)) return null;
  return ((promptTokens ?? 0) * price.input + (completionTokens ?? 0) * price.output) / 1e6;
}

/** Somme des coûts : null si un des coûts est inconnu. */
export function sumCosts(costs: Array<number | null | undefined>) {
  if (!costs.length) return null;
  let total = 0;
  for (const c of costs) {
    if (c == null) return null;
    total += c;
  }
  return total;
}
