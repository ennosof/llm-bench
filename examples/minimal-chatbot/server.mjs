/**
 * Chatbot minimal pour essayer llm-bench : POST /chat { message, sessionId } → { type, reply, data }.
 *
 * Il classe la demande avec un LLM compatible OpenAI (LLM_ENDPOINT, LLM_API_KEY, LLM_MODEL) et
 * répond, en gardant l'historique par session. Aucune dépendance.
 *
 *   LLM_ENDPOINT=http://localhost:11434/v1 LLM_MODEL=qwen2.5:7b node server.mjs
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { SYSTEM_PROMPT } from "./prompt.mjs";

// Lecture du .env local (le bench en écrit un dans chaque copie).
if (existsSync(".env")) process.loadEnvFile(".env");

const BOOKS = [
  { title: "Le Petit Prince", author: "Antoine de Saint-Exupéry" },
  { title: "Dune", author: "Frank Herbert" },
  { title: "Les Misérables", author: "Victor Hugo" },
  { title: "Foundation", author: "Isaac Asimov" },
];

const sessions = new Map();

async function llm(messages) {
  const res = await fetch(`${process.env.LLM_ENDPOINT.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY ?? "none"}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL, messages, temperature: 0, response_format: { type: "json_object" } }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const text = (await res.json()).choices?.[0]?.message?.content ?? "";
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

async function chat({ message, sessionId }) {
  const history = sessions.get(sessionId) ?? [];
  const out = await llm([{ role: "system", content: SYSTEM_PROMPT }, ...history, { role: "user", content: message }]);
  sessions.set(sessionId, [...history, { role: "user", content: message }, { role: "assistant", content: out.reply ?? "" }].slice(-10));
  if (out.intent === "search") {
    const q = String(out.query ?? "").toLowerCase();
    const books = BOOKS.filter((b) => q && (b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q) || q.includes(b.author.toLowerCase().split(" ").at(-1))));
    return { type: books.length ? "success" : "no_results", intent: out.intent, reply: out.reply, data: { query: out.query, books } };
  }
  if (out.intent === "order_status") return { type: "success", intent: out.intent, reply: out.reply, data: { orderId: out.orderId, status: out.orderId ? "shipped" : null } };
  return { type: "info", intent: out.intent, reply: out.reply };
}

const server = createServer(async (req, res) => {
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, model: process.env.LLM_MODEL });
  if (req.method === "POST" && req.url === "/chat") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      return send(200, await chat(JSON.parse(body || "{}")));
    } catch (error) {
      return send(200, { type: "error", reply: "ai_error", error: String(error) });
    }
  }
  send(404, { error: "not found" });
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, "127.0.0.1", () => console.log(`chatbot sur http://127.0.0.1:${port} (modèle ${process.env.LLM_MODEL})`));
