/**
 * Proxy d'enregistrement des appels LLM, commun aux serveurs du bench et à la passerelle.
 *
 * Le serveur testé appelle le bench comme s'il s'agissait de l'API du modèle ; le bench relaie
 * vers le vrai fournisseur (clé API ajoutée, streaming compris) et enregistre la requête et la réponse.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { tr } from "./i18n.js";
import { adaptBody, authHeaders, costOf, modelKey, provider, type ModelRef } from "./providers.js";

export interface LlmCall {
  id: string; // identifiant unique de l'appel
  at: string;
  path: string; // ex. /chat/completions
  kind: string; // nom de l'appel (config server.llmCallKind)
  status: number;
  latencyMs: number;
  stream: boolean;
  model?: string; // fournisseur/modèle
  request: any; // corps envoyé, prompts système remplacés par <<prompt:hash>>
  response?: any; // corps reçu (JSON), ou chunks rassemblés en streaming
  content?: string; // texte généré
  promptTokens?: number;
  completionTokens?: number;
  cost?: number | null;
  finishReason?: string;
  error?: string;
  http?: HttpExchange;
}

/** Détail HTTP d'un appel : requête reçue du serveur, requête relayée au fournisseur, réponse. */
export interface HttpExchange {
  incoming: { method: string; url: string; localPort?: number; remoteAddress?: string; remotePort?: number; headers: Record<string, string>; body: any };
  upstream: { method: string; url: string; host: string; port: number; keyHeader: string | null; key: string | null; headers: Record<string, string>; body: any };
  reply: { status: number; statusText?: string; headers: Record<string, string>; body: any; bytes: number };
}

const calls = new Map<string, LlmCall[]>();
const prompts = new Map<string, Record<string, string>>();
const MAX_CALLS = 200;
let callSeq = 0;

const promptHash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 10);

// LangChain envoie le prompt système avec le rôle "developer" aux modèles de raisonnement (gpt-5, o-series).
const isSystemRole = (role: string) => role === "system" || role === "developer";

function callKind(body: any, promptMap: Record<string, string>) {
  const first = String(body?.messages?.find((m: any) => isSystemRole(m.role))?.content ?? "");
  const system = promptMap[first.match(/^<<prompt:([0-9a-f]+)>>$/)?.[1] ?? ""] ?? first;
  const custom = config().server?.llmCallKind;
  if (custom) {
    try {
      const k = custom(body, system);
      if (k) return k;
    } catch {
      // nom par défaut
    }
  }
  if (body?.response_format?.type === "json_object" || body?.response_format?.type === "json_schema") return "JSON";
  // Codes stables (traduits à l'affichage dans l'interface, selon sa langue).
  if (Array.isArray(body?.tools) && body.tools.length) return "outils";
  return "génération";
}

function record(channel: string, ref: ModelRef, raw: { path: string; status: number; latencyMs: number; requestText: string; responseText: string; error?: string; http?: HttpExchange }) {
  let request: any = raw.requestText;
  try { request = JSON.parse(raw.requestText); } catch { /* corps non JSON */ }
  const promptMap = prompts.get(channel) ?? {};
  if (Array.isArray(request?.messages)) {
    request = {
      ...request,
      messages: request.messages.map((m: any) => {
        if (!isSystemRole(m.role) || typeof m.content !== "string" || m.content.length < 400) return m;
        const h = promptHash(m.content);
        promptMap[h] = m.content;
        return { ...m, content: `<<prompt:${h}>>` };
      }),
    };
  }
  prompts.set(channel, promptMap);

  const stream = Boolean(request?.stream);
  let response: any = raw.responseText;
  let content: string | undefined;
  let usage: any;
  let finishReason: string | undefined;
  if (stream) {
    // SSE : on rassemble le texte et on garde le dernier usage / finish_reason.
    const chunks = raw.responseText.split("\n").filter((l) => l.startsWith("data:") && !l.includes("[DONE]")).flatMap((l) => {
      try { return [JSON.parse(l.slice(5))]; } catch { return []; }
    });
    content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    usage = chunks.findLast((c) => c.usage)?.usage;
    finishReason = chunks.findLast((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason;
    response = { chunks: chunks.length, model: chunks[0]?.model, content, usage, finish_reason: finishReason };
  } else {
    try {
      response = JSON.parse(raw.responseText);
      content = response.choices?.[0]?.message?.content ?? undefined;
      usage = response.usage;
      finishReason = response.choices?.[0]?.finish_reason;
    } catch { /* corps non JSON (erreur HTML…) */ }
  }

  const key = modelKey(ref);
  const list = calls.get(channel) ?? [];
  list.push({
    id: `${Date.now().toString(36)}-${++callSeq}`,
    at: new Date().toISOString(),
    path: raw.path,
    kind: callKind(request, promptMap),
    status: raw.status,
    latencyMs: raw.latencyMs,
    stream,
    model: key,
    request,
    response,
    content,
    promptTokens: usage?.prompt_tokens,
    completionTokens: usage?.completion_tokens,
    cost: raw.status < 400 ? costOf(key, usage?.prompt_tokens, usage?.completion_tokens) : 0,
    finishReason,
    ...(raw.http ? { http: raw.http } : {}),
    ...(raw.error ? { error: raw.error } : raw.status >= 400 ? { error: response?.error?.message ? tr("HTTP {status} : {message}", { status: raw.status, message: String(response.error.message).slice(0, 300) }) : `HTTP ${raw.status}` } : {}),
  });
  if (list.length > MAX_CALLS) list.splice(0, list.length - MAX_CALLS);
  calls.set(channel, list);
  const call = list[list.length - 1];
  for (const cb of watchers.get(channel) ?? []) {
    try { cb(call); } catch { /* abonné en erreur : ignoré */ }
  }
  return call;
}

const watchers = new Map<string, Set<(call: LlmCall) => void>>();

/** Prévient `cb` de chaque appel enregistré sur le canal (chat : appels affichés en direct). Renvoie le désabonnement. */
export function watchCalls(channel: string, cb: (call: LlmCall) => void) {
  const set = watchers.get(channel) ?? new Set();
  set.add(cb);
  watchers.set(channel, set);
  return () => { set.delete(cb); };
}

/** Vide les appels enregistrés d'un canal et les renvoie. */
export function takeCalls(channel: string) {
  const list = calls.get(channel) ?? [];
  calls.set(channel, []);
  return list;
}

export function peekCalls(channel: string) {
  return calls.get(channel) ?? [];
}

/** Prompts système vus sur un canal (hash → texte). */
export function takePrompts(channel: string) {
  const p = prompts.get(channel) ?? {};
  prompts.set(channel, {});
  return p;
}

export function peekPrompts(channel: string) {
  return prompts.get(channel) ?? {};
}

// =================================================================================================
// Relais HTTP
// =================================================================================================

const HOP_HEADERS = ["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "content-encoding", "keep-alive", "authorization", "api-key"];

const maskKey = (v: string) => (v.length <= 12 ? "••••" : `${v.slice(0, 6)}…${v.slice(-4)}`);

/** Corps lisible : JSON parsé, flux SSE découpé en événements, sinon texte brut. */
function parseBody(text: string, contentType = ""): any {
  if (!text) return null;
  if (contentType.includes("event-stream") || /^data:/m.test(text.slice(0, 200))) {
    return text.split("\n").filter((l) => l.startsWith("data:")).map((l) => {
      const d = l.slice(5).trim();
      try { return JSON.parse(d); } catch { return d; }
    });
  }
  try { return JSON.parse(text); } catch { return text; }
}

/** En-têtes portant une clé : complets si `reveal`, masqués sinon (rapports écrits sur disque). */
function headerRecord(h: Record<string, string>, reveal: boolean, keyHeaders: string[]) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (reveal || !keyHeaders.includes(k)) out[k] = v;
    else out[k] = /^bearer\s+/i.test(v) ? `Bearer ${maskKey(v.replace(/^bearer\s+/i, ""))}` : maskKey(v);
  }
  return out;
}

function sendError(res: ServerResponse, status: number, message: string) {
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message } }));
  } else res.end();
}

/**
 * Relaie une requête vers le fournisseur de `target` (clé ajoutée, adaptRequest appliqué).
 * `rewriteModel` remplace le modèle demandé par celui de la cible (passerelle).
 * `revealKey` garde la clé en clair dans l'enregistrement (passerelle : en mémoire seulement).
 */
export async function relay(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { channel: string; target: ModelRef; path: string; rewriteModel: boolean; revealKey?: boolean; onRecorded?: (call: LlmCall) => void },
) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let bodyText = Buffer.concat(chunks).toString("utf8");
  const incomingText = bodyText;
  const reveal = Boolean(opts.revealKey);
  const incomingHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) incomingHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
  let upstream: string;
  let p;
  try {
    p = provider(opts.target.provider);
    if (!p.baseUrl) throw new Error(tr("{provider} : baseUrl absente", { provider: opts.target.provider }));
    upstream = p.baseUrl.replace(/\/+$/, "") + opts.path;
  } catch (error) {
    sendError(res, 502, tr("bench : {error}", { error: error instanceof Error ? error.message : String(error) }));
    return;
  }

  let model = opts.target.model;
  if (req.method === "POST" && bodyText) {
    try {
      let body = JSON.parse(bodyText);
      if (opts.rewriteModel || !body.model) body.model = opts.target.model;
      model = String(body.model);
      body = adaptBody(opts.target.provider, String(body.model ?? opts.target.model), body);
      bodyText = JSON.stringify(body);
    } catch {
      // corps non JSON : relayé tel quel
    }
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_HEADERS.includes(k)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
  Object.assign(headers, authHeaders(p));
  const keyHeader = (p.apiKeyHeader ?? "authorization").toLowerCase();
  const sentKey = headers[keyHeader] ? headers[keyHeader].replace(/^bearer\s+/i, "") : null;
  const upstreamUrl = new URL(upstream);

  const started = performance.now();
  let status = 502;
  let responseText = "";
  let error: string | undefined;
  let statusText: string | undefined;
  let replyHeaders: Record<string, string> = {};
  try {
    const r = await fetch(upstream, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyText });
    status = r.status;
    statusText = r.statusText;
    r.headers.forEach((v, k) => { replyHeaders[k] = v; });
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (!HOP_HEADERS.includes(k)) out[k] = v; });
    res.writeHead(r.status, out);
    const decoder = new TextDecoder();
    if (r.body) {
      for await (const chunk of r.body as any) {
        res.write(chunk);
        responseText += decoder.decode(chunk, { stream: true });
      }
    }
    res.end();
  } catch (e) {
    error = tr("relais bench → {url} : {error}", { url: upstream, error: String(e) });
    sendError(res, 502, error);
  }
  const keyHeaders = ["authorization", "api-key", "x-api-key", keyHeader];
  const http: HttpExchange = {
    incoming: {
      method: req.method ?? "GET",
      url: `http://${req.headers.host ?? `127.0.0.1:${req.socket.localPort}`}${req.url ?? ""}`,
      localPort: req.socket.localPort,
      remoteAddress: req.socket.remoteAddress,
      remotePort: req.socket.remotePort,
      headers: headerRecord(incomingHeaders, reveal, keyHeaders),
      body: parseBody(incomingText, incomingHeaders["content-type"]),
    },
    upstream: {
      method: req.method ?? "GET",
      url: upstream,
      host: upstreamUrl.hostname,
      port: Number(upstreamUrl.port) || (upstreamUrl.protocol === "https:" ? 443 : 80),
      keyHeader: sentKey ? keyHeader : null,
      key: sentKey ? (reveal ? sentKey : maskKey(sentKey)) : null,
      headers: headerRecord(headers, reveal, keyHeaders),
      body: parseBody(bodyText, headers["content-type"]),
    },
    reply: { status, statusText, headers: replyHeaders, body: parseBody(responseText, replyHeaders["content-type"]), bytes: Buffer.byteLength(responseText) },
  };
  const call = record(opts.channel, { provider: opts.target.provider, model }, {
    path: opts.path.split("?")[0], status, latencyMs: Math.round(performance.now() - started), requestText: bodyText, responseText, error, http,
  });
  opts.onRecorded?.(call);
}
