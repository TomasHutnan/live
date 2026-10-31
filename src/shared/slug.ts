export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "dashboard",
  "controls",
  "api",
  "ws",
  "healthz",
  "assets",
]);

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && !RESERVED_SLUGS.has(slug);
}

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // č -> c
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 38)
    .replace(/-+$/, "");
}

/**
 * Suggests "<name>-a" from a deck filename, moving on to -b, -c... past slugs
 * already taken, because each seminar group gets its own session.
 * Quarto's default index.html says nothing, so the title stands in for it.
 */
export function suggestSlug(filename: string, title: string, taken: ReadonlySet<string> = new Set()): string {
  const stem = filename.replace(/\.html?$/i, "");
  const base = (stem.toLowerCase() === "index" ? "" : slugify(stem)) || slugify(title) || "deck";
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    const slug = `${base}-${letter}`;
    if (!taken.has(slug)) return slug;
  }
  return base;
}
