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
import type { NotePageRecord } from "./state";

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

/**
 * What to do with one existing note/page pair, and the three-way base to
 * record once each half has actually been written. A base is only true after
 * the write it describes, so it is assigned in two stages (see applyPairPlan).
 */
export interface PairPlan {
  action: NoteAction;
  /** Body to write into the Zotero note (toZotero, conflict). */
  zoteroBody?: RmParagraph[];
  /** Body to write to the tablet page (toTablet, conflict). */
  tabletBody?: RmParagraph[];
  /**
   * Base that is true once the Zotero half is done: the text the tablet still
   * holds (toZotero: it was copied over; conflict: Zotero now has the merged
   * text and the tablet is untouched, so the merged text is simply pushed on
   * retry instead of being merged again). Undefined keeps the current base.
   */
  baseAfterZotero?: string;
  /** Base that is true once the tablet half is written too. */
  baseAfterTablet: string;
}

export function planPair(
  base: string | undefined,
  zotero: RmParagraph[],
  tablet: RmParagraph[],
): PairPlan {
  const zPlain = plainText(zotero);
  const tPlain = plainText(tablet);
  const action = decide(base, zPlain, tPlain);
  switch (action) {
    case "toTablet":
      return {
        action,
        tabletBody: withTabletStyles(zotero, tablet),
        baseAfterTablet: zPlain,
      };
    case "toZotero":
      return {
        action,
        zoteroBody: tablet,
        baseAfterZotero: tPlain,
        baseAfterTablet: tPlain,
      };
    case "conflict": {
      const merged = mergeConflict(zotero, tablet);
      return {
        action,
        zoteroBody: merged,
        tabletBody: merged,
        baseAfterZotero: tPlain,
        baseAfterTablet: plainText(merged),
      };
    }
    case "none":
      return {
        action,
        baseAfterZotero: zPlain,
        baseAfterTablet: zPlain,
      };
  }
}

/**
 * Record changes that only become true after the single tablet write
 * (updateDocument) succeeds: the base of a pair whose page is rewritten, a
 * newly created pairing, a deleted pairing. Nothing is applied if that write
 * throws, so the persisted records always describe what both sides hold.
 */
export class TabletCommits {
  private effects: (() => void)[] = [];
  defer(effect: () => void) {
    this.effects.push(effect);
  }
  commit() {
    const effects = this.effects;
    this.effects = [];
    for (const effect of effects) effect();
  }
}

/**
 * After updateDocument threw something other than "the tablet changed": the
 * root PUT is never retried, so the server may have applied it with only the
 * response lost. Given the pages that write added and the pages the document
 * really has now (undefined if it could not be read), return the added pages
 * that exist on the tablet. The write is a single root swap, so any of them
 * means all of it landed and the deferred pairings must be recorded; none
 * means it did not, and nothing is committed.
 */
export function landedPages(
  addedPageIds: readonly string[],
  livePageIds: Iterable<string> | undefined,
): string[] {
  if (!livePageIds) return [];
  const live = new Set(livePageIds);
  return addedPageIds.filter((id) => live.has(id));
}

/**
 * Carry out a plan for one pair. `writeZotero` (if any) rewrites the note
 * and records the drawing fields itself; the record is untouched while it
 * throws. The tablet half of the base is deferred to `tabletCommits`.
 */
export async function applyPairPlan(
  rec: NotePageRecord,
  plan: PairPlan,
  writeZotero: (() => Promise<void>) | undefined,
  tabletCommits: TabletCommits,
) {
  if (writeZotero) await writeZotero();
  if (plan.baseAfterZotero !== undefined) rec.base = plan.baseAfterZotero;
  if (plan.tabletBody) {
    tabletCommits.defer(() => {
      rec.base = plan.baseAfterTablet;
    });
  }
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
