/**
 * Vérifications déclaratives, éditables depuis l'interface.
 *
 * Les vérifications intégrées sont génériques (chemin JSON, texte, latence, type de réponse) ;
 * la config du projet ajoute les siennes (prompt.checks, server.checks).
 */
import { tr } from "./i18n.js";
import type { CheckDef, CheckHelpers, CheckSubject, CheckType, FieldDef } from "./config.js";
import { LANGUAGES, detectLanguage, proseOf, type Language } from "./lang.js";

/** Nom d'une langue dans la langue de l'outil. */
const languageName = (l: Language) => ({
  fr: tr("Français"), en: tr("Anglais"), es: tr("Espagnol"), de: tr("Allemand"), it: tr("Italien"), pt: tr("Portugais"), nl: tr("Néerlandais"),
  ar: tr("Arabe"), ru: tr("Russe"), zh: tr("Chinois"), ja: tr("Japonais"), ko: tr("Coréen"), he: tr("Hébreu"), el: tr("Grec"),
})[l];

// =================================================================================================
// Dates relatives
// =================================================================================================

const DAY = 86_400_000;
export const dayFromToday = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

const DATE_TOKEN = /\{\{\s*(?:J|D|today)\s*([+-]\s*\d+)?\s*\}\}/gi;

/** `{{J}}`, `{{J+7}}`, `{{today-1}}` → date ISO relative à aujourd'hui (UTC). */
export function resolveDates(text: string): string {
  return String(text ?? "").replace(DATE_TOKEN, (_, offset) => dayFromToday(Number((offset ?? "0").replace(/\s/g, ""))));
}

/** "J+1", "{{J+1}}", "today+1" ou "2026-12-24" → date ISO. */
export function dateValue(value: unknown): string {
  const s = String(value ?? "").trim();
  const m = s.match(/^\{?\{?\s*(?:J|D|today)\s*([+-]\s*\d+)?\s*\}?\}?$/i);
  return m ? dayFromToday(Number((m[1] ?? "0").replace(/\s/g, ""))) : s;
}

// =================================================================================================
// Aides passées aux vérifications
// =================================================================================================

const lower = (v: unknown) => String(v ?? "").toLowerCase();
const get = (obj: any, path: string) => String(path ?? "").split(".").filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const list = (v: unknown) => String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export const helpers: CheckHelpers = { date: dateValue, get, lower, list };

const str = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""));

// =================================================================================================
// Vérifications intégrées
// =================================================================================================

const PATH_OPS = ["equals", "contains", "includes", "exists", "absent", "matches", "gte", "lte"];

const pathCheck: CheckType = {
  get description() { return tr("Vérification libre sur un chemin du JSON"); },
  get fields(): FieldDef[] { return [
    { name: "path", label: tr("Chemin"), kind: "text", placeholder: "data.items.0.name" },
    { name: "op", label: tr("Opérateur"), kind: "select", options: PATH_OPS },
    { name: "value", label: tr("Valeur"), kind: "text", placeholder: tr("valeur, regex ou nombre") },
  ]; },
  label: (c) => `${c.path} ${c.op}${["exists", "absent"].includes(c.op) ? "" : ` ${c.value}`}`,
  test: (s, c) => {
    const v = get(s.json, c.path ?? "");
    switch (c.op) {
      case "exists": return v !== undefined && v !== null && v !== "";
      case "absent": return v === undefined || v === null || v === "";
      case "contains": return lower(str(v)).includes(lower(c.value));
      case "includes": return Array.isArray(v) && v.map(String).includes(String(c.value));
      case "matches": return new RegExp(String(c.value ?? ""), "i").test(str(v));
      case "gte": return Number(v) >= Number(c.value);
      case "lte": return Number(v) <= Number(c.value);
      default: return str(v) === String(c.value ?? "");
    }
  },
};

/** Vérifications disponibles dans les deux bancs. */
export const COMMON_CHECKS: Record<string, CheckType> = {
  path: pathCheck,
  textContains: {
    get description() { return tr("Le texte contient l'un des mots (séparés par des virgules)"); },
    get fields(): FieldDef[] { return [{ name: "value", label: tr("Mots"), kind: "text", placeholder: "paris, lyon" }]; },
    label: (c) => tr("texte ∋ {value}", { value: c.value }),
    test: (s, c) => list(c.value).some((w) => lower(s.text).includes(w)),
  },
  textExcludes: {
    get description() { return tr("Le texte ne contient aucun des mots (fuite d'informations…)"); },
    get fields(): FieldDef[] { return [{ name: "value", label: tr("Mots interdits"), kind: "text", placeholder: "api key, system prompt" }]; },
    label: (c) => tr("texte ∌ {value}", { value: c.value }),
    test: (s, c) => !list(c.value).some((w) => lower(s.text).includes(w)),
  },
  textEquals: {
    get description() { return tr("Texte strictement égal"); },
    get fields(): FieldDef[] { return [{ name: "value", label: tr("Texte"), kind: "text" }]; },
    label: (c) => tr("texte = {value}", { value: c.value }),
    test: (s, c) => s.text.trim() === String(c.value ?? "").trim(),
  },
  textMatches: {
    get description() { return tr("Le texte correspond à une expression régulière"); },
    get fields(): FieldDef[] { return [{ name: "value", label: tr("Regex"), kind: "text", placeholder: tr("^\\d+ résultats?") }]; },
    label: (c) => tr("texte ~ /{value}/", { value: c.value }),
    test: (s, c) => new RegExp(String(c.value ?? ""), "i").test(s.text),
  },
  prose: {
    get description() { return tr("Texte rédigé : non vide et pas un code (ex. empty_results)"); },
    fields: [],
    label: () => tr("texte rédigé"),
    test: (s) => s.text.trim().length > 0 && !/^[a-z]+(_[a-z]+)+$/i.test(s.text.trim()),
  },
  language: {
    get description() { return tr("Langue de la réponse : la même que le message envoyé, ou une langue donnée"); },
    get fields(): FieldDef[] {
      return [
        {
          name: "value", label: tr("Langue attendue"), kind: "select", options: ["message", ...LANGUAGES],
          optionLabels: {
            message: tr("Même langue que le message utilisateur"),
            ...Object.fromEntries(LANGUAGES.map((l) => [l, tr("Autre langue : {name} ({code})", { name: languageName(l), code: l })])),
          },
        },
        { name: "path", label: tr("Chemin du texte (JSON, facultatif)"), kind: "text", placeholder: "reply" },
      ];
    },
    label: (c) => (!c.value || c.value === "message" ? tr("langue = celle du message") : tr("langue = {lang}", { lang: c.value })),
    test: (s, c) => {
      const text = c.path ? String(get(s.json, c.path) ?? "") : proseOf(s.text, s.json);
      const got = detectLanguage(text).lang;
      let expected = c.value && c.value !== "message" ? String(c.value) : null;
      if (!expected) {
        expected = detectLanguage(s.message ?? "").lang;
        // Message trop court pour en déduire la langue (« ok », un nom propre) : rien à comparer.
        if (!expected) return { pass: true, detail: tr("langue du message indéterminée, non vérifiée") };
      }
      if (!got) return { pass: false, detail: tr("langue de la réponse indéterminée (attendu : {expected})", { expected }) };
      return { pass: got === expected, detail: got === expected ? got : tr("réponse en {got}, attendu {expected}", { got, expected }) };
    },
  },
  maxLatency: {
    get description() { return tr("Temps de réponse ≤ N secondes"); },
    get fields(): FieldDef[] { return [{ name: "seconds", label: tr("Secondes"), kind: "number", placeholder: "30" }]; },
    label: (c) => `≤ ${c.seconds} s`,
    test: (s, c) => s.latencyMs <= Number(c.seconds) * 1000,
  },
};

/** Vérifications propres au bench serveur. */
export function serverBuiltinChecks(kinds: string[]): Record<string, CheckType> {
  return {
    kind: {
      get description() { return tr("Type de réponse : {kinds}", { kinds: kinds.join(", ") }); },
      get fields(): FieldDef[] { return [{ name: "value", label: tr("Type attendu"), kind: "select", options: kinds }]; },
      label: (c) => tr("réponse = {value}", { value: c.value }),
      test: (s, c) => s.kind === c.value,
    },
    notError: {
      get description() { return tr("Ni erreur HTTP, ni erreur technique"); },
      fields: [],
      label: () => tr("pas d'erreur technique"),
      test: (s) => s.kind !== "error",
    },
    status: {
      get description() { return tr("Code HTTP"); },
      get fields(): FieldDef[] { return [{ name: "value", label: tr("Code"), kind: "number", placeholder: "200" }]; },
      label: (c) => `HTTP ${c.value}`,
      test: (s, c) => s.status === Number(c.value),
    },
  };
}

// =================================================================================================
// Exécution
// =================================================================================================

export interface CheckResult {
  label: string;
  /** null = non évaluée (une vérification préalable a échoué). */
  pass: boolean | null;
}

export function checkLabel(types: Record<string, CheckType>, c: CheckDef) {
  try {
    return types[c.type]?.label(c) ?? c.type;
  } catch {
    return c.type;
  }
}

/** Évalue les vérifications dans l'ordre ; après l'échec d'une vérification préalable (gate), les autres ne sont pas évaluées. */
export function runChecks(types: Record<string, CheckType>, checks: CheckDef[], subject: CheckSubject): CheckResult[] {
  let blocked = false;
  return checks.map((c) => {
    const t = types[c.type];
    const label = checkLabel(types, c);
    if (blocked && !t?.gate) return { label, pass: null };
    let pass = false;
    let detail: string | undefined;
    try {
      const out = t?.test(subject, c, helpers);
      if (out && typeof out === "object") ({ pass, detail } = out);
      else pass = Boolean(out);
    } catch {
      pass = false;
    }
    if (!pass && t?.gate) blocked = true;
    return { label: detail ? `${label} (${detail})` : label, pass };
  });
}

export function checkTypesForUi(types: Record<string, CheckType>) {
  return Object.entries(types).map(([type, t]) => ({ type, description: t.description, fields: (t.fields ?? []) as FieldDef[], gate: Boolean(t.gate) }));
}
