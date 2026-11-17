#!/usr/bin/env node
// `doctor` s'exécute sans dépendance (avant npm install) ; le reste charge tsx pour exécuter les
// sources TypeScript du bench et la config du projet testé (bench.config.ts).
if (process.argv[2] === "doctor") {
  await import("./doctor.mjs");
} else {
  let register;
  try {
    ({ register } = await import("tsx/esm/api"));
  } catch {
    const fr = /^fr/i.test(process.env.LLM_BENCH_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "");
    console.error(fr
      ? "llm-bench : dépendances manquantes. Lancez « llm-bench doctor » (ou « node bin/llm-bench.mjs doctor ») pour les installer."
      : "llm-bench: missing dependencies. Run \"llm-bench doctor\" (or \"node bin/llm-bench.mjs doctor\") to install them.");
    process.exit(1);
  }
  register();
  await import("../src/cli.ts");
}
