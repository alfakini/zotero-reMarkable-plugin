/**
 * Two-way sync between Zotero child notes and reMarkable note pages.
 *
 * Convention: a child note whose title (first line) starts with
 * NOTE_TITLE_PREFIX ("reMarkable Note") is paired with its own page at the
 * end of the document on the tablet. Pages added on the tablet become notes
 * titled "reMarkable Note <n>". The title stays on the Zotero side; the page
 * holds the note body as typed text, so it can be edited on the tablet.
 *
 * Supported formatting both ways: paragraphs, headings and bullet lists.
 */
import { ParagraphStyle, type RmParagraph } from "../remarkable/rmscene";

export const NOTE_TITLE_PREFIX = "reMarkable Note";

export function isSyncedNoteTitle(title: string, prefix = NOTE_TITLE_PREFIX) {
  // Whole words only: "reMarkable notebook" is not "reMarkable Note".
  return new RegExp(`^${escapeRe(prefix)}(?![\\p{L}])`, "iu").test(
    title.trim(),
  );
}

/** Next free "reMarkable Note <n>" title among existing titles. */
export function nextNoteTitle(existing: string[], prefix = NOTE_TITLE_PREFIX) {
  const used = new Set(
    existing
      .map((t) =>
        new RegExp(`^${escapeRe(prefix)}\\s+(\\d+)`, "i").exec(t.trim()),
      )
      .filter(Boolean)
      .map((m) => Number(m![1])),
  );
  let n = 1;
  while (used.has(n)) n++;
  return `${prefix} ${n}`;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function inlineText(html: string) {
  return decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, " ")
      .replace(/<img[^>]*>/gi, "")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export interface ParsedNote {
  title: string;
  body: RmParagraph[];
}

/** Split Zotero note HTML into its title (first block) and body paragraphs. */
export function htmlToParagraphs(html: string): ParsedNote {
  const flat = html
    // Zotero wraps list item content in <p>.
    .replace(/<li([^>]*)>\s*<p[^>]*>/gi, "<li$1>")
    .replace(/<\/p>\s*<\/li>/gi, "</li>");
  const blocks: RmParagraph[] = [];
  const re = /<(h[1-6]|p|li|pre|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    const tag = m[1].toLowerCase();
    const text = inlineText(m[2]);
    const style = tag.startsWith("h")
      ? ParagraphStyle.HEADING
      : tag === "li"
        ? ParagraphStyle.BULLET
        : ParagraphStyle.PLAIN;
    blocks.push({ style, text });
  }
  if (!blocks.length) {
    const text = inlineText(flat.replace(/<\/(div|p)>/gi, "\n"));
    if (text) blocks.push({ style: ParagraphStyle.PLAIN, text });
  }
  const [first, ...rest] = blocks;
  // Empty paragraphs are only spacing in Zotero; don't carry them over.
  const body = rest.filter((p) => p.text.trim());
  return { title: first?.text ?? "", body };
}

function trimEmpty(ps: RmParagraph[]) {
  let a = 0;
  let b = ps.length;
  while (a < b && !ps[a].text.trim()) a++;
  while (b > a && !ps[b - 1].text.trim()) b--;
  return ps.slice(a, b);
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build Zotero note HTML: title, body paragraphs, then an optional drawing. */
export function paragraphsToHtml(
  title: string,
  body: RmParagraph[],
  drawing?: { key: string; width: number; height: number },
) {
  let html = `<h1>${escapeHtml(title)}</h1>`;
  let inList = false;
  for (const p of trimEmpty(body)) {
    const bullet =
      p.style === ParagraphStyle.BULLET || p.style === ParagraphStyle.BULLET2;
    if (bullet !== inList) {
      html += bullet ? "<ul>" : "</ul>";
      inList = bullet;
    }
    let text = escapeHtml(p.text);
    if (p.style === ParagraphStyle.CHECKBOX) text = `☐ ${text}`;
    if (p.style === ParagraphStyle.CHECKBOX_CHECKED) text = `☑ ${text}`;
    if (bullet) html += `<li><p>${text}</p></li>`;
    else if (p.style === ParagraphStyle.HEADING) html += `<h2>${text}</h2>`;
    else html += `<p>${text}</p>`;
  }
  if (inList) html += "</ul>";
  if (drawing) {
    html += `<p><img data-attachment-key="${drawing.key}" width="${drawing.width}" height="${drawing.height}"/></p>`;
  }
  return `<div data-schema-version="9">${html}</div>`;
}

/** Comparable form of a body: text only, so formatting tweaks don't conflict. */
export function plainText(body: RmParagraph[]) {
  return trimEmpty(body)
    .map((p) => p.text.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}

/**
 * Body to write to the tablet. Plain Zotero paragraphs keep the style they
 * already have on the tablet (e.g. a heading set there), matched by text.
 */
export function withTabletStyles(zotero: RmParagraph[], tablet: RmParagraph[]) {
  const styleOf = new Map(tablet.map((p) => [p.text.trim(), p.style]));
  return zotero.map((p) =>
    p.style === ParagraphStyle.PLAIN && styleOf.has(p.text.trim())
      ? { ...p, style: styleOf.get(p.text.trim())! }
      : p,
  );
}

export type NoteAction = "none" | "toTablet" | "toZotero" | "conflict";

/** Three-way decision against the text both sides had at the last sync. */
export function decide(
  base: string | undefined,
  zotero: string,
  tablet: string,
): NoteAction {
  if (zotero === tablet) return "none";
  if (base === undefined) return "conflict";
  if (tablet === base) return "toTablet";
  if (zotero === base) return "toZotero";
  return "conflict";
}

/** Keep both versions when each side changed: Zotero's first, then the tablet's. */
export function mergeConflict(zotero: RmParagraph[], tablet: RmParagraph[]) {
  return [
    ...zotero,
    {
      style: ParagraphStyle.HEADING,
      text: "Edited on reMarkable at the same time:",
    },
    ...tablet,
  ];
}
