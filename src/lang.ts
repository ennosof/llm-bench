/**
 * Détection de la langue d'un texte, sans dépendance : écriture (arabe, cyrillique, CJK…) puis, pour
 * l'alphabet latin, mots outils les plus fréquents de chaque langue et lettres caractéristiques.
 *
 * Fiable dès une phrase ; un texte de moins de trois mots (« ok », « Bonjour ») renvoie souvent null.
 */

export const LANGUAGES = ["fr", "en", "es", "de", "it", "pt", "nl", "ar", "ru", "zh", "ja", "ko", "he", "el"] as const;
export type Language = (typeof LANGUAGES)[number];

// Mots outils fréquents et peu ambigus entre langues voisines (fr / es / it / pt partagent « de », « la »…).
const WORDS: Record<string, string> = {
  fr: "le les des du un une est et en que qui dans pour pas sur avec ce cette sont vous nous je tu il elle ils au aux ou mais plus très votre vos notre nos être avoir fait peut aussi bonjour merci oui non chambre hôtel quel quelle où voici voilà ces leur leurs été êtes c'est n'est j'ai qu'il s'il est-ce moi toi seulement cherche trouve veux voudrais ajoute peux pouvez",
  en: "the and is are of to in that it for on with as this be you your we our they have has not but what which at by from or an will can would there their was were do does hello thanks yes no room hotel where how i'm it's don't can't i'd please find me my",
  es: "el los las del una es y en que por para con no se su sus está están muy pero más como también hola gracias sí habitación dónde cómo usted ustedes nosotros este esta hay",
  de: "der die das und ist sind nicht ein eine einen mit auf für von zu den dem des im ich sie wir es auch oder aber wie was hallo danke ja nein zimmer wo sehr bitte",
  it: "il gli della delle di che è e per con non sono una uno nel nella anche come più ma questo questa ciao grazie sì camera dove ho hai siamo",
  pt: "o os as do da dos das um uma é e em que para com não são está estão mas muito também como você vocês olá obrigado sim quarto onde nós isso",
  nl: "het een is zijn van in op met voor niet dat die ook maar wat hoe waar ik je jij wij u hallo dank ja nee kamer heel",
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([l, w]) => [l, new Set(w.split(" "))]));
// Poids d'un mot : 1 s'il est propre à une langue, 1/n s'il appartient à n listes (« des » : français et allemand).
const WEIGHT = new Map<string, number>();
for (const set of Object.values(SETS)) for (const w of set) WEIGHT.set(w, (WEIGHT.get(w) ?? 0) + 1);

// Lettres propres à une langue (bonus léger).
const LETTERS: Array<[string, RegExp]> = [
  ["fr", /[èêëàâçùûœîô]/g], ["es", /[ñ¿¡]/g], ["de", /[äöüß]/g], ["pt", /[ãõ]/g], ["it", /\b[a-z]+[àèìòù]\b/g],
];

// Écritures non latines : la proportion de caractères suffit.
const SCRIPTS: Array<[Language, RegExp]> = [
  ["ar", /[؀-ۿ]/g], ["ru", /[Ѐ-ӿ]/g], ["he", /[֐-׿]/g], ["el", /[Ͱ-Ͽ]/g],
  ["ko", /[가-힯]/g], ["ja", /[぀-ヿ]/g], ["zh", /[一-鿿]/g],
];

export interface Detection {
  lang: Language | null;
  /** Part des mots reconnus pour la langue retenue (0 à 1) ; 1 pour une écriture non latine. */
  confidence: number;
}

export function detectLanguage(input: string): Detection {
  const text = String(input ?? "").replace(/https?:\/\/\S+|`[^`]*`|\{\{[^}]*\}\}/g, " ");
  const letters = text.replace(/[^\p{L}]/gu, "").length;
  if (!letters) return { lang: null, confidence: 0 };

  // Japonais avant chinois : un texte japonais contient aussi des kanji.
  for (const [lang, re] of SCRIPTS) {
    const n = text.match(re)?.length ?? 0;
    if (n / letters > (lang === "ja" ? 0.1 : 0.3)) return { lang, confidence: 1 };
  }

  const words = text.toLowerCase().match(/\p{L}+(?:'\p{L}+)?/gu) ?? [];
  const scores: Record<string, number> = {};
  for (const [lang, set] of Object.entries(SETS)) scores[lang] = words.filter((w) => set.has(w)).reduce((n, w) => n + 1 / WEIGHT.get(w)!, 0);
  if (words.length < 3) {
    // Un ou deux mots (« Bonjour », « C'est la 55120 ») : retenu seulement si une seule langue reconnaît un mot.
    const hits = Object.entries(scores).filter(([, n]) => n > 0);
    return hits.length === 1 && words.some((w) => w.length > 3) ? { lang: hits[0][0] as Language, confidence: 0.5 } : { lang: null, confidence: 0 };
  }
  for (const [lang, re] of LETTERS) scores[lang] += Math.min(3, (text.toLowerCase().match(re)?.length ?? 0) * 0.5);
  const [best, second] = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!best[1] || best[1] === second[1]) return { lang: null, confidence: 0 };
  return { lang: best[0] as Language, confidence: Math.min(1, best[1] / words.length) };
}

/**
 * Texte à analyser dans une réponse : le texte brut, ou, pour une réponse JSON, ses chaînes rédigées
 * (au moins trois mots) — les clés et les codes (« search », « no_results ») fausseraient la détection.
 */
export function proseOf(text: string, json: unknown): string {
  if (json === null || typeof json !== "object" || !/^\s*[[{]/.test(text)) return text;
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") { if (v.trim().split(/\s+/).length >= 3) out.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(json);
  return out.join("\n");
}
