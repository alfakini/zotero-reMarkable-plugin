/**
 * Zotero note HTML for the notes this plugin writes and reads: the title
 * convention of notes paired with tablet pages, conversion between note HTML
 * and tablet paragraphs (paragraphs, headings and bullet lists both ways), and
 * the embedded drawing image. The pairing rules live in noteSync.ts.
 *
 * Convention: a child note whose title (first line) starts with
 * "reMarkable Note" is paired with its own page at the end of the document on
 * the tablet. Pages added on the tablet become notes titled
 * "reMarkable Note <n>". The title stays on the Zotero side; the page holds
 * the note body as typed text, so it can be edited on the tablet.
 */
import { ParagraphStyle, type RmParagraph } from "../remarkable/rmscene";

const NOTE_TITLE_PREFIX = "reMarkable Note";

export function isSyncedNoteTitle(title: string) {
  // Whole words only: "reMarkable notebook" is not "reMarkable Note".
  return /^reMarkable Note(?![\p{L}])/iu.test(title.trim());
}

/** Next free "reMarkable Note <n>" title among existing titles. */
export function nextNoteTitle(existing: string[]) {
  const used = new Set(
    existing
      .map((t) => /^reMarkable Note\s+(\d+)/i.exec(t.trim()))
      .filter(Boolean)
      .map((m) => Number(m![1])),
  );
  let n = 1;
  while (used.has(n)) n++;
  return `${NOTE_TITLE_PREFIX} ${n}`;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function decodeEntities(s: string) {
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

const BLOCK_TAGS = new Set(["p", "li", "pre", "blockquote"]);
const HEADING_RE = /^h[1-6]$/;
const TAG_RE =
  /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:"[^"]*"|'[^']*'|[^>"'])*>/g;
const SCRIPT_CLOSE_RE = /<\/script/gi;
const STYLE_CLOSE_RE = /<\/style/gi;

/**
 * Split Zotero note HTML into its title (first block) and body paragraphs.
 *
 * A small tolerant tokenizer rather than a DOM, so it runs in Node tests. Each
 * block element (headings, p, li, pre, blockquote) becomes one paragraph;
 * nesting depth of ul/ol decides BULLET vs BULLET2. Unknown or unbalanced tags
 * never throw: a block tag always closes the block before it.
 */
export function htmlToParagraphs(html: string): ParsedNote {
  const blocks: RmParagraph[] = [];
  // One entry per open ul/ol; true while an <li> is open at that level.
  const lists: boolean[] = [];
  let quotes = 0;
  let cur: { style: number; text: string; container: boolean } | null = null;

  const bulletStyle = () =>
    lists.length >= 2 ? ParagraphStyle.BULLET2 : ParagraphStyle.BULLET;
  const flush = () => {
    if (!cur) return;
    const text = inlineText(cur.text);
    // Structural wrappers (li/blockquote opened just before a child block)
    // are not paragraphs of their own when empty.
    if (text || !cur.container) blocks.push({ style: cur.style, text });
    cur = null;
  };
  const open = (style: number, container = false) => {
    flush();
    cur = { style, text: "", container };
  };
  const addText = (text: string) => {
    if (!text) return;
    if (!cur && text.trim() && (lists.length || quotes)) {
      // Text after a nested list inside an <li>, or directly in a blockquote.
      open(lists.length ? bulletStyle() : ParagraphStyle.PLAIN);
    }
    if (cur) cur.text += text;
  };

  let pos = 0;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m; m = TAG_RE.exec(html)) {
    addText(html.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[0].startsWith("<!--")) continue;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if ((tag === "script" || tag === "style") && !closing) {
      // Search the original string: lowercasing can change its length.
      const closeRe = tag === "script" ? SCRIPT_CLOSE_RE : STYLE_CLOSE_RE;
      closeRe.lastIndex = pos;
      const end = closeRe.exec(html);
      pos = end ? end.index : html.length;
      TAG_RE.lastIndex = pos;
    } else if (tag === "br") {
      addText(" ");
    } else if (tag === "ul" || tag === "ol") {
      flush();
      if (closing) lists.pop();
      else lists.push(false);
    } else if (closing) {
      if (tag === "li") lists[lists.length - 1] = false;
      if (tag === "blockquote") quotes = Math.max(0, quotes - 1);
      if (HEADING_RE.test(tag) || BLOCK_TAGS.has(tag)) flush();
    } else if (HEADING_RE.test(tag)) {
      open(ParagraphStyle.HEADING);
    } else if (BLOCK_TAGS.has(tag)) {
      if (tag === "li") {
        // A stray <li> outside any list still gets a one-level bullet.
        if (!lists.length) lists.push(false);
        lists[lists.length - 1] = true;
        open(bulletStyle(), true);
      } else if (tag === "blockquote") {
        quotes++;
        open(ParagraphStyle.PLAIN, true);
      } else {
        // Zotero wraps list item content in <p>; it keeps the bullet style.
        const inItem = lists.length > 0 && lists[lists.length - 1];
        open(inItem ? bulletStyle() : ParagraphStyle.PLAIN);
      }
    }
  }
  addText(html.slice(pos));
  flush();
  if (!blocks.length) {
    const text = inlineText(html.replace(/<\/(div|p)>/gi, "\n"));
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

export function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Build Zotero note HTML: title, body paragraphs, then an optional drawing. */
export function paragraphsToHtml(
  title: string,
  body: RmParagraph[],
  drawing?: NoteDrawing,
) {
  let html = `<h1>${escapeHtml(title)}</h1>`;
  // List state: a ul, the li open inside it, and a nested ul inside that li.
  let ul = false;
  let li = false;
  let nested = false;
  const closeNested = () => {
    if (nested) html += "</ul>";
    nested = false;
  };
  const closeItem = () => {
    closeNested();
    if (li) html += "</li>";
    li = false;
  };
  const closeList = () => {
    closeItem();
    if (ul) html += "</ul>";
    ul = false;
  };
  for (const p of trimEmpty(body)) {
    const level2 = p.style === ParagraphStyle.BULLET2;
    const bullet = level2 || p.style === ParagraphStyle.BULLET;
    let text = escapeHtml(p.text);
    if (p.style === ParagraphStyle.CHECKBOX) text = `☐ ${text}`;
    if (p.style === ParagraphStyle.CHECKBOX_CHECKED) text = `☑ ${text}`;
    if (bullet) {
      if (level2 && li) {
        // Nested list inside the parent item, which stays open for siblings.
        if (!nested) html += "<ul>";
        nested = true;
        html += `<li><p>${text}</p></li>`;
      } else {
        // A BULLET2 with no parent item opens a list as a normal bullet.
        closeItem();
        if (!ul) html += "<ul>";
        ul = true;
        html += `<li><p>${text}</p>`;
        li = true;
      }
      continue;
    }
    closeList();
    if (p.style === ParagraphStyle.HEADING) html += `<h2>${text}</h2>`;
    else html += `<p>${text}</p>`;
  }
  closeList();
  if (drawing) {
    html += `<p>${drawingImg(drawing)}</p>`;
  }
  return wrapNoteHtml(html);
}

/** Wrap note body HTML in the div Zotero's note editor expects. */
export function wrapNoteHtml(inner: string) {
  return `<div data-schema-version="9">${inner}</div>`;
}

export interface NoteDrawing {
  key: string;
  width: number;
  height: number;
}

export function drawingImg(d: NoteDrawing) {
  return `<img data-attachment-key="${d.key}" width="${d.width}" height="${d.height}"/>`;
}

function imgTagRe(key: string) {
  return new RegExp(
    `<img\\b[^>]*\\bdata-attachment-key\\s*=\\s*["']${escapeRe(key)}["'][^>]*>`,
    "i",
  );
}

/** Attachment keys of the images embedded in a note's HTML. */
export function embeddedImageKeys(html: string): string[] {
  const keys: string[] = [];
  const re = /<img\b[^>]*\bdata-attachment-key\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) keys.push(m[1]);
  return keys;
}

/**
 * Records from before `drawingKey` existed: the key of the only image in the
 * note body whose attachment is an SVG (`svgKeys`). Undefined when there is
 * none or more than one, so a user-pasted SVG next to another is never
 * mistaken for the plugin's drawing. The result only locates the img to
 * replace; it is never grounds for erasing the attachment.
 */
export function legacyDrawingKey(
  html: string,
  svgKeys: string[],
): string | undefined {
  const svg = new Set(svgKeys);
  const hits = embeddedImageKeys(html).filter((k) => svg.has(k));
  const unique = [...new Set(hits)];
  return unique.length === 1 ? unique[0] : undefined;
}

/**
 * Keys of the SVG attachments the old body embedded, minus `keepKey`: the
 * drawings a rewritten note no longer references. Images of other kinds and
 * SVGs the body does not embed are not listed.
 */
export function staleDrawingKeys(
  html: string,
  svgKeys: string[],
  keepKey?: string,
): string[] {
  const svg = new Set(svgKeys);
  return [...new Set(embeddedImageKeys(html))].filter(
    (k) => svg.has(k) && k !== keepKey,
  );
}

/**
 * Swap only the plugin's drawing in existing note HTML, leaving everything
 * else the user may have added (links, bold, nested lists, other images)
 * untouched. The drawing is found by the attachment key the plugin stored
 * (`oldKey`); `drawing` undefined removes it. If the drawing is missing from
 * the HTML (e.g. the user deleted it), a new one is appended to the note.
 */
export function patchDrawing(
  html: string,
  oldKey: string | undefined,
  drawing?: NoteDrawing,
): string {
  const re = oldKey ? imgTagRe(oldKey) : undefined;
  if (re?.test(html)) {
    if (drawing) return html.replace(re, () => drawingImg(drawing));
    // Drop the image and the paragraph that only held it.
    const only = new RegExp(`<p[^>]*>\\s*${re.source}\\s*</p>`, "i");
    return html.replace(only, "").replace(re, "");
  }
  if (!drawing) return html;
  const block = `<p>${drawingImg(drawing)}</p>`;
  // Insert inside the note's own wrapper div(s), after the last content.
  const wrappers = /^\s*((?:<div\b[^>]*>\s*)*)/i.exec(html)?.[1] ?? "";
  const depth = (wrappers.match(/<div\b/gi) ?? []).length;
  let at = html.length;
  for (let i = 0; i < depth; i++) {
    const close = html.lastIndexOf("</div>", at - 1);
    if (close < 0) break;
    at = close;
  }
  return html.slice(0, at) + block + html.slice(at);
}

/** Comparable form of a body: text only, so formatting tweaks don't conflict. */
export function plainText(body: RmParagraph[]) {
  return trimEmpty(body)
    .map((p) => p.text.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}
