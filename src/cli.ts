/**
 * llm-bench — ligne de commande.
 *
 *   llm-bench [ui] [--config <fichier>] [--open]     interface web, proxy et passerelle
 *   llm-bench prompt --models a/b,c/d [--cases …]    bench prompt sans interface
 *   llm-bench gateway use <profil|fournisseur/modèle> choisit le modèle de la passerelle
 *   llm-bench gateway status                         modèle actuel de la passerelle
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { findConfig, loadConfig } from "./config.js";
import { gatewayStatus, setGateway } from "./gateway.js";
import { init } from "./init.js";
import { detectPrompts, savePromptSource } from "./prompt-source.js";
import { startHttp } from "./http.js";
import { loadCases, reportToMarkdown, resultsDir, runCampaign, summarize, systemPrompt } from "./prompt-bench.js";
import { availableModels, tierOf } from "./providers.js";
import { tr } from "./i18n.js";

const row = (left: string, desc: string) => `  ${left.padEnd(22)}  ${desc}`;

function help() {
  return [
    "",
    tr("llm-bench — compare des modèles LLM (locaux ou cloud, gratuits ou payants) sur un projet."),
    "",
    tr("Commandes :"),
    row("doctor", tr("Vérifie Node.js, les dépendances et Ollama ; propose d'installer ce qui manque (--yes, --no)")),
    row("init", tr("Crée bench/bench.config.ts dans le projet courant (détection automatique)")),
    row("ui", tr("Interface web (défaut), proxy des serveurs et passerelle")),
    row("prompt", tr("Bench prompt en ligne de commande")),
    row(tr("gateway use <cible>"), tr("Modèle de la passerelle : profil (ex. free, paid) ou fournisseur/modèle")),
    row("gateway status", tr("Modèle actuel de la passerelle")),
    "",
    tr("Options communes :"),
    row(tr("-c, --config <fichier>"), tr("Configuration (défaut : bench.config.ts ou bench/bench.config.ts)")),
    row("--port <n>", tr("Port de l'interface et de la passerelle (défaut : config ou 4317)")),
    "",
    tr("init :"),
    row(tr("--dir <dossier>"), tr("Dossier de la config (défaut : bench)")),
    row("--force", tr("Remplace une config existante")),
    "",
    tr("ui :"),
    row("--open", tr("Ouvre l'interface dans le navigateur")),
    "",
    tr("prompt :"),
    row("--models <a,b,…>", tr("Modèles fournisseur/modèle (ex. ollama/qwen2.5:7b,openrouter/…)")),
    row("--tier <free|paid|all>", tr("À défaut de --models : tous les modèles disponibles de cette offre")),
    row("--cases <a,b,…>", tr("Ne lancer que ces cas")),
    row("--runs <n>", tr("Répétitions par cas (défaut : 1)")),
    row("--parallel <n>", tr("Appels simultanés vers les modèles distants ; modèles locaux à la suite (défaut : 1)")),
    row(tr("--name <texte>"), tr("Nom du rapport")),
    row("--verbose", tr("Affiche la réponse brute de chaque appel")),
    "",
    tr("Environnement :"),
    row("LLM_BENCH_LANG=fr|en", tr("Langue (défaut : langue du système, sinon anglais)")),
    "",
  ].join("\n");
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string", short: "c" },
    port: { type: "string" },
    open: { type: "boolean", default: false },
    models: { type: "string" },
    tier: { type: "string" },
    cases: { type: "string" },
    runs: { type: "string", default: "1" },
    parallel: { type: "string", default: "1" },
    name: { type: "string" },
    verbose: { type: "boolean", default: false },
    dir: { type: "string" },
    force: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

async function setup() {
  const file = opts.config ?? findConfig();
  if (!file) throw new Error(tr("aucune configuration : créer bench.config.ts (voir examples/) ou passer --config <fichier>"));
  if (opts.port) process.env.BENCH_PORT = opts.port;
  return loadConfig(file);
}

async function ui() {
  const cfg = await setup();
  startHttp({
    onListening: (url) => {
      console.log(tr("{name} : {url}", { name: cfg.name ?? "llm-bench", url }));
      console.log(tr("Config    : {file}", { file: relative(process.cwd(), cfg.file) || cfg.file }));
      console.log(tr("Passerelle: {url}", { url: `${url.replace("localhost", "127.0.0.1")}/gateway/v1` }));
      if (cfg.server) console.log(tr("Serveurs  : {dir}", { dir: cfg.server.instancesDir }));
      if (opts.open) spawn(process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    },
  });
}

async function gateway() {
  await setup();
  const [, action, value] = positionals;
  if (action === "use") {
    if (!value) throw new Error(tr("llm-bench gateway use <profil|fournisseur/modèle>"));
    setGateway(value);
  } else if (action && action !== "status") throw new Error(tr("action inconnue : {action}", { action }));
  const s = gatewayStatus();
  console.log(tr("Passerelle : {url}", { url: s.url }));
  const tier = s.tier ? ` (${s.tier === "free" ? tr("gratuit") : tr("payant")})` : "";
  const profile = s.profile ? tr(" · profil {profile}", { profile: s.profile }) : "";
  console.log(tr("Modèle     : {model}", { model: `${s.target ?? tr("aucun")}${tier}${profile}` }));
  if (s.profiles.length) console.log(tr("Profils    : {profiles}", { profiles: s.profiles.map((p) => `${p.name} → ${p.key}`).join(", ") }));
}

const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : "–");

async function prompt() {
  const cfg = await setup();
  if (!cfg.prompt) throw new Error(tr("pas de section « prompt » dans la config"));
  let models = opts.models?.split(",").map((m) => m.trim()).filter(Boolean) ?? [];
  if (!models.length) {
    const tier = opts.tier ?? "free";
    for (const p of await availableModels()) {
      if (p.error) console.warn(tr("  {name} ignoré : {error}", { name: p.name, error: p.error }));
      for (const m of p.models) if (tier === "all" || tierOf(m.provider) === tier) models.push(m.key);
    }
  }
  const caseFilter = opts.cases?.split(",").map((c) => c.trim());
  const all = loadCases();
  const cases = caseFilter ? all.filter((c) => caseFilter.includes(c.id)) : all;
  const runs = Math.max(1, Number(opts.runs));
  if (!models.length) throw new Error(tr("aucun modèle à tester (--models ou --tier)"));
  if (!cases.length) throw new Error(opts.cases ? tr("aucun cas ne correspond à --cases {cases}", { cases: opts.cases }) : tr("aucun cas de test"));

  // Ordre de grandeur pour détecter un contexte tronqué par Ollama (≈ 4 caractères par token).
  const estimatedPromptTokens = Math.round((await systemPrompt()).length / 4);
  console.log(tr("Modèles : {models}", { models: models.join(", ") }));
  console.log(tr("Cas     : {cases} × {runs} run(s)   (prompt système ≈ {tokens} tokens)\n", { cases: cases.length, runs, tokens: estimatedPromptTokens }));

  const parallel = Math.max(1, Number(opts.parallel) || 1);
  const report = await runCampaign({ models, cases, runs, name: opts.name, parallel }, (e) => {
    if (e.type === "model") {
      if (e.status === "loading") process.stdout.write(`▶ ${e.model}\n`);
      if (e.status === "ready" && e.info?.loadMs) console.log(tr("  chargé en {s}s", { s: (e.info.loadMs / 1000).toFixed(1) }));
      if (e.status === "error") console.log(tr("  échec : {error}\n", { error: e.info?.error }));
    }
    if (e.type === "result") {
      const r = e.result;
      const tag = runs > 1 ? ` #${r.run}` : "";
      const icon = r.status === "pass" ? "✅" : r.status === "fail" && r.jsonValid ? "❌" : "💥";
      console.log(`  ${icon} ${parallel > 1 ? `${r.model}  ` : ""}${r.caseId}${tag}  ${(r.latencyMs / 1000).toFixed(1)}s${r.status === "pass" ? "" : `  → ${r.error ?? r.failures.join(" ; ")}`}`);
      if (opts.verbose && r.raw) console.log(`     ${r.raw.replace(/\n/g, "\n     ")}`);
      if (r.contextTruncated) {
        console.log(tr("     ⚠️  prompt_tokens={got} (≈ {expected} attendus) : contexte probablement tronqué (OLLAMA_CONTEXT_LENGTH trop petit ?)", { got: r.promptTokens, expected: r.expectedPromptTokens }));
      }
    }
  });

  console.log(tr("\nSynthèse"));
  console.table(
    summarize(report).map((s) => ({
      [tr("modèle")]: s.model,
      [tr("offre")]: s.tier,
      [tr("score")]: pct(s.passed, s.total),
      json: pct(s.jsonOk, s.total),
      [tr("latence")]: `${((s.avgLatencyMs ?? 0) / 1000).toFixed(1)}s`,
      [tr("tokSortie")]: s.avgCompletionTokens,
      [tr("tokParS")]: s.avgTokensPerSec,
      [tr("coût")]: s.totalCost == null ? "–" : `${s.totalCost.toFixed(4)} ${cfg.currency}`,
    })),
  );
  writeFileSync(join(resultsDir(), `${report.id}.md`), reportToMarkdown(report));
  console.log(tr("\nRapports : {path}", { path: `${join(resultsDir(), report.id)}.{json,md}` }));
}

async function initCmd() {
  const r = init(process.cwd(), { dir: opts.dir, force: opts.force });
  console.log(tr("Détection :"));
  for (const d of r.detected) console.log(`  ${d.sure ? "✓" : "?"} ${d.why}`);
  // Prompt système : enregistré seulement s'il est utilisé comme message système et lisible.
  try {
    await loadConfig(join(process.cwd(), r.created[0]));
    const [best] = await detectPrompts();
    if (best?.ok && best.kind === "module" && best.usages.length) {
      savePromptSource({ kind: "module", module: best.file, export: best.export!, version: best.version ? { module: best.version.file, export: best.version.export } : null });
      const version = best.version ? tr(", version {version}", { version: best.version.value }) : "";
      console.log(tr("  ✓ prompt système : {file} → {export} ({length} caractères{version})", { file: best.file, export: best.export, length: best.length, version }));
    } else {
      console.log(tr("  ? prompt système : non trouvé, à choisir dans l'interface (Bench prompt → Prompt système)"));
    }
  } catch (error) {
    console.log(tr("  ? prompt système : détection impossible ({error})", { error: error instanceof Error ? error.message : error }));
  }
  console.log(tr("\nCréé : {files}", { files: r.created.join(", ") }));
  console.log(tr("\nÀ faire : relire les lignes « À VÉRIFIER » de bench.config.ts, renseigner les clés API dans le .env,\npuis lancer : llm-bench ui --open"));
}

const commands: Record<string, () => Promise<void>> = { init: initCmd, ui, prompt, gateway };

if (opts.help) {
  console.log(help());
} else {
  const cmd = positionals[0] ?? "ui";
  const fn = commands[cmd];
  if (!fn) {
    console.error(`${tr("Commande inconnue : {cmd}", { cmd })}\n${help()}`);
    process.exit(1);
  }
  fn().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

