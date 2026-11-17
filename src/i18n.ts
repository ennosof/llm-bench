/**
 * Langue de l'outil : français ou anglais.
 *
 * Le texte français sert de clé : tr(<texte français>) le renvoie tel quel en français, et sa
 * traduction (dictionnaires de src/i18n/) en anglais. Les paramètres s'écrivent {nom} :
 * tr(<"{n} cas">, { n: 3 }). Une clé sans traduction s'affiche en français (npm run i18n:check).
 *
 * Langue : en-tête x-llm-bench-lang des requêtes de l'interface (sélecteur FR / EN), sinon
 * LLM_BENCH_LANG, sinon la langue du système (LC_ALL, LC_MESSAGES, LANG) ; anglais par défaut.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { EN_BENCH } from "./i18n/en-bench.js";
import { EN_CLI } from "./i18n/en-cli.js";
import { EN_CORE } from "./i18n/en-core.js";

export type Lang = "fr" | "en";

const EN: Record<string, string> = { ...EN_CORE, ...EN_CLI, ...EN_BENCH };
const store = new AsyncLocalStorage<Lang>();

/** "fr_FR.UTF-8", "fr-CA", "en" → langue ; null si non reconnue. */
export function parseLang(value: unknown): Lang | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v.startsWith("fr")) return "fr";
  if (v.startsWith("en")) return "en";
  return null;
}

export function defaultLang(): Lang {
  const env = process.env;
  for (const v of [env.LLM_BENCH_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const l = parseLang(v);
    if (l) return l;
  }
  return "en";
}

/** Exécute `fn` (et tout ce qu'elle lance en asynchrone) dans la langue donnée. */
export function withLang<T>(lang: Lang, fn: () => T): T {
  return store.run(lang, fn);
}

export function lang(): Lang {
  return store.getStore() ?? defaultLang();
}

export function tr(fr: string, params?: Record<string, unknown>): string {
  const text = lang() === "en" ? EN[fr] ?? fr : fr;
  return params ? text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : text;
}
