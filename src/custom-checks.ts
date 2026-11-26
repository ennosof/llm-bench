/**
 * Vérifications spécifiques créées depuis l'interface (menu Configuration → Vérifications spécifiques).
 *
 * L'utilisateur décrit la règle par des choix simples (ce qu'on regarde, la condition, la valeur
 * attendue) ; elle est traduite en une vérification ordinaire (description, fields, label, test),
 * écrite dans `prompt.checks` ou `server.checks` de bench.config.ts. La description d'origine y est
 * gardée (`builder`) pour pouvoir rouvrir la règle dans l'interface.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { COMMON_CHECKS, helpers, serverBuiltinChecks } from "./checks.js";
import { matchingBrace, propValue, sectionRange, setProp } from "./config-edit.js";
import { config, loadConfig, type CheckSpec, type CheckType } from "./config.js";
import { tr } from "./i18n.js";
import { loadCases } from "./prompt-bench.js";
import { kinds, loadServerCases } from "./server-bench.js";

export type Bench = "prompt" | "server";

/** Conditions proposées pour chaque cible. */
export const OPS: Record<CheckSpec["target"], CheckSpec["op"][]> = {
  json: ["equals", "notEquals", "contains", "notContains", "anyWord", "noWord", "oneOf", "exists", "absent", "gte", "lte"],
  text: ["contains", "notContains", "anyWord", "noWord", "equals"],
  count: ["gte", "lte", "equals"],
};
const NO_VALUE = ["exists", "absent"];
const NUMERIC = ["gte", "lte"];
const LISTS = ["anyWord", "noWord", "oneOf"];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Libellé court de la condition, repris dans le libellé du résultat. */
const opSymbol = (op: CheckSpec["op"]) => ({
  equals: "=", notEquals: "≠", contains: "∋", notContains: "∌", anyWord: "∋", noWord: "∌", oneOf: "∈", exists: tr("présent"), absent: tr("absent"), gte: "≥", lte: "≤",
})[op];

const js = (v: unknown) => JSON.stringify(v);

/** Contrôle et normalise une règle reçue de l'interface. */
export function normalizeSpec(raw: any, bench: Bench): CheckSpec {
  const target = (["json", "text", "count"] as const).includes(raw?.target) ? raw.target : "json";
  const op = OPS[target as CheckSpec["target"]].includes(raw?.op) ? raw.op : OPS[target as CheckSpec["target"]][0];
  const spec: CheckSpec = {
    description: String(raw?.description ?? "").trim(),
    target,
    path: target === "text" ? "" : String(raw?.path ?? "").trim(),
    op,
    gate: Boolean(raw?.gate),
    expected: NO_VALUE.includes(op) ? "none" : raw?.expected === "case" ? "case" : "fixed",
    value: String(raw?.value ?? ""),
    input: raw?.input === "select" && !NUMERIC.includes(op) && target !== "count" && !LISTS.includes(op) ? "select" : "text",
    options: String(raw?.options ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    fieldLabel: String(raw?.fieldLabel ?? "").trim(),
  };
  if (!spec.description) throw new Error(tr("donner un nom à la vérification"));
  if (target !== "text" && !spec.path) throw new Error(tr("indiquer le chemin du champ dans la réponse JSON"));
  if (spec.path && !/^[\w$-]+(\.[\w$-]+)*$/.test(spec.path)) throw new Error(tr("chemin invalide : des noms séparés par des points, ex. data.books.0.title"));
  if (spec.expected === "case" && spec.input === "select" && !spec.options.length) throw new Error(tr("indiquer les choix proposés, séparés par des virgules"));
  if (spec.expected === "fixed" && !spec.value.trim()) throw new Error(tr("indiquer la valeur attendue"));
  if (spec.expected === "fixed" && (NUMERIC.includes(op) || target === "count") && !Number.isFinite(Number(spec.value))) throw new Error(tr("la valeur attendue doit être un nombre"));
  if (bench === "server" && !config().server) throw new Error(tr("pas de section « server » dans la config"));
  if (bench === "prompt" && !config().prompt) throw new Error(tr("pas de section « prompt » dans la config"));
  return spec;
}

/** Code JavaScript de la vérification (objet littéral), indenté à partir de `indent`. */
export function checkCode(spec: CheckSpec, indent = ""): string {
  const i1 = indent + "  ", i2 = indent + "    ";
  const what = spec.target === "text" ? tr("texte") : spec.target === "count" ? `${spec.path} (${tr("nombre")})` : spec.path;
  const numeric = spec.target === "count" || NUMERIC.includes(spec.op);
  const fieldLabel = spec.fieldLabel || (LISTS.includes(spec.op) ? tr("Valeurs (séparées par des virgules)") : numeric ? tr("Nombre") : tr("Valeur attendue"));

  const fields: string[] = [];
  if (spec.expected === "case") {
    const f: Record<string, unknown> = { name: "value", label: fieldLabel, kind: numeric ? "number" : spec.input === "select" ? "select" : "text" };
    if (f.kind === "select") f.options = spec.options;
    if (LISTS.includes(spec.op)) f.placeholder = "a, b, c";
    fields.push(`{ ${Object.entries(f).map(([k, v]) => `${k}: ${js(v)}`).join(", ")} }`);
  }
  const V = spec.expected === "case" ? "c.value" : js(spec.value);
  const labelValue = spec.expected === "none" ? "" : spec.expected === "case" ? ` + " " + c.value` : ` + ${js(" " + spec.value)}`;

  // Valeur regardée dans la réponse.
  const read =
    spec.target === "text" ? "const v = s.text;"
    : spec.target === "count" ? `const list = h.get(s.json, ${js(spec.path)});\n${i2}const v = Array.isArray(list) ? list.length : 0;`
    : `const v = h.get(s.json, ${js(spec.path)});`;
  const t = `h.lower(v !== null && typeof v === "object" ? JSON.stringify(v) : v).trim()`;
  const cond: Record<CheckSpec["op"], string> = {
    equals: numeric ? `return Number(v) === Number(${V});` : `return ${t} === h.lower(${V}).trim();`,
    notEquals: `return ${t} !== h.lower(${V}).trim();`,
    contains: `return ${t}.includes(h.lower(${V}).trim());`,
    notContains: `return !${t}.includes(h.lower(${V}).trim());`,
    anyWord: `return h.list(${V}).some((w) => ${t}.includes(w));`,
    noWord: `return !h.list(${V}).some((w) => ${t}.includes(w));`,
    oneOf: `return h.list(${V}).includes(${t});`,
    exists: `return v !== undefined && v !== null && v !== "";`,
    absent: `return v === undefined || v === null || v === "";`,
    gte: `return Number(v) >= Number(${V});`,
    lte: `return Number(v) <= Number(${V});`,
  };
  return [
    "{",
    `${i1}description: ${js(spec.description)},`,
    ...(spec.gate ? [`${i1}gate: true,`] : []),
    `${i1}fields: [${fields.join(", ")}],`,
    `${i1}label: (c) => ${js(`${what} ${opSymbol(spec.op)}`)}${labelValue},`,
    `${i1}test: (s, c, h) => {`,
    `${i2}${read}`,
    `${i2}${cond[spec.op]}`,
    `${i1}},`,
    `${i1}builder: ${js(spec)},`,
    `${indent}}`,
  ].join("\n");
}

/** Vérification exécutable à partir de son code (aperçu, sans passer par le fichier). */
function compile(code: string): CheckType {
  return new Function(`return (${code});`)() as CheckType;
}

/** Aperçu : code généré et, si un exemple de réponse est fourni, résultat de la vérification sur cet exemple. */
export function previewCheck(raw: any, bench: Bench, sample?: string, value?: string) {
  const spec = normalizeSpec(raw, bench);
  const code = checkCode(spec);
  if (sample === undefined || sample === "") return { code, result: null };
  const text = String(sample);
  let json: any = null;
  try {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    json = JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text);
  } catch {
    json = null;
  }
  const check = compile(code);
  const c = { type: "preview", value: spec.expected === "case" ? value ?? "" : spec.value };
  try {
    const out = check.test({ json, text, latencyMs: 0, message: "" }, c, helpers);
    return { code, result: { pass: typeof out === "object" ? out.pass : Boolean(out), label: check.label(c), json: json !== null } };
  } catch (error) {
    return { code, result: { pass: false, label: check.label(c), json: json !== null, error: error instanceof Error ? error.message : String(error) } };
  }
}

const builtins = (bench: Bench) => Object.keys(bench === "server" ? { ...serverBuiltinChecks(kinds()), ...COMMON_CHECKS } : COMMON_CHECKS);

/** Nombre de cas qui utilisent chaque type de vérification. */
async function usage(bench: Bench) {
  const n: Record<string, number> = {};
  const count = (checks: { type: string }[] = []) => new Set(checks.map((c) => c.type)).forEach((t) => (n[t] = (n[t] ?? 0) + 1));
  try {
    if (bench === "prompt") (await loadCases()).forEach((c: any) => count(c.checks));
    else (await loadServerCases()).forEach((c: any) => count((c.steps ?? []).flatMap((s: any) => s.checks ?? [])));
  } catch {
    // cas illisibles : pas de comptage
  }
  return n;
}

/** Vérifications de chaque banc : intégrées, écrites à la main dans la config, créées depuis l'interface. */
export async function listCustomChecks() {
  const cfg = config();
  const benches: Bench[] = [...(cfg.prompt ? ["prompt" as const] : []), ...(cfg.server ? ["server" as const] : [])];
  return {
    configFile: cfg.file,
    ops: OPS,
    benches: await Promise.all(benches.map(async (bench) => {
      const used = await usage(bench);
      const own = (bench === "prompt" ? cfg.prompt?.checks : cfg.server?.checks) ?? {};
      return {
        bench,
        builtins: builtins(bench),
        checks: Object.entries(own).map(([name, t]) => ({
          name, description: t.description, gate: Boolean(t.gate), fields: t.fields ?? [], builder: t.builder ?? null, used: used[name] ?? 0,
        })),
      };
    })),
  };
}

/**
 * Écrit la vérification dans `<bench>.checks` de la config (objet créé s'il manque), remplace celle
 * du même nom, ou celle de `originalName` en cas de renommage. La config est rechargée aussitôt ; si
 * elle ne se charge plus, le fichier est remis dans son état précédent.
 */
export async function saveCustomCheck(bench: Bench, name: string, raw: any, originalName?: string) {
  const cfg = config();
  const spec = normalizeSpec(raw, bench);
  if (!IDENT.test(name)) throw new Error(tr("identifiant invalide : lettres, chiffres et _, sans espace ni accent, ne commence pas par un chiffre"));
  if (builtins(bench).includes(name)) throw new Error(tr("« {name} » est une vérification intégrée : choisir un autre identifiant", { name }));
  const own = (bench === "prompt" ? cfg.prompt?.checks : cfg.server?.checks) ?? {};
  if (name !== originalName && own[name]) throw new Error(tr("une vérification « {name} » existe déjà", { name }));
  if (originalName && own[originalName] && !own[originalName].builder) throw new Error(tr("« {name} » est écrite à la main dans la config : la modifier dans le fichier", { name: originalName }));

  return rewrite(bench, (text, checks) => {
    let t = text;
    if (originalName && originalName !== name) t = setProp(t, checks.open, matchingBrace(t, checks.open), checks.indent, originalName, null);
    return setProp(t, checks.open, matchingBrace(t, checks.open), checks.indent, name, checkCode(spec, checks.indent));
  });
}

/** Retire une vérification créée depuis l'interface. */
export async function deleteCustomCheck(bench: Bench, name: string) {
  const own = (bench === "prompt" ? config().prompt?.checks : config().server?.checks) ?? {};
  if (!own[name]) throw new Error(tr("vérification « {name} » introuvable", { name }));
  if (!own[name].builder) throw new Error(tr("« {name} » est écrite à la main dans la config : la retirer dans le fichier", { name }));
  return rewrite(bench, (text, checks) => setProp(text, checks.open, matchingBrace(text, checks.open), checks.indent, name, null));
}

async function rewrite(bench: Bench, edit: (text: string, checks: { open: number; indent: string }) => string) {
  const cfg = config();
  const before = readFileSync(cfg.file, "utf8");
  let text = before;
  let section = sectionRange(text, bench);
  if (!section || section.close < 0) throw new Error(tr("section « {name}: { » introuvable dans {file} : ajouter la vérification à la main", { name: bench, file: cfg.file }));
  let at = propValue(text, section.open, section.close, "checks");
  if (at < 0) {
    text = setProp(text, section.open, section.close, section.indent, "checks", `{\n${section.indent}}`);
    section = sectionRange(text, bench)!;
    at = propValue(text, section.open, section.close, "checks");
  }
  if (text[at] !== "{") throw new Error(tr("{name}.checks n'est pas un objet écrit dans le fichier : ajouter la vérification à la main", { name: bench }));
  text = edit(text, { open: at, indent: section.indent + "  " });
  writeFileSync(cfg.file, text);
  try {
    await loadConfig(cfg.file);
  } catch (error) {
    writeFileSync(cfg.file, before);
    await loadConfig(cfg.file).catch(() => {});
    throw new Error(tr("config illisible après modification, rien n'a été changé : {error}", { error: error instanceof Error ? error.message : String(error) }));
  }
  return listCustomChecks();
}
