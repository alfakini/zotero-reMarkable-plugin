# reMarkable Sync for Zotero

A Zotero 8 / 9 / **10** plugin that keeps your PDFs, highlights and notes in sync
with a reMarkable tablet (reMarkable 1, 2, Paper Pro, Paper Pro Move) through the
reMarkable cloud. No external binaries or helper apps.

```
Zotero ──── PDF + Zotero highlights/notes ────▶ reMarkable
       ◀─── highlights, handwriting, typed text ──
```

## What it does

**Zotero → reMarkable**

- Uploads the PDF to a folder on the tablet (default `Zotero`).
- Burns your Zotero annotations into the pages: highlights, underlines, ink, area
  boxes and text boxes, with a small numbered tag next to every annotation that has
  a comment.
- Appends a **"Zotero notes"** page with each comment (numbered to match the tags)
  plus the item's child notes, so you can read them on the tablet.
- When you change annotations or notes in Zotero, the next sync swaps in the new PDF
  **without losing anything you wrote on the tablet**. Only the PDF blob is
  replaced; the reMarkable annotation layers and page map are kept.

**reMarkable → Zotero**

| On the tablet | In Zotero |
| --- | --- |
| Text highlight (select text with the highlighter) | `highlight` annotation with the highlighted text, colour mapped to the nearest Zotero colour |
| Freehand highlighter / shader stroke | `highlight` annotation covering the stroke |
| Pen, pencil, marker, etc. strokes on a PDF page | `ink` annotations, grouped into word/drawing-sized clusters so each can be deleted or recoloured on its own |
| Typed text on a PDF page | `note` (sticky note) annotation |
| Writing on an inserted notebook page, on the appended "Zotero notes" page, or in the margin outside the PDF page | Child **note** with an SVG drawing of the handwriting (plus any typed text) |

Imported annotations get the tag `reMarkable` and author name "reMarkable".

### Safety rules

- Annotations and notes you made in Zotero are **never modified or deleted** by a
  sync. Only objects the plugin imported are updated (when you change them on the
  tablet) or removed (when you erase them on the tablet).
- If you delete an imported annotation in Zotero, it is not re-imported.
  *Re-import reMarkable annotations* brings everything back.
- The original PDF file in Zotero is never changed; the annotated copy only exists
  on the tablet.
- Imported annotations are never burned back into the uploaded PDF, so nothing
  appears twice.

## Install

1. Download the `.xpi` from Releases (or build it, see below).
2. In Zotero: **Tools → Plugins → ⚙ → Install Plugin From File…**
3. **Zotero Settings → reMarkable**: click **Get one-time code…**, sign in, copy
   the 8-letter code from <https://my.remarkable.com/device/browser/connect> and
   click **Connect**.

A reMarkable account needs a paired tablet for the cloud API to work.

## Use

- Right-click items (or PDFs) → **reMarkable → Sync with reMarkable**. This uploads
  them on the first run and syncs both ways afterwards.
- **Tools → Sync with reMarkable** syncs every item already on the tablet, plus all
  items tagged `reMarkable` (the tag can be changed in settings).
- Set **Sync automatically every N minutes** for background sync.
- **reMarkable → Remove from reMarkable** moves the document to the tablet's trash.
  Annotations already imported stay in Zotero.
- **Delete annotations imported from reMarkable** removes the imported objects
  and does not bring them back.

## How it works

- `src/remarkable/cloud.ts` is a small client for the reMarkable sync protocol
  (schema v4 root index, content-addressed blobs with `rm-filename` and CRC32C
  headers, compare-and-swap root updates with retry on generation conflicts).
- `src/remarkable/rmscene.ts` is a reader for v6 `.rm` files: tagged blocks, the
  CRDT scene tree, Line v1/v2 points, GlyphRange highlights, ARGB colours (Paper
  Pro) and typed text. Unknown blocks and fields are skipped by length, so newer
  firmware degrades gracefully.
- `src/sync/convert.ts` maps tablet coordinates to PDF points:
  `x_pt = cropX + w/2 + x·72/226`, `y_pt = cropTop − y·72/226`.
- `src/sync/pdfExport.ts` burns Zotero annotations into the PDF with `pdf-lib`.
- `src/sync/engine.ts` runs a pull, then a push, per attachment. State lives in
  `<Zotero data dir>/remarkable-sync/state.json`.

The device token is stored in Zotero's preferences (`extensions.zotero.zoteroremarkable.deviceToken`).

## Develop

```bash
npm install
cp .env.example .env   # point it at Zotero and a dev profile
npm start              # Zotero with hot reload
npm run build          # .scaffold/build/*.xpi + type-check
npm run test:unit      # parser / protocol / conversion tests (Node)
npm run lint:fix
```

`scripts/pull-preview.mts` downloads a document, runs the import conversion and
writes a PDF with the result drawn on top, which is handy for checking coordinates.

The test fixtures in `test/fixtures` come from the rmscene / zotero-remarkable-sync
projects.

## Limitations

- Rotated PDF pages (`/Rotate`) are not yet handled when mapping coordinates.
- Highlighter strokes drawn freehand become area highlights without text.
- Images and stickers placed on pages (newer firmware) are ignored.
- EPUBs are not supported, only PDFs.

## Credits

Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
and [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit).
The protocol and format knowledge comes from
[rmapi](https://github.com/ddvk/rmapi), [rmapi-js](https://github.com/erikbrinkman/rmapi-js),
[rmscene](https://github.com/ricklupton/rmscene), [rmc](https://github.com/ricklupton/rmc),
[remarks](https://github.com/lucasrla/remarks),
[zotero-remarkable-sync](https://github.com/bpiwowar/zotero-remarkable-sync) and
[obsidian-remarkable-tagged-sync](https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync).

## License

AGPL-3.0-or-later
