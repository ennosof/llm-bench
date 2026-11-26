/**
 * Édition textuelle du fichier de config (bench.config.ts) : les modifications faites depuis l'interface
 * réécrivent une propriété sans toucher au reste du fichier (commentaires, mise en forme, code).
 */

/** Indice après une chaîne ou un commentaire commençant en i, sinon i. */
export function skip(text: string, i: number) {
  const ch = text[i];
  if (ch === '"' || ch === "'" || ch === "`") {
    for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
    return i + 1;
  }
  if (ch === "/" && text[i + 1] === "/") {
    const n = text.indexOf("\n", i);
    return n < 0 ? text.length : n;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const n = text.indexOf("*/", i + 2);
    return n < 0 ? text.length : n + 2;
  }
  return i;
}

/** Fin d'une valeur de propriété : virgule ou accolade fermante au niveau 0 (chaînes ignorées). */
export function valueEnd(text: string, from: number) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const j = skip(text, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const ch = text[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) {
      if (depth === 0) return i;
      depth--;
    } else if (ch === "," && depth === 0) return i + 1;
  }
  return text.length;
}

/** Remplace (ou ajoute, ou retire si value null) une propriété du premier niveau d'un objet { … }. */
export function setProp(text: string, open: number, close: number, indent: string, key: string, value: string | null) {
  // Propriété au premier niveau de l'objet, hors chaînes et commentaires.
  let depth = 0, start = -1;
  const keyRe = new RegExp(`^${key}\\s*:`);
  for (let i = open + 1; i < close && start < 0; i++) {
    const j = skip(text, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const ch = text[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    else if (depth === 0 && /[\s{,]/.test(text[i - 1]) && keyRe.test(text.slice(i, i + key.length + 20))) start = i;
  }
  if (start >= 0) {
    let end = valueEnd(text, text.indexOf(":", start) + 1);
    if (value === null) {
      const lineStart = text.lastIndexOf("\n", start) + 1;
      const s = /^\s*$/.test(text.slice(lineStart, start)) ? lineStart : start;
      if (text[end] === "\n") end++;
      return text.slice(0, s) + text.slice(end);
    }
    const trailing = text[end - 1] === "," ? "," : "";
    return text.slice(0, start) + `${key}: ${value}${trailing}` + text.slice(end);
  }
  if (value === null) return text;
  return text.slice(0, open + 1) + `\n${indent}${key}: ${value},` + text.slice(open + 1);
}

export function matchingBrace(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const j = skip(text, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Section `<name>: { … }` du premier niveau de la config (repérée en début de ligne) : accolades et indentation de son contenu. */
export function sectionRange(text: string, name: string) {
  const found = new RegExp(`^([ \\t]*)${name}\\s*:\\s*\\{`, "m").exec(text);
  if (!found) return null;
  const open = found.index + found[0].length - 1;
  return { open, close: matchingBrace(text, open), indent: found[1] + "  " };
}

/** Début de la valeur d'une propriété du premier niveau de l'objet { … } (après « key: »), ou -1. */
export function propValue(text: string, open: number, close: number, key: string) {
  let depth = 0;
  const keyRe = new RegExp(`^${key}\\s*:`);
  for (let i = open + 1; i < close; i++) {
    const j = skip(text, i);
    if (j !== i) {
      i = j - 1;
      continue;
    }
    const ch = text[i];
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth--;
    else if (depth === 0 && /[\s{,]/.test(text[i - 1]) && keyRe.test(text.slice(i, i + key.length + 20))) {
      let v = text.indexOf(":", i) + 1;
      while (/\s/.test(text[v] ?? "")) v++;
      return v;
    }
  }
  return -1;
}
