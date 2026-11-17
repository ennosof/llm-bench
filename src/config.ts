/**
 * Configuration du bench : un fichier bench.config.ts (ou .mjs / .js) dans le projet testé.
 *
 * Le fichier exporte par défaut un objet BenchConfig. Il est exécuté avec tsx : il peut importer
 * le code du projet (prompt système, utilitaires…) et déclarer des fonctions (vérifications,
 * corps de requête…). Aucune dépendance au bench n'est nécessaire dans le projet testé.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tr } from "./i18n.js";

// =================================================================================================
// Types publics
// =================================================================================================

export type Tier = "free" | "paid";

export interface ProviderConfig {
  /** "openai" (défaut) : toute API compatible OpenAI. "ollama" : idem, plus la gestion des modèles locaux. */
  kind?: "openai" | "ollama";
  label?: string;
  /** URL compatible OpenAI, ex. http://localhost:11434/v1 ou https://openrouter.ai/api/v1. */
  baseUrl?: string;
  apiKey?: string;
  /** En-tête de la clé : "authorization" (Bearer, défaut) ou un nom d'en-tête, ex. "api-key". */
  apiKeyHeader?: string;
  headers?: Record<string, string>;
  /** Gratuit ou payant : sert aux filtres, aux profils de la passerelle et au calcul du coût. */
  tier?: Tier;
  /** Modèles proposés dans l'interface (Ollama : les modèles installés sont listés en plus). */
  models?: string[];
  /** Interroge GET /models pour lister les modèles disponibles. */
  listModels?: boolean;
  /** Prix par million de tokens, par modèle. "*" s'applique aux modèles non listés. */
  pricing?: Record<string, { input: number; output: number }>;
  /** Adapte le corps d'une requête au modèle (paramètres non supportés…), y compris dans la passerelle. */
  adaptRequest?: (body: any, ctx: { provider: string; model: string }) => any;
}

export type FieldKind = "text" | "number" | "date" | "select" | "tuples" | "boolean";

/** Champ éditable dans l'interface (vérification, option d'étape, champ de cas). */
export interface FieldDef {
  name: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  placeholder?: string;
  /** tuples : clés de chaque élément, saisi "a+b, c+d" (ex. ["adult", "child"]). */
  keys?: string[];
  /** Option d'étape : non proposée à la première étape. */
  notFirst?: boolean;
  description?: string;
  default?: unknown;
}

/** Ce qu'une vérification inspecte : la réponse du modèle (bench prompt) ou du serveur (bench serveur). */
export interface CheckSubject {
  /** JSON extrait de la réponse (null si absent). */
  json: any;
  /** Texte : réponse brute du modèle, ou message rédigé renvoyé par le serveur. */
  text: string;
  latencyMs: number;
  /** Bench serveur : code HTTP et type de réponse. */
  status?: number;
  kind?: string;
}

export interface CheckHelpers {
  /** "J+1", "{{J+1}}", "today+1" ou "2026-12-24" → date ISO (AAAA-MM-JJ, UTC). */
  date: (value: unknown) => string;
  /** Lecture d'un chemin "a.b.0.c". */
  get: (obj: any, path: string) => any;
  lower: (value: unknown) => string;
  /** "a, b, c" → ["a", "b", "c"] en minuscules. */
  list: (value: unknown) => string[];
}

export interface CheckType {
  description: string;
  fields?: FieldDef[];
  label: (check: CheckDef) => string;
  test: (subject: CheckSubject, check: CheckDef, h: CheckHelpers) => boolean;
  /** Vérification préalable : si elle échoue, les suivantes ne sont pas évaluées. */
  gate?: boolean;
}

export interface CheckDef {
  type: string;
  [key: string]: any;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface PromptCase {
  id: string;
  description?: string;
  category?: string;
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  checks?: CheckDef[];
}

/** Export d'un module du projet (chemin relatif à la config), évalué à chaque campagne. */
export interface ModuleRef {
  module: string;
  export: string;
}
/** Fichier texte (chemin relatif à la config). */
export interface FileRef {
  file: string;
}
export type PromptSource = string | (() => string | Promise<string>) | ModuleRef | FileRef;
export type VersionSource = string | (() => string | Promise<string>) | ModuleRef;

export interface PromptBenchConfig {
  /** Prompt système : texte, fonction, { module, export } ou { file } (voir prompt-source.ts). */
  system: PromptSource;
  /** Version affichée dans les rapports (défaut : empreinte du texte). */
  version?: VersionSource;
  /** Construit le message utilisateur envoyé (défaut : le message du cas tel quel). */
  user?: (message: string, ctx: { history: ChatMessage[]; today: string; tomorrow: string; case: PromptCase }) => string;
  /** Paramètres ajoutés au corps de la requête (défaut : temperature 0, max_tokens 4096). */
  request?: (model: string) => Record<string, unknown>;
  /** Lecture de la réponse : "json" (du premier { au dernier }, défaut) ou "text". */
  parse?: "json" | "text" | ((text: string) => any);
  categories?: string[];
  checks?: Record<string, CheckType>;
  /** Cas créés depuis l'interface : catégorie et vérification proposées. */
  newCase?: Partial<PromptCase>;
}

export interface ServerStep {
  message: string;
  checks?: CheckDef[];
  [option: string]: unknown;
}

export interface ServerCase {
  id: string;
  description?: string;
  category?: string;
  steps: ServerStep[];
  [field: string]: unknown;
}

export interface StepContext {
  index: number;
  step: ServerStep;
  case: ServerCase;
  sessionId: string;
  /** Mémoire de la conversation, alimentée par chat.remember (ex. résultats de la réponse précédente). */
  memory: Record<string, any>;
  /** Message avec les dates résolues. */
  message: string;
}

export interface ChatTargetConfig {
  path?: string; // défaut /chat
  method?: string; // défaut POST
  timeoutMs?: number; // défaut 240 s
  headers?: (ctx: StepContext) => Record<string, string>;
  /** Corps de la requête (défaut : { message, sessionId }). */
  body?: (ctx: StepContext) => unknown;
  /** Type de réponse (défaut : "success" si 2xx et JSON, sinon "error"). "error" = erreur technique. */
  kind?: (status: number, json: any) => string;
  kinds?: string[];
  /** Message rédigé de la réponse (défaut : json.reply ?? json.message). */
  reply?: (json: any) => string | undefined;
  /** Résumé court affiché dans le détail d'une étape (ex. "12 résultat(s)"). */
  summary?: (json: any) => string | undefined;
  /** Garde des éléments de la réponse pour les étapes suivantes. */
  remember?: (json: any, memory: Record<string, any>) => void;
  /** Version de la requête enregistrée dans le rapport (pour alléger). */
  redactRequest?: (body: any, ctx: StepContext) => unknown;
  /** Version de la réponse enregistrée dans le rapport (pour alléger). */
  redactResponse?: (json: any) => unknown;
}

export interface ServerTargetConfig {
  /** Projet copié pour chaque serveur (défaut : dossier parent de la config). */
  source?: string;
  /** Dossier des copies (défaut : ../<nom du projet>-bench-servers). */
  instancesDir?: string;
  /** Chemins exclus de la copie, relatifs à source (en plus de node_modules, .git…). */
  exclude?: string[];
  /** Fichier d'environnement du projet, recopié dans chaque serveur (défaut : .env). */
  envFile?: string;
  /** Noms des variables qui donnent au serveur son port et son modèle. */
  /** Noms des variables lues par le projet (défaut : DEFAULT_SERVER_ENV) ; modifiables depuis l'interface. */
  env?: Partial<ServerEnvNames>;
  /** Commandes d'installation (défaut : aucune). */
  install?: string[];
  /** Commandes de build, rejouées à chaque mise à jour du code. */
  build?: string[];
  /** Commande de démarrage. */
  start: string;
  /** Fichier qui doit exister avant de démarrer (ex. dist/main.js). */
  readyFile?: string;
  /** Dossiers partageables par lien symbolique au lieu d'être installés (défaut : node_modules). */
  shareDirs?: string[];
  /** Chemin de santé, prêt quand il répond 2xx (défaut : /health). */
  health?: string;
  startTimeoutMs?: number;
  /** Premier port attribué (défaut : 3101). */
  firstPort?: number;
  chat?: ChatTargetConfig;
  /** Options d'étape proposées dans l'éditeur (cases à cocher), lues par chat.body. */
  stepOptions?: FieldDef[];
  /** Champs de cas supplémentaires (ex. locale). */
  caseFields?: FieldDef[];
  categories?: string[];
  checks?: Record<string, CheckType>;
  /** Nom d'un appel LLM du serveur, pour le détail des étapes. */
  llmCallKind?: (body: any, systemPrompt: string) => string;
}

export interface ServerEnvNames {
  baseUrl: string;
  /** "" : le projet ne lit pas de clé. */
  apiKey: string;
  model: string;
  port: string;
}

export const DEFAULT_SERVER_ENV: ServerEnvNames = { baseUrl: "LLM_ENDPOINT", apiKey: "LLM_API_KEY", model: "LLM_MODEL", port: "PORT" };

export interface GatewayConfig {
  /** Profils : choix rapides de la passerelle, ex. { free: "ollama/qwen2.5:7b", paid: "azure/gpt-4.1" }. */
  profiles?: Record<string, string>;
  /** Profil ou modèle (fournisseur/modèle) au premier démarrage. */
  default?: string;
}

export interface BenchConfig {
  name?: string;
  /** Dossier des cas et rapports (défaut : dossier de la config). */
  dataDir?: string;
  /** Port de l'interface, du proxy et de la passerelle (défaut : 4317). */
  port?: number;
  /** Devise des prix (défaut : "$"). */
  currency?: string;
  providers: Record<string, ProviderConfig>;
  prompt?: PromptBenchConfig;
  server?: ServerTargetConfig;
  gateway?: GatewayConfig;
}

/** Aide au typage dans un bench.config.ts : `export default defineConfig({ … })`. */
export function defineConfig(config: BenchConfig) {
  return config;
}

// =================================================================================================
// Chargement
// =================================================================================================

export interface LoadedConfig extends BenchConfig {
  file: string;
  dir: string;
  dataDir: string;
  port: number;
  currency: string;
}

const CANDIDATES = ["bench.config.ts", "bench.config.mjs", "bench.config.js", "bench/bench.config.ts", "bench/bench.config.mjs"];

export function findConfig(cwd = process.cwd()) {
  for (const c of CANDIDATES) if (existsSync(join(cwd, c))) return join(cwd, c);
  return null;
}

let current: LoadedConfig | null = null;

export function config(): LoadedConfig {
  if (!current) throw new Error(tr("configuration non chargée"));
  return current;
}

export async function loadConfig(file: string): Promise<LoadedConfig> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(tr("configuration introuvable : {path}", { path }));
  const mod = await import(pathToFileURL(path).href);
  const raw = (mod.default ?? mod.config) as BenchConfig | undefined;
  if (!raw || typeof raw !== "object") throw new Error(tr("{path} : export par défaut attendu (objet de configuration)", { path }));
  if (!raw.providers || !Object.keys(raw.providers).length) throw new Error(tr("{path} : au moins un fournisseur dans \"providers\"", { path }));
  for (const name of Object.keys(raw.providers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(tr("fournisseur \"{name}\" : lettres, chiffres, - et _ uniquement", { name }));
  }

  const dir = dirname(path);
  const abs = (p: string | undefined, base: string) => (p ? (isAbsolute(p) ? p : resolve(base, p)) : undefined);
  const cfg: LoadedConfig = {
    ...raw,
    file: path,
    dir,
    dataDir: abs(raw.dataDir, dir) ?? dir,
    port: Number(process.env.BENCH_PORT ?? raw.port ?? 4317),
    currency: raw.currency ?? "$",
  };
  if (cfg.server) {
    if (!cfg.server.start) throw new Error(tr("server.start : commande de démarrage obligatoire"));
    const env = { ...DEFAULT_SERVER_ENV, ...cfg.server.env };
    validateServerEnv(env);
    const source = abs(cfg.server.source, dir) ?? resolve(dir, "..");
    cfg.server = {
      ...cfg.server,
      env,
      source,
      instancesDir: abs(process.env.BENCH_INSTANCES_DIR ?? cfg.server.instancesDir, dir) ?? resolve(source, "..", `${basename(source)}-bench-servers`),
    };
  }
  // Fournisseurs ajoutés depuis l'interface : ceux de la config gardent la priorité.
  uiProviders.clear();
  uiKeys.clear();
  configKeys.clear();
  for (const [name, p] of Object.entries(cfg.providers)) configKeys.set(name, p.apiKey);
  const localFile = join(cfg.dataDir, LOCAL_PROVIDERS_FILE);
  if (existsSync(localFile)) {
    try {
      const local = JSON.parse(readFileSync(localFile, "utf8")) as Record<string, ProviderConfig>;
      for (const [name, p] of Object.entries(local)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
        if (cfg.providers[name]) {
          // Fournisseur de la config : seule la clé saisie dans l'interface s'applique.
          if (p.apiKey) {
            cfg.providers = { ...cfg.providers, [name]: { ...cfg.providers[name], apiKey: p.apiKey } };
            uiKeys.add(name);
          }
          continue;
        }
        cfg.providers = { ...cfg.providers, [name]: p };
        uiProviders.add(name);
      }
    } catch (error) {
      console.warn(tr("{file} illisible, ignoré :", { file: localFile }), error instanceof Error ? error.message : error);
    }
  }
  current = cfg;
  return cfg;
}

/** Noms de variables valides et distincts ; apiKey peut être vide. */
export function validateServerEnv(env: Partial<ServerEnvNames>): asserts env is ServerEnvNames {
  const roles = ["baseUrl", "apiKey", "model", "port"] as const;
  for (const r of roles) {
    const v = env[r] ?? "";
    if (!v && r !== "apiKey") throw new Error(tr("server.env.{role} : nom de variable obligatoire", { role: r }));
    if (v && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) throw new Error(tr("server.env.{role} : « {value} » n'est pas un nom de variable valide (lettres, chiffres, _)", { role: r, value: v }));
  }
  const used = roles.map((r) => env[r]).filter(Boolean);
  if (new Set(used).size !== used.length) throw new Error(tr("server.env : une même variable ne peut pas servir à deux rôles"));
}

/**
 * Change les noms de variables du bench serveur : en mémoire (effet immédiat) et dans le fichier de
 * config (bloc `env: { … }` de la section `server`, créé s'il manque).
 */
export function saveServerEnv(env: Partial<ServerEnvNames>) {
  const cfg = config();
  if (!cfg.server) throw new Error(tr("pas de section « server » dans la config"));
  const names = { baseUrl: String(env.baseUrl ?? "").trim(), apiKey: String(env.apiKey ?? "").trim(), model: String(env.model ?? "").trim(), port: String(env.port ?? "").trim() };
  validateServerEnv(names);

  const text = readFileSync(cfg.file, "utf8");
  const server = text.search(/^\s*server\s*:\s*\{/m);
  if (server < 0) throw new Error(tr("section « server: { » introuvable dans {file} : modifier server.env à la main", { file: cfg.file }));
  const open = text.indexOf("{", server);
  const indent = (text.slice(text.lastIndexOf("\n", server) + 1).match(/^\s*/)?.[0] ?? "") + "  ";
  const block = (i: string) =>
    `env: {\n${(["baseUrl", "apiKey", "model", "port"] as const).map((k) => `${i}  ${k}: ${JSON.stringify(names[k])},`).join("\n")}\n${i}}`;
  // Fin de la section server : accolade fermante correspondante.
  let depth = 0, close = -1;
  for (let i = open; i < text.length && close < 0; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) close = i;
  }
  const m = /\benv\s*:\s*\{[^{}]*\}/.exec(text.slice(open, close));
  const inline = `env: { ${(["baseUrl", "apiKey", "model", "port"] as const).map((k) => `${k}: ${JSON.stringify(names[k])}`).join(", ")} }`;
  const next = m
    ? text.slice(0, open + m.index) + (m[0].includes("\n") ? block(indent) : inline) + text.slice(open + m.index + m[0].length)
    : text.slice(0, open + 1) + `\n${indent}${block(indent)},` + text.slice(open + 1);
  writeFileSync(cfg.file, next);
  cfg.server = { ...cfg.server, env: names };
  return names;
}

/** Fournisseurs ajoutés depuis l'interface, enregistrés dans <dataDir>/providers.local.json (clés comprises : à ignorer dans git). */
export const LOCAL_PROVIDERS_FILE = "providers.local.json";
export const uiProviders = new Set<string>();
/** Fournisseurs de la config dont la clé a été saisie dans l'interface, et leur clé d'origine. */
export const uiKeys = new Set<string>();
export const configKeys = new Map<string, string | undefined>();
