# reMarkable Sync for Zotero

Read your Zotero papers on a reMarkable. Mark them up by hand. Get your
annotations back in Zotero.

Send a PDF to your tablet with one click. Highlight, write and draw as you
normally would. At the next sync, your marks appear in Zotero as real
annotations that you can search, quote and cite. No cables, no helper apps, no
export and import steps.

Built for the **reMarkable 2 and Paper Pro** and for **Zotero 8, 9 and 10**.
Other reMarkable models that use the same page format should work too, but are
untested.

## Why you will like it

- **Read on the tablet.** Your PDF lands in a `Zotero` folder on the reMarkable.
  Your Zotero highlights and comments come along, and a "Zotero notes" page at
  the end lists your comments and the item's notes.
- **Annotate by hand.** Use the highlighter, the pen or the keyboard. You do not
  change how you work on the tablet.
- **Annotations come back as real Zotero annotations.** Highlights keep their
  text. Handwriting becomes ink annotations (while **Import handwriting** is
  on, which is the default). Typed text becomes sticky notes.
- **Notes that work both ways.** For items with a parent record, a Zotero note
  whose title starts with `reMarkable Note` gets its own page on the tablet.
  Edit it in either place.
- **Your Zotero data stays yours.** The plugin never edits the annotations you
  made. It needs no helper apps, only the plugin and your reMarkable account.

## How it works

**1. Send.** Right-click an item and choose **reMarkable → Sync with
reMarkable**.

**2. Mark up on the tablet.** Highlight text, write in the margins, draw, or
type.

**3. Sync back.** Sync again. Your marks appear in Zotero.

Sync works both ways every time. It first brings in what changed on the tablet.
Then it sends what changed in Zotero, without erasing anything you wrote on the
tablet.

## What comes back

| On the tablet                                     | In Zotero                                         |
| ------------------------------------------------- | ------------------------------------------------- |
| Highlight text                                    | Highlight annotation with the text                |
| Write or draw on a PDF page                       | Ink annotations, one per word or drawing          |
| Type text on a PDF page                           | Sticky-note annotation                            |
| Write in the margin or on the "Zotero notes" page | A child note with your handwriting as a drawing   |
| Add a notebook page at the end of the document    | A new note, `reMarkable Note 1`, synced both ways |

The last two rows need the PDF to belong to a regular Zotero item. For a PDF
that is a standalone attachment, they are skipped. Freehand highlighter strokes
become highlights without text.

## Get started

You need a reMarkable account with a paired tablet. The tablet and Zotero talk
through the reMarkable cloud, so the tablet must be online.

1. Download
   [`zotero-remarkable-sync.xpi`](https://github.com/alfakini/zotero-reMarkable-plugin/releases/latest/download/zotero-remarkable-sync.xpi)
   from the [latest release](https://github.com/alfakini/zotero-reMarkable-plugin/releases/latest).
2. In Zotero, open **Tools → Plugins**, click the gear icon, choose **Install
   Plugin From File…** and select the file.
3. Open **Zotero Settings → reMarkable**. Click **Get one-time code…**, sign in,
   and copy the 8-letter code. Paste it in the settings and click **Connect**.
4. Right-click an item with a PDF and choose **reMarkable → Sync with
   reMarkable**.

To sync again, repeat step 4. Or use **Tools → Sync with reMarkable**, which
syncs every document the plugin has already sent, plus every item carrying the
tag set in **Always sync items tagged** (`reMarkable` by default). To sync in
the background, set **Sync automatically every (minutes, 0 = off)** in the
settings. The shortest interval is 5 minutes.

## Your data stays safe

- **Your annotations and notes are never edited or deleted.** The plugin only
  changes the annotations and notes it imported itself. The one exception is a
  note you title `reMarkable Note`: you chose to sync it, so it follows its
  tablet page.
- **The original PDF in Zotero never changes.** The annotated copy exists only
  on the tablet.
- **Everything from the tablet is labelled.** Imported annotations and notes
  carry the tag `reMarkable import`. If you add tags, or a comment on a
  highlight or ink annotation, later syncs keep them. Sticky notes and notes
  that mirror a tablet page follow the tablet. If you delete one, it stays
  deleted.
- **Nothing shows up twice.** Imported marks are not sent back to the tablet.

## Good to know

- **One computer.** Syncing the same library from two computers duplicates
  documents and annotations.
- **Unofficial.** The plugin uses the reMarkable cloud's sync protocol, which
  reMarkable does not document. A firmware or cloud update can break it.
- **PDFs only.** EPUBs are not supported.
- **Rotated, landscape and unusual page sizes** are untested.

[Read the full list of limitations](docs/development.md#limitations).

## More

- [Developer documentation](docs/development.md): build, test, how it works.
- [Contribute](CONTRIBUTING.md) and [report a security issue](SECURITY.md).
- [Report a problem or ask a question](https://github.com/alfakini/zotero-reMarkable-plugin/issues).
- License: [MIT](LICENSE).

## Credits

Built with [zotero-plugin-scaffold](https://github.com/zotero-plugin-dev/zotero-plugin-scaffold)
and [zotero-types](https://github.com/windingwind/zotero-types); PDFs are written with
[pdf-lib](https://github.com/Hopding/pdf-lib).
The protocol and format knowledge comes from
[rmapi](https://github.com/ddvk/rmapi), [rmapi-js](https://github.com/erikbrinkman/rmapi-js),
[rmscene](https://github.com/ricklupton/rmscene), [rmc](https://github.com/ricklupton/rmc),
[remarks](https://github.com/lucasrla/remarks),
[zotero-remarkable-sync](https://github.com/bpiwowar/zotero-remarkable-sync) and
[obsidian-remarkable-tagged-sync](https://github.com/thomas-hochbichler/obsidian-remarkable-tagged-sync).
Test fixtures from rmscene are MIT-licensed by their author; see
[test/fixtures/README.md](test/fixtures/README.md).
