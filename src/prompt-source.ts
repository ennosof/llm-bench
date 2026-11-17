/**
 * Prompt système du bench prompt : détection dans le projet, résolution et enregistrement dans la config.
 *
 * Formes acceptées dans `prompt.system` (et `prompt.version`) :
 *   - un texte, ou une fonction qui le renvoie ;
 *   - { module: "../src/prompts/index.ts", export: "SYSTEM_PROMPT" } : export d'un module du projet,
 *     évalué dans un processus à part à chaque campagne (le code à jour, effets de bord isolés) ;
 *   - { file: "./system-prompt.md" } : fichier texte (system uniquement).
 * Chemins relatifs au fichier de config. Sans version, une empreinte du texte en tient lieu.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tr } from "./i18n.js";
import { config, type FileRef, type ModuleRef, type PromptBenchConfig, type PromptSource, type VersionSource } from "./config.js";

const isModuleRef = (v: unknown): v is ModuleRef => !!v && typeof v === "object" && "module" in v && "export" in v;
const isFileRef = (v: unknown): v is FileRef => !!v && typeof v === "object" && "file" in v;
const fromConfig = (p: string) => (isAbsolute(p) ? p : resolve(config().dir, p));
const toConfig = (abs: string) => {
  const r = relative(config().dir, abs).split(sep).join("/");
  if (r.startsWith("../../../")) return abs.split(sep).join("/"); // projet éloigné de la config : chemin absolu
  return r.startsWith(".") ? r : `./${r}`;
};

/** Racine du projet testé : source du bench serveur, sinon le parent d'un dossier « bench ». */
export function projectRoot() {
  const cfg = config();
  if (cfg.server?.source) return cfg.server.source;
  return basename(cfg.dir) === "bench" ? dirname(cfg.dir) : cfg.dir;
}

// =================================================================================================
// Évaluation des exports (processus à part)
// =================================================================================================

const EVAL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "prompt-eval.mjs");
const MARKER = "@@llm-bench-prompt-eval@@";

type EvalResult = { ok: true; text: string } | { ok: false; error: string };

/** Évalue des exports du projet ; chemins absolus. */
export function evalExports(items: ModuleRef[], timeoutMs = 20_000): Promise<EvalResult[]> {
  if (!items.length) return Promise.resolve([]);
  const tsx = import.meta.resolve("tsx/esm");
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", tsx, EVAL_SCRIPT, JSON.stringify(items)], {
      cwd: projectRoot(),
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      const i = out.lastIndexOf(MARKER);
      if (i >= 0) {
        try {
          return done(JSON.parse(out.slice(i + MARKER.length)));
        } catch {
          // sortie tronquée : traitée comme une erreur ci-dessous
        }
      }
      const why = err.trim().split("\n").filter(Boolean).slice(-3).join(" ") || tr("pas de réponse en {s} s", { s: timeoutMs / 1000 });
      done(items.map(() => ({ ok: false, error: tr("évaluation impossible : {why}", { why }) })));
    });
  });
}

async function evalOne(ref: ModuleRef) {
  const [r] = await evalExports([{ module: fromConfig(ref.module), export: ref.export }]);
  if (!r.ok) throw new Error(`${ref.module} → ${ref.export} : ${r.error}`);
  return r.text;
}

// =================================================================================================
// Résolution
// =================================================================================================

export async function resolveSystem(p: PromptBenchConfig): Promise<string> {
  const s = p.system as PromptSource;
  if (typeof s === "string") return s;
  if (typeof s === "function") return await s();
  if (isModuleRef(s)) return evalOne(s);
  if (isFileRef(s)) return readFileSync(fromConfig(s.file), "utf8");
  throw new Error(tr("prompt.system : texte, fonction, { module, export } ou { file } attendu"));
}

/** Version du prompt : celle de la config, sinon une empreinte du texte. */
export async function resolveVersion(p: PromptBenchConfig, text: string): Promise<string> {
  const v = p.version as VersionSource | undefined;
  try {
    if (typeof v === "string") return v;
    if (typeof v === "function") return String(await v());
    if (isModuleRef(v)) return (await evalOne(v)).trim();
  } catch {
    // version illisible : empreinte
  }
  return "#" + createHash("sha1").update(text).digest("hex").slice(0, 8);
}

/** Description lisible de la source, pour l'interface. */
export function describeSource(p: PromptBenchConfig | undefined) {
  const s = p?.system as PromptSource | undefined;
  const v = p?.version as VersionSource | undefined;
  const version = typeof v === "string" ? { kind: "text", value: v } : isModuleRef(v) ? { kind: "module", module: v.module, export: v.export } : v ? { kind: "code" } : null;
  if (s === undefined) return null;
  if (typeof s === "string") return { kind: "text", version };
  if (typeof s === "function") return { kind: "code", version };
  if (isModuleRef(s)) return { kind: "module", module: s.module, export: s.export, version };
  if (isFileRef(s)) return { kind: "file", file: s.file, version };
  return null;
}

// =================================================================================================
// Détection
// =================================================================================================

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".venv", "venv", "__pycache__", "__tests__", "bench", ".instances"]);
const CODE = /\.(m?[jt]sx?|cjs|cts)$/;
const IDENT = "[A-Za-z_$][\\w$]*";

function walk(root: string, accept: (rel: string) => boolean, maxDepth = 8): string[] {
  const out: string[] = [];
  const go = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) go(p, depth + 1);
      else if (st.size < 400_000 && !/\.(test|spec)\.|\.d\.ts$/.test(e) && accept(relative(root, p))) out.push(p);
    }
  };
  go(root, 0);
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Fichier importé par un chemin relatif ("./x", "./x.js" en ESM TypeScript, "./dir" → index). */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const noJs = base.replace(/\.(m?js|cjs)$/, "");
  const tries = [base, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].flatMap((x) => [noJs + x]), ...["index.ts", "index.js", "index.mjs"].map((x) => join(base, x))];
  return tries.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
}

/** Nom local → { fichier, export } pour les imports nommés et par défaut d'un fichier. */
function importsOf(file: string, text: string) {
  const map = new Map<string, { file: string; export: string }>();
  for (const m of text.matchAll(/import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveImport(file, m[3]);
    if (!target) continue;
    if (m[1]) map.set(m[1], { file: target, export: "default" });
    for (const part of (m[2] ?? "").split(",")) {
      const [orig, alias] = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/).map((x) => x.trim());
      if (orig) map.set(alias || orig, { file: target, export: orig });
    }
  }
  return map;
}

const exportedIn = (text: string, name: string) =>
  new RegExp(`export\\s+(?:const|let|var|(?:async\\s+)?function)\\s+${name.replace(/\$/g, "\\$")}\\b`).test(text) ||
  new RegExp(`export\\s*\\{[^}]*\\b${name.replace(/\$/g, "\\$")}\\b[^}]*\\}`).test(text);

const USAGES: Array<[RegExp, string]> = [
  [new RegExp(`new\\s+SystemMessage\\(\\s*(?:\`\\$\\{\\s*)?(${IDENT})`, "g"), "new SystemMessage(…)"],
  [new RegExp(`SystemMessagePromptTemplate\\.fromTemplate\\(\\s*(${IDENT})`, "g"), "SystemMessagePromptTemplate"],
  [new RegExp(`role\\s*:\\s*["'](?:system|developer)["']\\s*,\\s*content\\s*:\\s*(?:\`\\$\\{\\s*)?(${IDENT})`, "g"), 'role: "system"'],
  [new RegExp(`content\\s*:\\s*(${IDENT})\\s*,\\s*role\\s*:\\s*["'](?:system|developer)["']`, "g"), 'role: "system"'],
  [new RegExp(`\\[\\s*["']system["']\\s*,\\s*(${IDENT})\\s*\\]`, "g"), '["system", …]'],
  [new RegExp(`\\b(?:system|systemPrompt|systemInstruction|instructions)\\s*:\\s*(${IDENT})\\s*[,}\\n]`, "g"), "system: …"],
];
const NOT_IDENT = new Set(["true", "false", "null", "undefined", "this", "string", "any"]);
const PROMPT_NAME = /system.?prompt|SYSTEM_?PROMPT|SystemPrompt/;

export interface PromptCandidate {
  id: string;
  kind: "module" | "file";
  /** Chemins relatifs à la racine du projet (affichage) et à la config (enregistrement). */
  file: string;
  configPath: string;
  export?: string;
  line?: number;
  score: number;
  reasons: string[];
  usages: Array<{ file: string; line: number; how: string }>;
  version?: { configPath: string; file: string; export: string; value: string } | null;
  ok?: boolean;
  error?: string;
  length?: number;
  text?: string;
}

/** Export de version voisin (même dossier ou parent) : PROMPT_VERSION, SYSTEM_PROMPT_VERSION… */
function findVersion(file: string, root: string): PromptCandidate["version"] {
  for (const dir of [dirname(file), dirname(dirname(file))]) {
    if (!dir.startsWith(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((e) => CODE.test(e) && !/\.(test|spec)\.|\.d\.ts$/.test(e));
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => Number(/version/i.test(b)) - Number(/version/i.test(a)))) {
      const p = join(dir, e);
      const m = readFileSync(p, "utf8").match(/export\s+const\s+([A-Z_]*PROMPT[A-Z_]*VERSION|PROMPT_?VERSION|promptVersion)\s*=\s*["'`]([^"'`\n]+)["'`]/);
      if (m) return { file: relative(root, p), configPath: toConfig(p), export: m[1], value: m[2] };
    }
  }
  return null;
}

export async function detectPrompts(): Promise<PromptCandidate[]> {
  const root = projectRoot();
  const byKey = new Map<string, PromptCandidate>();
  const add = (abs: string, exp: string | undefined, score: number, reason: string, extra: Partial<PromptCandidate> = {}) => {
    const key = `${abs}#${exp ?? ""}`;
    const c = byKey.get(key) ?? {
      id: createHash("sha1").update(key).digest("hex").slice(0, 10),
      kind: exp ? "module" : "file",
      file: relative(root, abs),
      configPath: toConfig(abs),
      ...(exp ? { export: exp } : {}),
      score: 0,
      reasons: [],
      usages: [],
    } as PromptCandidate;
    c.score += score;
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
    if (extra.line && !c.line) c.line = extra.line;
    c.usages.push(...(extra.usages ?? []));
    byKey.set(key, c);
  };

  const sources = walk(root, (rel) => CODE.test(rel));
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    // 1. Points d'usage : l'identifiant passé comme message système, remonté jusqu'à son export.
    let imports: ReturnType<typeof importsOf> | null = null;
    for (const [re, how] of USAGES) {
      for (const m of text.matchAll(re)) {
        const name = m[1];
        if (NOT_IDENT.has(name)) continue;
        imports ??= importsOf(file, text);
        const target = imports.get(name) ?? (exportedIn(text, name) ? { file, export: name } : null);
        if (!target) continue;
        const strong = how !== "system: …" || PROMPT_NAME.test(name);
        add(target.file, target.export, strong ? 60 : 15, tr("utilisé comme message système"), {
          usages: [{ file: relative(root, file), line: lineOf(text, m.index!), how }],
        });
      }
    }
    // 2. Exports nommés comme un prompt système.
    for (const m of text.matchAll(new RegExp(`export\\s+(?:const|let|var|(?:async\\s+)?function)\\s+(${IDENT})`, "g"))) {
      if (PROMPT_NAME.test(m[1])) add(file, m[1], 30, tr("nom d'export de prompt système"), { line: lineOf(text, m.index!) });
    }
  }
  // Ligne de l'export pour les candidats trouvés par leur usage.
  for (const c of byKey.values()) {
    if (c.kind !== "module" || c.line) continue;
    const text = readFileSync(join(root, c.file), "utf8");
    const m = text.match(new RegExp(`export\\s+(?:const|let|var|(?:async\\s+)?function)\\s+${c.export!.replace(/\$/g, "\\$")}\\b`));
    if (m) c.line = lineOf(text, m.index!);
  }
  // 3. Fichiers texte de prompt.
  for (const file of walk(root, (rel) => /\.(md|txt)$/i.test(rel) && /prompt|system/i.test(rel) && !/readme|changelog|license/i.test(basename(rel)), 5)) {
    add(file, undefined, /system/i.test(basename(file)) ? 25 : 15, tr("fichier texte de prompt"));
  }

  const candidates = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  // Usages : messages système explicites d'abord, code applicatif (src/…) avant scripts et outils.
  const weight = (u: PromptCandidate["usages"][number]) => (u.how === "system: …" ? 2 : 0) + (/^(src|app|lib|server)\//.test(u.file) ? 0 : 1);
  for (const c of candidates) c.usages.sort((a, b) => weight(a) - weight(b));
  for (const c of candidates) {
    if (c.kind !== "module") continue;
    c.version = findVersion(join(root, c.file), root);
    if (c.version) c.reasons.push(`version ${c.version.export} = ${c.version.value}`);
  }

  // 4. Vérification : les exports sont évalués, les fichiers lus.
  const modules = candidates.filter((c) => c.kind === "module");
  const results = await evalExports(modules.map((c) => ({ module: join(root, c.file), export: c.export! })));
  modules.forEach((c, i) => {
    const r = results[i];
    if (r.ok) Object.assign(c, { ok: true, text: r.text, length: r.text.length });
    else Object.assign(c, { ok: false, error: r.error });
  });
  for (const c of candidates.filter((x) => x.kind === "file")) {
    const text = readFileSync(join(root, c.file), "utf8");
    Object.assign(c, { ok: true, text, length: text.length });
  }
  for (const c of candidates) {
    if (!c.ok) c.score -= 100;
    else if ((c.length ?? 0) >= 200) c.score += 10;
  }
  return candidates.sort((a, b) => b.score - a.score);
}

// =================================================================================================
// Enregistrement dans la config
// =================================================================================================

export type PromptChoice =
  | { kind: "module"; module: string; export: string; version?: { module: string; export: string } | null }
  | { kind: "file"; file: string }
  | { kind: "text"; text: string };

/** Indice après une chaîne ou un commentaire commençant en i, sinon i. */
function skip(text: string, i: number) {
  const ch = text[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
    return i + 1;
  }
  if (ch === "/" && text[i + 1] === "/") {
    const n = text.indexOf("\n", i);
    return n < 0 ? text.length : n;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const n = text.indexOf("*/", i + 2);
    return n < 0 ? text.length : n + 2;
  }
  return i;
}

/** Fin d'une valeur de propriété : virgule ou accolade fermante au niveau 0 (chaînes ignorées). */
function valueEnd(text: string, from: number) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const j = skip(text, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const ch = text[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) {
      if (depth === 0) return i;
      depth--;
    } else if (ch === "," && depth === 0) return i + 1;
  }
  return text.length;
}

/** Remplace (ou ajoute, ou retire si value null) une propriété du premier niveau d'un objet { … }. */
function setProp(text: string, open: number, close: number, indent: string, key: string, value: string | null) {
  // Propriété au premier niveau de l'objet, hors chaînes et commentaires.
  let depth = 0, start = -1;
  const keyRe = new RegExp(`^${key}\\s*:`);
  for (let i = open + 1; i < close && start < 0; i++) {
    const j = skip(text, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const ch = text[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    else if (depth === 0 && /[\s{,]/.test(text[i - 1]) && keyRe.test(text.slice(i, i + key.length + 20))) start = i;
  }
  if (start >= 0) {
    let end = valueEnd(text, text.indexOf(":", start) + 1);
    if (value === null) {
      const lineStart = text.lastIndexOf("\n", start) + 1;
      const s = /^\s*$/.test(text.slice(lineStart, start)) ? lineStart : start;
      if (text[end] === "\n") end++;
      return text.slice(0, s) + text.slice(end);
    }
    const trailing = text[end - 1] === "," ? "," : "";
    return text.slice(0, start) + `${key}: ${value}${trailing}` + text.slice(end);
  }
  if (value === null) return text;
  return text.slice(0, open + 1) + `\n${indent}${key}: ${value},` + text.slice(open + 1);
}

function matchingBrace(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const j = skip(text, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

const ref = (r: object) => `{ ${Object.entries(r).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }`;

/** Enregistre la source du prompt dans la config (section prompt créée si besoin) et l'applique aussitôt. */
export function savePromptSource(choice: PromptChoice) {
  const cfg = config();
  const root = projectRoot();
  let system: ModuleRef | FileRef;
  let version: ModuleRef | null = null;
  if (choice.kind === "module") {
    const abs = resolve(root, choice.module);
    if (!existsSync(abs)) throw new Error(tr("fichier introuvable : {file}", { file: choice.module }));
    if (!/^[A-Za-z_$][\w$]*$/.test(choice.export ?? "")) throw new Error(tr("nom d'export invalide"));
    system = { module: toConfig(abs), export: choice.export };
    if (choice.version?.module && choice.version.export) version = { module: toConfig(resolve(root, choice.version.module)), export: choice.version.export };
  } else if (choice.kind === "file") {
    const abs = resolve(root, choice.file);
    if (!existsSync(abs)) throw new Error(tr("fichier introuvable : {file}", { file: choice.file }));
    system = { file: toConfig(abs) };
  } else {
    if (!String(choice.text ?? "").trim()) throw new Error(tr("prompt vide"));
    const abs = join(cfg.dir, "system-prompt.md");
    writeFileSync(abs, choice.text.endsWith("\n") ? choice.text : choice.text + "\n");
    system = { file: toConfig(abs) };
  }

  let text = readFileSync(cfg.file, "utf8");
  const found = /^([ \t]*)prompt\s*:\s*\{/m.exec(text);
  if (found) {
    const open = found.index + found[0].length - 1;
    const indent = found[1] + "  ";
    text = setProp(text, open, matchingBrace(text, open), indent, "version", version ? ref(version) : null);
    text = setProp(text, open, matchingBrace(text, open), indent, "system", ref(system));
  } else {
    const anchor = /^([ \t]*)(?:server|gateway)\s*:\s*\{/m.exec(text);
    const indent = anchor?.[1] ?? "  ";
    const block = [
      `${indent}// ${tr("Bench prompt : prompt système défini depuis l'interface (menu Bench prompt → Prompt système).")}`,
      `${indent}prompt: {`,
      `${indent}  system: ${ref(system)},`,
      ...(version ? [`${indent}  version: ${ref(version)},`] : []),
      `${indent}},`,
      "",
    ].join("\n");
    if (anchor) {
      // Au-dessus des commentaires qui précèdent la section voisine.
      let at = anchor.index;
      for (;;) {
        const prev = text.lastIndexOf("\n", at - 2) + 1;
        if (at === 0 || !/^\s*\/\//.test(text.slice(prev, at))) break;
        at = prev;
      }
      text = text.slice(0, at) + block + "\n" + text.slice(at);
    }
    else {
      const end = text.lastIndexOf("}");
      if (end < 0) throw new Error(tr("structure de {file} non reconnue : ajouter la section prompt à la main", { file: cfg.file }));
      text = text.slice(0, end) + "\n" + block + text.slice(end);
    }
  }
  writeFileSync(cfg.file, text);

  const { version: _, ...rest } = cfg.prompt ?? ({} as PromptBenchConfig);
  cfg.prompt = { ...rest, system: system as any, ...(version ? { version: version as any } : {}) };
  return describeSource(cfg.prompt);
}
