/** Tag stored in every served deck. The bundle is external, so a client update needs no re-upload. */
export const CLIENT_TAG = '<script src="/assets/live-client.js"></script>\n';

/**
 * Inserts before the last </body> only: decks carry the string inside embedded
 * content too, and the real closing tag comes last.
 */
export function insertBeforeBodyEnd(html: string, snippet: string): string {
  let last = -1;
  for (const match of html.matchAll(/<\/body\s*>/gi)) last = match.index;
  if (last < 0) return html + snippet;
  return html.slice(0, last) + snippet + html.slice(last);
}

/** Makes JSON safe inside a script element: no "<" means no "</script>". */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The exported file: the original deck plus its ink and the offline runtime. */
export function annotatedDeck(original: string, data: unknown, runtime: string): string {
  const snippet =
    `<script type="application/json" id="live-data">${jsonForScript(data)}</script>\n` +
    `<script>${runtime}</script>\n`;
  return insertBeforeBodyEnd(original, snippet);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function deckTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = match?.[1] ? decodeEntities(match[1]).trim() : "";
  return title || undefined;
}

export function hasRevealInitialize(html: string): boolean {
  return html.includes("Reveal.initialize");
}

const RESOURCE_TAG = /<(?:script|link|img|iframe|source|video|audio|embed)\b[^>]*?\s(?:data-src|src|href)\s*=\s*["']([^"']+)["']/gi;
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Lists resources the deck loads from relative paths, which will 404 on the server. */
export function relativeReferences(html: string): string[] {
  // A hostile-looking "<img src=" inside inline JS or CSS is not a reference.
  const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?<\/\2\s*>/gi, "$1");
  const found = new Set<string>();
  for (const match of markup.matchAll(RESOURCE_TAG)) {
    const url = match[1];
    if (url && !ABSOLUTE.test(url)) found.add(url);
  }
  return [...found];
}
