/**
 * llm-bench doctor — vérifie les prérequis et propose d'installer ce qui manque.
 *
 *   Node.js 22+            obligatoire
 *   dépendances npm (tsx)  obligatoire
 *   Ollama                 facultatif (modèles locaux) : installé, démarré, au moins un modèle
 *
 * JavaScript pur, sans dépendance : fonctionne avant `npm install` (node bin/llm-bench.mjs doctor).
 * Options : --yes (accepte toutes les propositions), --no (n'installe rien, rapport seul).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE = 22;
const SUGGESTED_MODEL = "qwen2.5:7b";
const args = process.argv.slice(2);
const YES = args.includes("--yes") || args.includes("-y");
const NO = args.includes("--no");

// ---- Langue (même règle que src/i18n.ts, sans tsx) -------------------------------------------

const LANG = (() => {
  const { LLM_BENCH_LANG, LC_ALL, LC_MESSAGES, LANG: L } = process.env;
  for (const v of [LLM_BENCH_LANG, LC_ALL, LC_MESSAGES, L]) {
    const s = String(v ?? "").toLowerCase();
    if (s.startsWith("fr")) return "fr";
    if (s.startsWith("en")) return "en";
  }
  return "en";
})();

const T = {
  title: ["Vérification des prérequis de llm-bench", "Checking llm-bench requirements"],
  node: ["Node.js", "Node.js"],
  nodeOk: ["{v} (≥ {min} requis)", "{v} (≥ {min} required)"],
  nodeOld: ["{v} : version {min} ou plus requise", "{v}: version {min} or later required"],
  deps: ["Dépendances npm", "npm dependencies"],
  depsOk: ["installées", "installed"],
  depsMissing: ["non installées (tsx manquant)", "not installed (tsx missing)"],
  ollama: ["Ollama (facultatif, modèles locaux)", "Ollama (optional, local models)"],
  ollamaMissing: ["non installé", "not installed"],
  ollamaStopped: ["{v} installé, mais le serveur ne répond pas sur {url}", "{v} installed, but the server does not answer on {url}"],
  ollamaOk: ["{v} · serveur actif · {n} modèle(s)", "{v} · server running · {n} model(s)"],
  ollamaNoModel: ["{v} · serveur actif · aucun modèle téléchargé", "{v} · server running · no model downloaded"],
  askInstall: ["Installer {what} avec « {cmd} » ?", "Install {what} with \"{cmd}\"?"],
  askStart: ["Démarrer le serveur Ollama (« {cmd} ») ?", "Start the Ollama server (\"{cmd}\")?"],
  askPull: ["Télécharger un premier modèle gratuit, {model} (≈ 4,7 Go) ?", "Download a first free model, {model} (≈ 4.7 GB)?"],
  manual: ["À installer à la main : {url}", "Install it manually: {url}"],
  nodeManual: ["Installez Node.js {min}+ : {url} (ou nvm : nvm install {min}), puis relancez cette commande.", "Install Node.js {min}+: {url} (or nvm: nvm install {min}), then run this command again."],
  restart: ["Node.js a été mis à jour : relancez « llm-bench doctor » dans un nouveau terminal.", "Node.js was updated: run \"llm-bench doctor\" again in a new terminal."],
  running: ["$ {cmd}", "$ {cmd}"],
  failed: ["échec ({code})", "failed ({code})"],
  waiting: ["Attente du serveur Ollama…", "Waiting for the Ollama server…"],
  allGood: ["Tout est prêt. Lancez : llm-bench ui --open", "All set. Run: llm-bench ui --open"],
  requiredMissing: ["Prérequis obligatoires manquants : llm-bench ne peut pas démarrer.", "Required prerequisites missing: llm-bench cannot start."],
  optionalNote: ["Sans Ollama, seuls les modèles cloud sont utilisables.", "Without Ollama, only cloud models can be used."],
  yesNo: ["[O/n]", "[Y/n]"],
  noYes: ["[o/N]", "[y/N]"],
};
const t = (key, params = {}) => T[key][LANG === "fr" ? 0 : 1].replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));

// ---- Utilitaires -------------------------------------------------------------------------------

const color = process.stdout.isTTY ? (c, s) => `\x1b[${c}m${s}\x1b[0m` : (_c, s) => s;
const SEP = LANG === "fr" ? " : " : ": ";
const ok = (label, detail) => console.log(`${color(32, "✓")} ${label}${SEP}${detail}`);
const bad = (label, detail) => console.log(`${color(31, "✗")} ${label}${SEP}${detail}`);
const warn = (label, detail) => console.log(`${color(33, "!")} ${label}${SEP}${detail}`);

const has = (cmd) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
/** Numéro de version d'une commande (les avertissements éventuels, ex. serveur Ollama absent, sont ignorés). */
const version = (cmd, arg = "--version") => {
  const r = spawnSync(cmd, [arg], { encoding: "utf8" });
  if (r.error) return null;
  return `${r.stdout ?? ""}\n${r.stderr ?? ""}`.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? null;
};

/** Question oui / non ; `def` = réponse par défaut. --yes / --no et l'absence de terminal décident sans demander. */
async function ask(question, def = true) {
  if (YES) return true;
  if (NO || !process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`  ${question} ${t(def ? "yesNo" : "noYes")} `, r));
  rl.close();
  const a = answer.trim().toLowerCase();
  return a ? ["o", "oui", "y", "yes"].includes(a) : def;
}

function run(cmd, opts = {}) {
  console.log(color(2, `  ${t("running", { cmd })}`));
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) console.log(`  ${color(31, t("failed", { code: r.status ?? r.signal }))}`);
  return r.status === 0;
}

const OLLAMA_URL = (process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : "http://127.0.0.1:11434").replace(/\/+$/, "");

async function ollamaTags() {
  if (typeof fetch !== "function") return null;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? (await r.json()).models ?? [] : null;
  } catch {
    return null;
  }
}

// Commandes d'installation selon le système (null : installation manuelle).
const mac = process.platform === "darwin", win = process.platform === "win32", linux = process.platform === "linux";
const brew = mac && has("brew");
const winget = win && has("winget");

function nodeInstallCmd() {
  if (brew) return "brew install node";
  if (winget) return "winget install --id OpenJS.NodeJS --source winget";
  return null;
}
function ollamaInstallCmd() {
  if (brew) return "brew install ollama";
  if (winget) return "winget install --id Ollama.Ollama --source winget";
  if (linux && has("curl")) return "curl -fsSL https://ollama.com/install.sh | sh";
  return null;
}
function ollamaStartCmd() {
  if (brew && spawnSync("brew", ["list", "ollama"], { stdio: "ignore" }).status === 0) return "brew services start ollama";
  return "ollama serve";
}

// ---- Vérifications -----------------------------------------------------------------------------

console.log(`\n${color(1, t("title"))}\n`);
let requiredMissing = false;

// 1. Node.js
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= MIN_NODE) {
  ok(t("node"), t("nodeOk", { v: `v${process.versions.node}`, min: MIN_NODE }));
} else {
  bad(t("node"), t("nodeOld", { v: `v${process.versions.node}`, min: MIN_NODE }));
  const cmd = nodeInstallCmd();
  if (cmd && (await ask(t("askInstall", { what: "Node.js", cmd })))) {
    if (run(cmd)) console.log(`  ${t("restart")}`);
  } else {
    console.log(`  ${t("nodeManual", { min: MIN_NODE, url: "https://nodejs.org" })}`);
  }
  requiredMissing = true;
}

// 2. Dépendances npm
const depsInstalled = () => existsSync(join(ROOT, "node_modules", "tsx", "package.json"));
if (depsInstalled()) {
  const v = JSON.parse(readFileSync(join(ROOT, "node_modules", "tsx", "package.json"), "utf8")).version;
  ok(t("deps"), `${t("depsOk")} (tsx ${v})`);
} else {
  bad(t("deps"), t("depsMissing"));
  const cmd = "npm install";
  if (nodeMajor >= MIN_NODE && (await ask(t("askInstall", { what: t("deps").toLowerCase(), cmd })))) run(cmd, { cwd: ROOT });
  if (depsInstalled()) ok(t("deps"), t("depsOk"));
  else requiredMissing = true;
}

// 3. Ollama (facultatif)
let ollamaV = has("ollama") ? version("ollama") : null;
if (!ollamaV) {
  warn(t("ollama"), t("ollamaMissing"));
  const cmd = ollamaInstallCmd();
  if (cmd && (await ask(t("askInstall", { what: "Ollama", cmd })))) {
    if (run(cmd)) ollamaV = version("ollama");
  } else if (!cmd) {
    console.log(`  ${t("manual", { url: "https://ollama.com/download" })}`);
  }
}
if (ollamaV) {
  ollamaV = `Ollama ${ollamaV}`;
  let tags = await ollamaTags();
  if (!tags) {
    warn(t("ollama"), t("ollamaStopped", { v: ollamaV, url: OLLAMA_URL }));
    const cmd = ollamaStartCmd();
    if (await ask(t("askStart", { cmd }))) {
      if (cmd === "ollama serve") spawn("ollama", ["serve"], { detached: true, stdio: "ignore" }).unref();
      else run(cmd);
      console.log(color(2, `  ${t("waiting")}`));
      for (let i = 0; i < 20 && !tags; i++) {
        await new Promise((r) => setTimeout(r, 500));
        tags = await ollamaTags();
      }
    }
  }
  if (tags && tags.length) ok(t("ollama"), t("ollamaOk", { v: ollamaV, n: tags.length }));
  else if (tags) {
    warn(t("ollama"), t("ollamaNoModel", { v: ollamaV }));
    if (await ask(t("askPull", { model: SUGGESTED_MODEL }), false)) run(`ollama pull ${SUGGESTED_MODEL}`);
  }
}

// ---- Bilan -------------------------------------------------------------------------------------

console.log("");
if (requiredMissing) {
  console.log(color(31, t("requiredMissing")));
  process.exit(1);
}
if (!ollamaV) console.log(color(2, t("optionalNote")));
console.log(color(32, t("allGood")));
