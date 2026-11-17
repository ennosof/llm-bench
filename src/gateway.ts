/**
 * Passerelle : un endpoint compatible OpenAI stable (http://127.0.0.1:<port>/gateway/v1) dont le
 * modèle réel se choisit dans l'interface ou en ligne de commande, sans toucher au code ni au .env
 * du projet. Bascule en un clic entre un modèle gratuit (local, offre gratuite) et un modèle payant.
 *
 * Le choix est enregistré dans <dataDir>/gateway.json et relu à chaque requête : la commande
 * `llm-bench gateway use <profil>` agit sur une passerelle déjà lancée.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { peekCalls, peekPrompts, type LlmCall } from "./capture.js";
import { config } from "./config.js";
import type { Tier } from "./config.js";
import { modelKey, parseModelKey, provider, tierOf, unavailable, type ModelRef } from "./providers.js";
import { tr } from "./i18n.js";

export const GATEWAY_CHANNEL = "gateway";

const stateFile = () => join(config().dataDir, "gateway.json");

interface GatewayState {
  target: string | null; // fournisseur/modèle
  profile?: string | null;
  updatedAt?: string;
  /** Dernier modèle utilisé par offre : les boutons Gratuit / Payant y reviennent. */
  lastByTier?: Partial<Record<Tier, string>>;
}

/** "free" (profil) ou "ollama/qwen2.5:7b" → modèle ; null si inconnu. */
export function resolveTarget(value: string): { key: string; profile: string | null } {
  const profiles = config().gateway?.profiles ?? {};
  if (profiles[value]) return { key: profiles[value], profile: value };
  parseModelKey(value);
  return { key: value, profile: null };
}

function readState(): GatewayState {
  try {
    if (existsSync(stateFile())) return JSON.parse(readFileSync(stateFile(), "utf8"));
  } catch {
    // fichier illisible : état par défaut
  }
  const def = config().gateway?.default;
  if (def) {
    try {
      const t = resolveTarget(def);
      return { target: t.key, profile: t.profile };
    } catch {
      // défaut invalide
    }
  }
  return { target: null };
}

export function gatewayTarget(): ModelRef | null {
  const s = readState();
  if (!s.target) return null;
  try {
    const ref = parseModelKey(s.target);
    provider(ref.provider);
    return ref;
  } catch {
    return null;
  }
}

export function setGateway(value: string) {
  const t = resolveTarget(value);
  const ref = parseModelKey(t.key);
  provider(ref.provider); // fournisseur connu
  const why = unavailable(ref.provider);
  if (why) throw new Error(tr("{provider} : {reason}", { provider: ref.provider, reason: why }));
  mkdirSync(config().dataDir, { recursive: true });
  const prev = readState();
  const lastByTier = { ...prev.lastByTier, [tierOf(ref.provider)]: t.key };
  const state: GatewayState = { target: t.key, profile: t.profile, updatedAt: new Date().toISOString(), lastByTier };
  writeFileSync(stateFile(), JSON.stringify(state, null, 2) + "\n");
  return state;
}

// ---- Statistiques depuis le démarrage -----------------------------------------------------------

const stats = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, cost: 0, unknownCost: 0, since: new Date().toISOString() };

export function onGatewayCall(call: LlmCall) {
  stats.calls++;
  if (call.error) stats.errors++;
  stats.promptTokens += call.promptTokens ?? 0;
  stats.completionTokens += call.completionTokens ?? 0;
  if (call.cost == null) stats.unknownCost++;
  else stats.cost += call.cost;
}

export function gatewayStatus() {
  const s = readState();
  const ref = gatewayTarget();
  const profiles = Object.entries(config().gateway?.profiles ?? {}).map(([name, key]) => {
    let tier: string | null = null;
    try {
      tier = tierOf(parseModelKey(key).provider);
    } catch {
      // profil invalide
    }
    return { name, key, tier };
  });
  // Bascule gratuit / payant : dernier modèle utilisé dans l'offre, sinon le premier profil de cette offre.
  const usable = (key?: string) => {
    try {
      return Boolean(key) && !unavailable(parseModelKey(key!).provider);
    } catch {
      return false;
    }
  };
  const quick = Object.fromEntries((["free", "paid"] as Tier[]).map((tier) => {
    const last = s.lastByTier?.[tier];
    const key = usable(last) && tierOf(parseModelKey(last!).provider) === tier ? last! : profiles.find((p) => p.tier === tier && usable(p.key))?.key ?? null;
    return [tier, key];
  }));
  return {
    url: `http://127.0.0.1:${config().port}/gateway/v1`,
    quick,
    target: ref ? modelKey(ref) : null,
    tier: ref ? tierOf(ref.provider) : null,
    profile: s.profile ?? null,
    updatedAt: s.updatedAt ?? null,
    profiles,
    stats,
    calls: peekCalls(GATEWAY_CHANNEL).slice(-50).reverse(),
    prompts: peekPrompts(GATEWAY_CHANNEL),
  };
}
