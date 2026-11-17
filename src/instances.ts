/**
 * Serveurs du bench : chaque serveur est une copie du projet testé dans <instancesDir>/<id>, avec
 * son propre fichier d'environnement (modèle, port), ses dépendances et son build.
 *
 * Cycle de vie (commandes de la config) : copie des sources → install → build → start, prêt quand
 * le chemin de santé répond.
 *
 * Appels LLM : un serveur lancé par le bench appelle son modèle à travers le bench
 * (variable baseUrl = http://127.0.0.1:<port>/llm/<id>), qui relaie vers le vrai fournisseur et
 * enregistre chaque requête / réponse. Le fichier d'environnement de la copie garde le vrai
 * endpoint : la copie reste utilisable seule.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync, cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";
import { config, type ServerEnvNames, type ServerTargetConfig } from "./config.js";
import { parseModelKey, provider, tierOf, unavailable, type ModelRef } from "./providers.js";
import { tr } from "./i18n.js";

const META_FILE = "bench-instance.json";
const LOG_FILE = "bench-instance.log";

/** Jamais copiés : dépendances, builds, git, et les données du bench lui-même. */
const ALWAYS_EXCLUDED = new Set(["node_modules", ".git", ".DS_Store"]);

function target(): ServerTargetConfig & { source: string; instancesDir: string; env: ServerEnvNames } {
  const s = config().server;
  if (!s) throw new Error(tr("pas de bench serveur : section « server » absente de la config"));
  return s as ServerTargetConfig & { source: string; instancesDir: string; env: ServerEnvNames };
}

export const instancesDir = () => target().instancesDir;

// =================================================================================================
// Fichier d'environnement
// =================================================================================================

/** Valeurs actives (non commentées) d'un fichier .env. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** Commente les lignes actives des clés données, puis les ajoute avec leur nouvelle valeur. */
function overrideEnv(text: string, values: Record<string, string>) {
  const keys = Object.keys(values);
  const lines = text.split("\n").map((line) => {
    const key = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/i)?.[1];
    return key && keys.includes(key) ? `# ${line}` : line;
  });
  return [...lines, "", tr("# ---- llm-bench (généré) ----"), ...keys.map((k) => `${k}=${values[k]}`), ""].join("\n");
}

const envFileName = () => target().envFile ?? ".env";

function sourceEnv() {
  const p = join(target().source, envFileName());
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Endpoint, modèle et clé du .env du projet (variables de server.env), pour pré-remplir un fournisseur. */
export function projectLlmEnv() {
  if (!config().server) return null;
  const names = target().env;
  const env = parseEnv(sourceEnv());
  return {
    file: envFileName(),
    names,
    baseUrl: env[names.baseUrl] || null,
    model: env[names.model] || null,
    apiKey: (names.apiKey && env[names.apiKey]) || null,
  };
}

/** Variables qui donnent au serveur son modèle (valeurs réelles, pour un usage hors bench). */
function modelEnv(ref: ModelRef, port?: number): Record<string, string> {
  const names = target().env;
  const p = provider(ref.provider);
  const why = unavailable(ref.provider);
  if (why) throw new Error(tr("{provider} : {reason}", { provider: ref.provider, reason: why }));
  return {
    [names.baseUrl]: p.baseUrl!,
    ...(names.apiKey ? { [names.apiKey]: p.apiKey ?? (p.kind === "ollama" ? "ollama" : "none") } : {}),
    [names.model]: ref.model,
    ...(port ? { [names.port]: String(port) } : {}),
  };
}

// =================================================================================================
// Instances
// =================================================================================================

export type Phase = "copying" | "installing" | "building" | "starting" | "running" | "stopped" | "failed";

export interface Instance {
  id: string;
  name: string;
  provider: string;
  model: string;
  port: number;
  createdAt: string;
  updatedAt: string; // dernière copie des sources
  sourceCommit?: string;
  linkedModules: boolean; // dossiers partagés par lien (shareDirs)
  phase: Phase;
  error?: string;
  pid?: number;
  endpoint?: string; // ancien format : endpoint réel
}

const children = new Map<string, ChildProcess>();
const busy = new Set<string>(); // installation / build en cours
let proxyBase = ""; // http://127.0.0.1:<port du bench>

/** Fait passer les appels LLM des serveurs lancés ensuite par le proxy d'enregistrement du bench. */
export function setLlmProxyBase(base: string) {
  proxyBase = base.replace(/\/+$/, "");
}

const instanceDir = (id: string) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(id)) throw new Error(tr("id de serveur invalide"));
  return join(instancesDir(), id);
};

function saveMeta(i: Instance) {
  writeFileSync(join(instanceDir(i.id), META_FILE), JSON.stringify(i, null, 2));
}

function loadMeta(id: string): Instance {
  return JSON.parse(readFileSync(join(instanceDir(id), META_FILE), "utf8"));
}

function update(id: string, patch: Partial<Instance>) {
  const i = { ...loadMeta(id), ...patch };
  saveMeta(i);
  return i;
}

// =================================================================================================
// Windows : cmd.exe ne remplace pas $VAR, pas de groupes de processus, liens de dossier en jonction.
// =================================================================================================

const WIN = process.platform === "win32";

/** Sous Windows, remplace $VAR et ${VAR} par leur valeur (cmd.exe ne le fait pas) : une même config sert partout. */
export function expandVars(command: string, env: Record<string, string | undefined>) {
  if (!WIN) return command;
  return command.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => env[a ?? b] ?? m);
}

/** Lien vers un dossier : jonction sous Windows (sans droits administrateur), lien symbolique ailleurs. */
const linkDir = (target: string, path: string) => symlinkSync(target, path, WIN ? "junction" : "dir");

/** Supprime un lien de dossier sans toucher à sa cible. */
function unlinkDir(path: string) {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path); // jonction Windows
  }
}

/** Chemin relatif avec des « / », quel que soit le système. */
const posix = (p: string) => p.split(sep).join("/");

const isAlive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Modèle d'un serveur, pour le relais des appels LLM. */
export function instanceTarget(id: string): ModelRef {
  const i = loadMeta(id);
  return { provider: i.provider, model: i.model };
}

export function listInstances(): Instance[] {
  if (!config().server || !existsSync(instancesDir())) return [];
  return readdirSync(instancesDir())
    .filter((d) => existsSync(join(instancesDir(), d, META_FILE)))
    .map((d) => {
      const i = loadMeta(d);
      // Processus disparu (bench redémarré, crash) ou étape interrompue.
      const transient = ["copying", "installing", "building"].includes(i.phase) && !busy.has(i.id);
      if (((i.phase === "running" || i.phase === "starting") && !children.has(i.id) && !isAlive(i.pid)) || transient) {
        return update(i.id, { phase: transient ? "failed" : "stopped", pid: undefined, ...(transient ? { error: tr("étape interrompue") } : {}) });
      }
      return i;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getInstance(id: string) {
  const i = listInstances().find((x) => x.id === id);
  if (!i) throw new Error(tr("serveur introuvable"));
  return i;
}

const maskKey = (v?: string) => (!v ? "" : v.length <= 12 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);

/** Tout ce qu'il faut savoir d'un serveur : fichiers, variables (fichier et valeurs au démarrage), URL, commandes. */
export function instanceDetails(id: string) {
  const i = getInstance(id);
  const t = target();
  const dir = instanceDir(id);
  const envPath = join(dir, envFileName());
  const fileEnv = parseEnv(existsSync(envPath) ? readFileSync(envPath, "utf8") : "");
  const names = t.env;
  const p = (() => {
    try {
      return provider(i.provider);
    } catch {
      return null;
    }
  })();
  const proxyUrl = proxyBase ? `${proxyBase}/llm/${id}` : null;
  const vars = [
    { role: "baseUrl", name: names.baseUrl, file: fileEnv[names.baseUrl] ?? "", atStart: proxyUrl ?? fileEnv[names.baseUrl] ?? "" },
    ...(names.apiKey ? [{ role: "apiKey", name: names.apiKey, file: maskKey(fileEnv[names.apiKey]), atStart: maskKey(fileEnv[names.apiKey]) }] : []),
    { role: "model", name: names.model, file: fileEnv[names.model] ?? "", atStart: fileEnv[names.model] ?? "" },
    { role: "port", name: names.port, file: fileEnv[names.port] ?? "", atStart: String(i.port) },
  ];
  const chat = t.chat;
  return {
    ...i,
    running: children.has(id) || isAlive(i.pid),
    dir,
    envFile: envPath,
    logFile: join(dir, LOG_FILE),
    metaFile: join(dir, META_FILE),
    source: t.source,
    provider: { name: i.provider, label: p?.label ?? i.provider, tier: tierOf(i.provider), baseUrl: p?.baseUrl ?? null },
    proxyUrl,
    appUrl: `http://localhost:${i.port}`,
    healthUrl: `http://localhost:${i.port}${t.health ?? "/health"}`,
    chat: `${chat?.method ?? "POST"} http://localhost:${i.port}${chat?.path ?? "/chat"}`,
    vars,
    commands: { install: i.linkedModules ? [] : t.install ?? [], build: t.build ?? [], start: t.start },
    shareDirs: i.linkedModules ? t.shareDirs ?? ["node_modules"] : [],
  };
}

export function readLog(id: string, maxLines = 400) {
  const p = join(instanceDir(id), LOG_FILE);
  if (!existsSync(p)) return "";
  // eslint-disable-next-line no-control-regex
  const lines = readFileSync(p, "utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  return lines.slice(-maxLines).join("\n");
}

function log(id: string, text: string) {
  writeFileSync(join(instanceDir(id), LOG_FILE), `\n[bench ${new Date().toLocaleTimeString("fr-FR")}] ${text}\n`, { flag: "a" });
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "srv";
}

async function portFree(port: number) {
  return new Promise<boolean>((done) => {
    const srv = createServer().once("error", () => done(false)).once("listening", () => srv.close(() => done(true)));
    srv.listen(port, "0.0.0.0");
  });
}

async function nextPort() {
  const first = Number(process.env.BENCH_SERVER_PORT ?? target().firstPort ?? 3101);
  const taken = new Set(listInstances().map((i) => i.port));
  for (let p = first; p < first + 200; p++) if (!taken.has(p) && (await portFree(p))) return p;
  throw new Error(tr("aucun port libre"));
}

/** Lance une commande shell dans le dossier du serveur, sortie ajoutée à son journal. */
function run(id: string, command: string) {
  const dir = instanceDir(id);
  log(id, `$ ${command}`);
  return new Promise<void>((ok, fail) => {
    const out = createWriteStream(join(dir, LOG_FILE), { flags: "a" });
    const env = { ...process.env, FORCE_COLOR: "0" };
    const p = spawn(expandVars(command, env), { cwd: dir, shell: true, env, windowsHide: true });
    p.stdout.pipe(out, { end: false });
    p.stderr.pipe(out, { end: false });
    p.on("error", (e) => { out.end(); fail(e); });
    p.on("close", (code) => { out.end(); code === 0 ? ok() : fail(new Error(`${command} → code ${code}`)); });
  });
}

function gitCommit() {
  return new Promise<string | undefined>((done) => {
    const p = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: target().source });
    let s = "";
    p.stdout.on("data", (d) => (s += d));
    p.on("error", () => done(undefined));
    p.on("close", () => done(s.trim() || undefined));
  });
}

const shareDirs = () => target().shareDirs ?? ["node_modules"];

/** Copie récursive filtrée (cpSync refuse une destination située dans la source, cas des copies dans le projet). */
function copyTree(src: string, dst: string, keep: (path: string) => boolean) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    if (!keep(from)) continue;
    const to = join(dst, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(from), to);
      } catch {
        cpSync(from, to, { recursive: true, dereference: true }); // Windows sans droit de créer des liens
      }
    }
    else if (entry.isDirectory()) copyTree(from, to, keep);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

/** Copie les sources de travail actuelles (modifications non commitées comprises) ; env et dossiers partagés préservés. */
function copySources(id: string) {
  const t = target();
  const dir = instanceDir(id);
  const keep = new Set([...shareDirs(), envFileName(), META_FILE, LOG_FILE]);
  for (const entry of readdirSync(dir)) {
    if (keep.has(entry)) continue;
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
  // Exclusions : config, dossier des copies et données du bench (s'ils sont dans le projet).
  const excluded = [
    ...(t.exclude ?? []),
    relative(t.source, t.instancesDir),
    ...["results", "results-servers", "gateway.json"].map((d) => relative(t.source, join(config().dataDir, d))),
  ].map(posix).filter((p) => p && !p.startsWith(".."));
  copyTree(t.source, dir, (src) => {
    const rel = posix(relative(t.source, src));
    if (rel.split("/").some((part) => ALWAYS_EXCLUDED.has(part))) return false;
    if (shareDirs().includes(rel)) return false;
    if (excluded.some((p) => rel === p || rel.startsWith(p + "/"))) return false;
    return rel !== envFileName();
  });
}

async function prepare(id: string, opts: { install: boolean }) {
  busy.add(id);
  try {
    const t = target();
    const i = loadMeta(id);
    update(id, { phase: "copying", error: undefined });
    log(id, tr("Copie des sources de {source}", { source: t.source }));
    copySources(id);
    update(id, { updatedAt: new Date().toISOString(), sourceCommit: await gitCommit() });

    const missing = shareDirs().filter((d) => !existsSync(join(instanceDir(id), d)));
    // Partage : lien vers les dossiers du projet. S'il en manque un dans le projet (dépendances jamais
    // installées), on installe dans la copie au lieu de démarrer sans dépendances.
    const linkable = i.linkedModules && missing.every((d) => existsSync(join(t.source, d)));
    if (i.linkedModules && !linkable) log(id, tr("Dossiers à partager absents du projet ({dirs}) : installation dans la copie", { dirs: missing.filter((d) => !existsSync(join(t.source, d))).join(", ") }));
    if (linkable) {
      for (const d of missing) linkDir(join(t.source, d), join(instanceDir(id), d));
    } else if (t.install?.length && (opts.install || missing.length)) {
      update(id, { phase: "installing" });
      for (const cmd of t.install) await run(id, cmd);
    }

    if (t.build?.length) {
      update(id, { phase: "building" });
      for (const cmd of t.build) await run(id, cmd);
    }
    busy.delete(id);
    await startInstance(id);
  } catch (error) {
    log(id, tr("ÉCHEC : {error}", { error: String(error) }));
    update(id, { phase: "failed", error: String(error instanceof Error ? error.message : error) });
  } finally {
    busy.delete(id);
  }
}

export async function createInstance(opts: { model: string; name?: string; linkModules?: boolean }) {
  const ref = parseModelKey(String(opts.model ?? "").trim());
  const env = modelEnv(ref); // vérifie le fournisseur avant de copier quoi que ce soit

  mkdirSync(instancesDir(), { recursive: true });
  const base = slug(opts.name?.trim() || `${ref.provider}-${ref.model}`);
  let id = base;
  for (let n = 2; existsSync(join(instancesDir(), id)); n++) id = `${base}-${n}`;
  const port = await nextPort();
  const now = new Date().toISOString();

  mkdirSync(instanceDir(id));
  const instance: Instance = {
    id,
    name: opts.name?.trim() || `${ref.model} (${ref.provider})`,
    provider: ref.provider,
    model: ref.model,
    port,
    createdAt: now,
    updatedAt: now,
    linkedModules: Boolean(opts.linkModules),
    phase: "copying",
  };
  saveMeta(instance);
  writeFileSync(join(instanceDir(id), envFileName()), overrideEnv(sourceEnv(), { ...env, [target().env.port]: String(port) }));
  log(id, tr("Création : {name} · port {port}", { name: instance.name, port }));

  void prepare(id, { install: true });
  return instance;
}

/** Recopie le code actuel du projet, rebuild et relance (l'environnement du serveur est conservé). */
export async function refreshInstance(id: string) {
  if (busy.has(id)) throw new Error(tr("une étape est déjà en cours"));
  await stopInstance(id);
  void prepare(id, { install: false });
  return loadMeta(id);
}

/** Réinstalle les dépendances (après un changement de package.json…). */
export async function reinstallInstance(id: string) {
  if (busy.has(id)) throw new Error(tr("une étape est déjà en cours"));
  await stopInstance(id);
  void prepare(id, { install: true });
  return loadMeta(id);
}

/** Change le modèle d'un serveur : environnement réécrit, redémarrage, sans recopie ni build. */
export async function changeInstanceModel(id: string, model: string) {
  if (busy.has(id)) throw new Error(tr("une étape est déjà en cours"));
  const ref = parseModelKey(String(model ?? "").trim());
  const i = loadMeta(id);
  const env = modelEnv(ref);
  const wasRunning = i.phase === "running";
  await stopInstance(id);
  const file = join(instanceDir(id), envFileName());
  writeFileSync(file, overrideEnv(existsSync(file) ? readFileSync(file, "utf8") : "", env));
  const renamed = i.name === `${i.model} (${i.provider})` ? `${ref.model} (${ref.provider})` : i.name;
  update(id, { provider: ref.provider, model: ref.model, name: renamed, endpoint: undefined });
  log(id, tr("Modèle : {model}", { model: `${ref.provider}/${ref.model}` }));
  return wasRunning ? startInstance(id) : loadMeta(id);
}

async function waitHealthy(port: number, child: ChildProcess) {
  const t = target();
  const timeoutMs = t.startTimeoutMs ?? 90_000;
  const path = t.health ?? "/health";
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(tr("le serveur s'est arrêté (code {code}) : voir le journal", { code: child.exitCode }));
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      // pas encore prêt
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(tr("le serveur ne répond pas sur {path} après {seconds} s", { path, seconds: Math.round(timeoutMs / 1000) }));
}

/** Arrête le groupe de processus du serveur (le serveur et ses sous-processus). */
function killGroup(pid: number, signal: NodeJS.Signals) {
  if (WIN) {
    // Pas de signaux sous Windows : taskkill arrête l'arbre de processus (/T), de force (/F).
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* déjà arrêté */ }
  }
}

export async function startInstance(id: string) {
  const t = target();
  const i = loadMeta(id);
  if (busy.has(id)) throw new Error(tr("une étape est déjà en cours"));
  if (children.has(id) || isAlive(i.pid)) return i;
  const dir = instanceDir(id);
  if (t.readyFile && !existsSync(join(dir, t.readyFile))) throw new Error(tr("{file} absent : utiliser « ↻ Code » pour reconstruire", { file: t.readyFile }));
  if (!(await portFree(i.port))) throw new Error(tr("le port {port} est déjà utilisé", { port: i.port }));

  // Le fichier d'environnement est relu au démarrage par le serveur, mais les variables déjà présentes
  // dans l'environnement gagnent souvent (dotenv) : on les force donc aussi ici.
  const fileEnv = parseEnv(existsSync(join(dir, envFileName())) ? readFileSync(join(dir, envFileName()), "utf8") : "");
  const names = t.env;
  const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const k of [names.baseUrl, names.apiKey, names.model, names.port]) if (k && fileEnv[k]) childEnv[k] = fileEnv[k];
  childEnv[names.port] = String(i.port);
  if (proxyBase) childEnv[names.baseUrl] = `${proxyBase}/llm/${id}`;

  update(id, { phase: "starting", error: undefined });
  log(id, tr("Démarrage : {command} (port {port})", { command: t.start, port: i.port }));
  const out = createWriteStream(join(dir, LOG_FILE), { flags: "a" });
  // Groupe de processus dédié : l'arrêt atteint aussi les sous-processus (serveur MCP…).
  // Windows : pas de groupe de processus (detached ouvrirait une console) ; l'arbre est arrêté par taskkill.
  const child = spawn(expandVars(t.start, childEnv), { cwd: dir, env: childEnv, shell: true, detached: !WIN, windowsHide: true });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  children.set(id, child);
  update(id, { pid: child.pid });

  child.on("exit", (code, signal) => {
    children.delete(id);
    log(id, tr("Processus terminé ({reason})", { reason: signal ?? `code ${code}` }));
    try {
      const cur = loadMeta(id);
      if (cur.pid === child.pid) update(id, { phase: cur.phase === "starting" || code ? "failed" : "stopped", pid: undefined, ...(code ? { error: tr("arrêt inattendu (code {code})", { code }) } : {}) });
    } catch {
      // dossier supprimé
    }
  });

  try {
    await waitHealthy(i.port, child);
    return update(id, { phase: "running" });
  } catch (error) {
    if (child.pid) killGroup(child.pid, "SIGKILL");
    return update(id, { phase: "failed", error: String(error instanceof Error ? error.message : error) });
  }
}

export async function stopInstance(id: string) {
  const i = loadMeta(id);
  const child = children.get(id);
  const pid = child?.pid ?? i.pid;
  if (pid && isAlive(pid)) {
    killGroup(pid, "SIGINT"); // arrêt propre
    for (let t = 0; t < 50 && isAlive(pid); t++) await new Promise((r) => setTimeout(r, 100));
    if (isAlive(pid)) killGroup(pid, "SIGKILL");
  }
  children.delete(id);
  return update(id, { phase: busy.has(id) ? i.phase : "stopped", pid: undefined });
}

export async function deleteInstance(id: string) {
  if (busy.has(id)) throw new Error(tr("une étape est en cours : attendre sa fin"));
  await stopInstance(id);
  const dir = instanceDir(id);
  // Dossiers partagés : supprimer le lien, jamais la cible.
  for (const d of shareDirs()) {
    const p = join(dir, d);
    try {
      if (lstatSync(p).isSymbolicLink()) unlinkDir(p);
    } catch {
      // absent
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/** À la fermeture du bench, on arrête les serveurs qu'il a lancés. */
export function stopAllSync() {
  for (const child of children.values()) if (child.pid) killGroup(child.pid, "SIGINT");
}
