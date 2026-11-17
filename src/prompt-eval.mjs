/**
 * Évalue des exports du projet testé dans un processus à part (lancé par prompt-source.ts avec tsx) :
 * les effets de bord d'un module (connexions, timers…) restent hors du bench, et chaque appel relit
 * le code à jour.
 *
 *   node --import <tsx> prompt-eval.mjs '[{"module":"/abs/index.ts","export":"SYSTEM_PROMPT"}]'
 *
 * Écrit sur stdout, après le marqueur, un tableau { ok, text } | { ok: false, error }.
 */
import { pathToFileURL } from "node:url";

export const MARKER = "@@llm-bench-prompt-eval@@";

const items = JSON.parse(process.argv[2] ?? "[]");
const out = [];
for (const item of items) {
  try {
    const mod = await import(pathToFileURL(item.module).href);
    let v = mod[item.export];
    if (v === undefined) throw new Error(`export « ${item.export} » introuvable`);
    if (typeof v === "function") {
      if (v.length > 0) throw new Error(`« ${item.export} » est une fonction qui attend des paramètres`);
      v = await v();
    }
    if (typeof v !== "string") throw new Error(`« ${item.export} » n'est pas un texte (${Array.isArray(v) ? "tableau" : typeof v})`);
    out.push({ ok: true, text: v });
  } catch (error) {
    out.push({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
process.stdout.write(`\n${MARKER}${JSON.stringify(out)}\n`);
process.exit(0);
