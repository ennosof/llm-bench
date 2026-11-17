/**
 * Vérifie que chaque texte passé à tr("…") a sa traduction anglaise.
 *   node scripts/i18n-check.mjs        → liste les clés manquantes ou inutilisées, code 1 s'il en manque
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
// tr("…") ou tr('…') : littéraux simples uniquement (pas de gabarits `${…}` comme clé).
const KEY = /\btr\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
const keysIn = (text) => [...text.matchAll(KEY)].map((m) => JSON.parse(`"${(m[1] ?? m[2].replace(/"/g, '\\"')).replace(/\\'/g, "'")}"`));

let missing = 0;
function check(label, used, dict) {
  const miss = [...new Set(used)].filter((k) => !(k in dict));
  const unused = Object.keys(dict).filter((k) => !used.includes(k));
  missing += miss.length;
  console.log(`${label} : ${new Set(used).size} textes, ${miss.length} sans traduction, ${unused.length} traduction(s) inutilisée(s)`);
  for (const k of miss) console.log(`  manquant : ${JSON.stringify(k)}`);
  for (const k of unused) console.log(`  inutilisé : ${JSON.stringify(k)}`);
}

// Serveur et CLI
const srcFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).map((f) => `src/${f}`);
const dicts = await Promise.all(["en-core", "en-cli", "en-bench"].map((n) => import(join(root, "src/i18n", `${n}.ts`)).catch(() => null)));
const serverDict = Object.assign({}, ...dicts.filter(Boolean).flatMap((m) => Object.values(m)));
check("src", srcFiles.flatMap((f) => keysIn(read(f))), serverDict);

// Interface : dictionnaire UI_EN dans ui/index.html, entre les marqueurs i18n:start / i18n:end.
const ui = read("ui/index.html");
const block = ui.match(/\/\/ i18n:start\n([\s\S]*?)\/\/ i18n:end/)?.[1] ?? "";
const uiDict = Function(`${block}; return UI_EN;`)();
const code = ui.replace(block, "");
check("ui", keysIn(code), uiDict);

process.exit(missing ? 1 : 0);
