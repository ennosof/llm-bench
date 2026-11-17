/**
 * API native Ollama (modèles installés, téléchargements) et catalogue ollama.com.
 */
import { config, type ProviderConfig } from "./config.js";
import { tr } from "./i18n.js";

/** URL de l'API native : baseUrl sans le /v1 final. */
export const ollamaUrlOf = (p: ProviderConfig) => String(p.baseUrl ?? "http://localhost:11434/v1").replace(/\/+$/, "").replace(/\/v1$/, "");

/** Premier fournisseur Ollama de la config (onglet Modèles), ou null. */
export function ollamaProvider() {
  const entry = Object.entries(config().providers).find(([, p]) => p.kind === "ollama");
  return entry ? { name: entry[0], url: ollamaUrlOf(entry[1]) } : null;
}

async function call(base: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Ollama ${path} → ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function ollamaVersion(base: string) {
  try {
    const r = await call(base, "/api/version", { signal: AbortSignal.timeout(3000) });
    return { ok: true, version: ((await r.json()) as any).version as string };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function listLocalModels(base: string) {
  const [tags, ps] = await Promise.all([
    call(base, "/api/tags").then((r) => r.json() as Promise<any>),
    call(base, "/api/ps").then((r) => r.json() as Promise<any>).catch(() => ({ models: [] })),
  ]);
  const loaded = new Map<string, any>((ps.models ?? []).map((m: any) => [m.name, m]));
  return (tags.models ?? [])
    .map((m: any) => ({
      name: m.name as string,
      size: m.size as number,
      modifiedAt: m.modified_at as string,
      family: m.details?.family as string | undefined,
      parameterSize: m.details?.parameter_size as string | undefined,
      quantization: m.details?.quantization_level as string | undefined,
      loaded: loaded.has(m.name) ? { size: loaded.get(m.name).size, sizeVram: loaded.get(m.name).size_vram, contextLength: loaded.get(m.name).context_length } : null,
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
}

export async function modelRuntimeInfo(base: string, model: string) {
  try {
    const ps = (await call(base, "/api/ps").then((r) => r.json())) as any;
    const m = (ps.models ?? []).find((x: any) => x.name === model || x.model === model);
    return m ? { size: m.size as number, sizeVram: m.size_vram as number, contextLength: m.context_length as number | undefined } : null;
  } catch {
    return null;
  }
}

export async function pullModel(base: string, name: string, signal?: AbortSignal) {
  const res = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Ollama pull → ${res.status} ${await res.text()}`);
  return res.body;
}

export async function deleteModel(base: string, name: string) {
  await call(base, "/api/delete", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name }) });
}

// ---- Catalogue ollama.com (pas d'API officielle : lecture des pages HTML) ----------------------

const decode = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

export async function searchLibrary(query: string) {
  const res = await fetch(`https://ollama.com/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ollama.com → ${res.status}`);
  const html = await res.text();
  return html
    .split(/<li\b/)
    .slice(1)
    .map((block) => {
      const name = block.match(/href="\/library\/([^"]+)"/)?.[1];
      if (!name) return null;
      return {
        name,
        description: decode(block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ""),
        downloads: block.match(/title="([\d,]+) downloads"/)?.[1] ?? "",
        updated: block.match(/title="Updated ([^"]+)"/)?.[1] ?? "",
        capabilities: [...block.matchAll(/bg-indigo-50[^>]*>([^<]+)</g)].map((m) => m[1].trim()),
        sizes: [...block.matchAll(/bg-\[#ddf4ff\][^>]*>([^<]+)</g)].map((m) => m[1].trim()),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
}

export async function libraryTags(name: string) {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(name)) throw new Error(tr("nom de modèle invalide"));
  const res = await fetch(`https://ollama.com/library/${name}/tags`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`ollama.com → ${res.status}`);
  const html = await res.text();
  const seen = new Set<string>();
  const tags = [];
  const re = /href="\/library\/([^"]+)" class="md:hidden[\s\S]*?font-mono">\s*([0-9a-f]+)\s*<\/span>\s*•\s*([^•<]+?)\s*•\s*([^•<]+?) context window/g;
  for (const m of html.matchAll(re)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    // Variantes "cloud" : exécutées chez Ollama (compte requis), pas téléchargeables en local.
    if (/cloud/i.test(m[1]) || !/\d\s*[KMGT]B$/i.test(m[3].trim())) continue;
    tags.push({ name: m[1], digest: m[2], size: m[3].trim(), context: m[4].trim() });
  }
  return tags;
}
