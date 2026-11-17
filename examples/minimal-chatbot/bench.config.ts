/**
 * Exemple de configuration llm-bench pour le chatbot minimal (server.mjs).
 *
 *   node ../../bin/llm-bench.mjs ui --config bench.config.ts --open
 *
 * Les clés API se lisent dans l'environnement (ou un .env chargé ci-dessous) : jamais en dur ici.
 */
import { existsSync } from "node:fs";
import { defineConfig } from "../../src/config.ts";
import { SYSTEM_PROMPT } from "./prompt.mjs";

const envFile = new URL("./.env.bench", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

// Hors de ce dépôt, defineConfig est facultatif : `export default { … }` suffit.
export default defineConfig({
  name: "Bench · chatbot librairie",
  currency: "$",

  providers: {
    // Gratuit : modèles locaux.
    ollama: { kind: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", tier: "free" },
    // Gratuit : offres cloud gratuites (clé gratuite, quotas limités).
    openrouter: {
      label: "OpenRouter (modèles :free)",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: env.OPENROUTER_API_KEY,
      tier: "free",
      models: ["meta-llama/llama-3.3-70b-instruct:free", "mistralai/mistral-small-3.2-24b-instruct:free"],
    },
    groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, tier: "free", models: ["llama-3.3-70b-versatile"] },
    // Payant : prix par million de tokens (à vérifier sur la page de tarifs du fournisseur).
    openai: {
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: env.OPENAI_API_KEY,
      tier: "paid",
      models: ["gpt-4.1-mini"],
      pricing: { "gpt-4.1-mini": { input: 0.4, output: 1.6 } },
    },
  },

  // Bench prompt : le prompt du chatbot, sans lancer le serveur.
  prompt: {
    system: SYSTEM_PROMPT,
    version: "1.0",
    request: () => ({ temperature: 0, response_format: { type: "json_object" }, max_tokens: 512 }),
    categories: ["search", "order_status", "other"],
    newCase: { checks: [{ type: "intent", value: "search" }] },
    checks: {
      intent: {
        description: "intent attendu (vérification préalable)",
        gate: true,
        fields: [{ name: "value", label: "Intent", kind: "select", options: ["search", "order_status", "other"] }],
        label: (c) => `intent = ${c.value}`,
        test: (s, c) => s.json?.intent === c.value,
      },
    },
  },

  // Bench serveur : copies du chatbot lancées avec le modèle choisi, testées sur POST /chat.
  server: {
    source: ".",
    instancesDir: "./.instances",
    exclude: [".instances", ".env.bench"],
    env: { port: "PORT", baseUrl: "LLM_ENDPOINT", apiKey: "LLM_API_KEY", model: "LLM_MODEL" },
    start: "node server.mjs",
    health: "/health",
    shareDirs: [],
    chat: {
      path: "/chat",
      body: (ctx) => ({ message: ctx.message, sessionId: ctx.sessionId }),
      kinds: ["success", "info", "no_results", "error"],
      kind: (status, json) => (status !== 200 || !json ? "error" : json.type ?? "error"),
      reply: (json) => json?.reply,
      summary: (json) => (Array.isArray(json?.data?.books) ? `${json.data.books.length} livre(s)` : undefined),
    },
    categories: ["recherche", "commande", "conversation", "sécurité"],
    checks: {
      hasBooks: {
        description: "Au moins N livres trouvés",
        fields: [{ name: "min", label: "Minimum", kind: "number", placeholder: "1" }],
        label: (c) => `≥ ${c.min ?? 1} livre(s)`,
        test: (s, c) => (s.json?.data?.books?.length ?? 0) >= Number(c.min ?? 1),
      },
    },
  },

  // Passerelle : un endpoint stable, le modèle se choisit dans l'interface.
  gateway: {
    profiles: { free: "ollama/qwen2.5:7b", paid: "openai/gpt-4.1-mini" },
    default: "free",
  },
});
