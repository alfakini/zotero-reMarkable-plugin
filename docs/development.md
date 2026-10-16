# Development

Everything a contributor needs: how to run the plugin, how a sync works, the
reMarkable protocol notes, the invariants to protect, and the known
limitations. For what the plugin does for users, see the [README](../README.md).
For the pull request workflow and the checks CI runs, see
[CONTRIBUTING.md](../CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](../SECURITY.md).

## Contents

- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Commands](#commands)
- [Repository structure](#repository-structure)
- [Plugin runtime](#plugin-runtime)
- [How a sync works](#how-a-sync-works)
- [Sync state](#sync-state)
- [Cloud protocol](#cloud-protocol)
- [The `.rm` reader and writer](#the-rm-reader-and-writer)
- [Coordinate mapping](#coordinate-mapping)
- [Converter version](#converter-version)
- [Notes and note pages](#notes-and-note-pages)
- [Invariants](#invariants)
- [Testing](#testing)
- [Releasing](#releasing)
- [Installing a built `.xpi`](#installing-a-built-xpi)
- [Dev scripts](#dev-scripts)
- [Limitations](#limitations)
- [Credits](#credits)
- [License](#license)

## Prerequisites

- Node.js 22 (the version CI uses) and npm.
- Zotero 8 or later. `addon/manifest.json` declares support for Zotero 8.0
  through 10.0.x.
- For `npm start`: a Zotero binary and a separate development profile, so your
  real library is not touched. Create the profile with `zotero -p`.
- A reMarkable account with a paired tablet if you want to try the plugin
  against the real cloud.

## Setup

```bash
npm ci
cp .env.example .env   # set the Zotero binary path and the dev profile path
npm start              # Zotero with hot reload
```

`.env` holds `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` and `ZOTERO_PLUGIN_PROFILE_PATH`.
`ZOTERO_PLUGIN_DATA_DIR` is optional; leave it empty to start with the profile's
default data. The comments in `.env.example` explain each variable.

## Commands

| Command              | What it does                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| `npm start`          | Starts Zotero with the plugin and hot reload (needs `.env`).                       |
| `npm run build`      | Builds `.scaffold/build/*.xpi`, then type-checks with `tsc --noEmit`.              |
| `npm run test:unit`  | Node unit tests. No Zotero needed.                                                 |
| `npm run lint:check` | Biome check (lint and format) of the whole repository. CI runs this.               |
| `npm run lint:fix`   | Biome check with fixes applied.                                                    |
| `npm run format`     | Biome format with fixes applied.                                                   |
| `npm run release`    | Bumps the version, commits, tags `vX.Y.Z` and pushes. See [Releasing](#releasing). |

Run one unit test by name:

```bash
node --import tsx --test --test-name-pattern "<name>" test/unit/*.test.ts
```

CI (`.github/workflows/ci.yml`) runs `lint:check`, `test:unit` and `build` on
every pull request to `main`, and uploads the built `.xpi`. The same three
commands are listed in [CONTRIBUTING.md](../CONTRIBUTING.md#checks).

## Repository structure

```
addon/                    Static plugin files, copied into the .xpi
  bootstrap.js            Zotero bootstrap entry points (startup, shutdown)
  manifest.json           Add-on manifest (Zotero 8.0 to 10.0.x)
  prefs.js                Default preferences
  content/                preferences.xhtml and icons
  locale/en-US/           Fluent strings
src/
  index.ts                Bundle entry point: registers the plugin on Zotero
  plugin.ts               The Plugin class: startup, shutdown, menu commands
  service.ts              RemarkableService: pairing, sync commands, auto-sync timer
  ui.ts                   Menus (Zotero.MenuManager) and the preferences pane
  preferences.ts          Behaviour of the preferences pane (pairing)
  prefs.ts                Typed getPref and setPref
  l10n.ts                 t(): Fluent strings
  notify.ts               Progress and notification popups
  remarkable/             Cloud protocol, .rm reader/writer, .content handling.
                          No Zotero dependency, so it runs in Node tests.
    cloud.ts              Sync v3/v4 client and pairing
    rmscene.ts            .rm (v6) reader
    rmwrite.ts            .rm typed-text writer
    content.ts            Page map of a document's .content file
    hash.ts, lru.ts       SHA-256, CRC32C, UUID, byte-bounded cache
  sync/                   Sync logic
    engine.ts             Pull, push and note sync per attachment, plus the
                          pure decisions behind them (needsPull, keysToErase,
                          nextRmDocHash, titleToPush, resolveFolderId)
    convert.ts            Tablet pages to Zotero annotations (CONVERTER_VERSION)
    pdfExport.ts          Builds the PDF sent to the tablet (pdf-lib)
    noteSync.ts, notes.ts Two-way sync of "reMarkable Note" notes
    state.ts              state.json store with backup and recovery, and the
                          registry of detached keys
    zotero.ts             Zotero reads and writes (including mergeAnnotationFields)
    inkFit.ts, mutex.ts   Small pure helpers
    types.ts              Shared types
scripts/                  Dev tools (see Dev scripts)
test/unit/                Node unit tests, fakes and helpers
test/fixtures/            Real .rm files used by the parser tests
typings/                  Generated type declarations for prefs and Fluent ids
zotero-plugin.config.ts   zotero-plugin-scaffold build and release config
biome.json                Lint and format rules
```

`src/remarkable/` and the pure `src/sync` modules (`convert.ts`, `notes.ts`,
`pdfExport.ts`, `inkFit.ts`, `mutex.ts`) do not touch Zotero, so tests call them
directly. `engine.ts`, `noteSync.ts`, `state.ts` and `zotero.ts` use Zotero and
Gecko globals; `test/unit/engineHarness.ts` stubs them for the engine tests, and
`state.ts` takes its file operations as an injectable `StateFileIO`.

## Plugin runtime

The build bundles `src/index.ts` with esbuild into
`content/scripts/zoteroremarkable.js` (the add-on's `addonRef`, see `config` in
`package.json`) and copies `addon/` into the `.xpi`. There is no framework
between Zotero and the plugin:

1. `addon/bootstrap.js` registers the chrome path, loads the bundle and calls
   `Zotero.ZoteroReMarkable.startup(rootURI)`. Its `onMainWindowLoad` and
   `shutdown` hooks call into the same object.
2. `src/index.ts` registers `plugin` (from `src/plugin.ts`) as
   `Zotero.ZoteroReMarkable`.
3. `Plugin.startup` waits for Zotero to be ready, creates the
   `RemarkableService`, loads the sync state, registers the preferences pane
   and the menus (`src/ui.ts`) and starts the auto-sync timer. An unreadable
   state file is logged and does not break startup.
4. Menu items call `Plugin.command`, which checks that the plugin is connected
   and runs the matching `RemarkableService` method (`syncSelected`,
   `syncAll`, `removeImported`, `removeFromTablet`). Errors become a popup
   (`src/notify.ts`).

User-visible strings live in `addon/locale/en-US/*.ftl`. Preference defaults are
in `addon/prefs.js` and are read through `src/prefs.ts`. The build also
generates `typings/i10n.d.ts` and `typings/prefs.d.ts`.

## How a sync works

`src/sync/engine.ts` syncs one PDF attachment at a time. One sync (or remove, or
re-import cleanup) runs at a time; the `Mutex` in `src/sync/mutex.ts` is shared
by every engine instance. For each attachment:

1. **Pull (tablet to Zotero).** If the tablet copy changed (its document hash
   differs from the recorded one), the converter version changed, or the last
   pull left candidates unsaved, the engine downloads the `.content` file and
   the `.rm` pages, parses them and converts them to annotation and note
   candidates. Each candidate is saved on its own. A failure is recorded and
   retried at the next sync without blocking the others. Objects whose source
   is gone from the tablet are erased, but only objects recorded in
   `DocState.imported` (see [Invariants](#invariants)). `needsPull` and
   `keysToErase` in `engine.ts` make these decisions.
2. **Push (Zotero to tablet).** The engine fingerprints the Zotero annotations,
   the notes and the PDF file. If the fingerprint changed, it rebuilds the PDF
   with `pdf-lib`: Zotero annotations are burned into the pages, and when
   "Append a page with Zotero comments and notes to each PDF" is on, a "Zotero notes"
   section is appended. It then replaces only the PDF blob (plus `.content` and
   `.metadata`) and keeps the tablet's `.rm` files and page map. A first sync
   uploads a new document into the configured folder. If the PDF's page count
   changed, the engine uploads a new document and moves the old one to the
   tablet's trash. What was imported from the old document stays in Zotero but
   is detached from tracking (`DocState.detachedImported`, see
   [Sync state](#sync-state)). Renaming the Zotero item renames the tablet
   document.
3. **Note sync.** For attachments with a parent item, `syncNotes` pairs notes
   titled `reMarkable Note …` with notebook pages. See
   [Notes and note pages](#notes-and-note-pages).

Selecting items, `Tools → Sync with reMarkable` (every tracked attachment plus
items carrying the sync tag) and the optional background timer all end in the
same engine call. PDFs of 50 MB or more trigger a warning, because `pdf-lib`
parses and re-serialises the whole file on the main thread.

The device token lives in Zotero's preferences
(`extensions.zotero.zoteroremarkable.deviceToken`), next to `deviceId`, the
folder name, the sync tag and the other settings (defaults in
`addon/prefs.js`).

## Sync state

State is kept in `<Zotero data dir>/remarkable-sync/state.json`
(`src/sync/state.ts`). The shape:

```ts
{
  version: 1,
  docs: { "<libraryID>/<attachmentKey>": DocState },
  folders?: { "<folder name>": "<tablet folder id>" },
  detached?: { "<libraryID>/<attachmentKey>": ["<zotero key>", ...] }
}
```

- `DocState` records the tablet document id and hash, the converter version,
  the fingerprint of what was uploaded, the original page count and page boxes,
  the notebook-page pairings, and `imported`: a map from the tablet item id
  (`page:item`) to the Zotero object the plugin created from it.
- `DocState.detachedImported` holds the Zotero keys imported from an earlier
  tablet document that was replaced because the PDF's page count changed. Their
  tablet keys are gone, so they are not erased, but they stay out of the
  uploaded PDF. It is optional and cleared when the objects are erased.
- `folders` caches the tablet folder id by name. It is optional and absent in
  older files.
- `detached` is a registry of Zotero keys imported from a document that was
  later forgotten (deleted on the tablet, removed from sync, or replaced). It
  outlives the `DocState` so those objects are never mistaken for the user's
  own and never burned into a re-uploaded PDF. It is optional and absent in
  older files.
- A malformed `folders` or `detached` value is dropped, not treated as
  corruption.
- Writes are atomic (temp file, then rename) and an identical save is skipped.
  The first save after each load copies the current file to `state.json.bak`.
- If `state.json` is unreadable, the store loads `state.json.bak`, keeps a
  copy of the bad file as `state.json.corrupt` and restores the main file from
  the backup. The backup can be older than the main file, so restoring can lose
  recent changes.
- A missing `state.json` is a fresh start and does not throw. If `state.json`
  is unreadable and there is no usable backup, loading throws and sync is
  disabled. Nothing is overwritten, and each sync attempt retries the load.
- Each document also stores `lastError` (message and stack of the last failed
  sync) for troubleshooting.

## Cloud protocol

`src/remarkable/cloud.ts` is a small client for the reMarkable sync protocol.

- **Auth.** Pairing exchanges the 8-letter one-time code (from
  `https://my.remarkable.com/device/browser/connect`) for a long-lived device
  token at `/token/json/2/device/new`. The token is validated before it is
  stored. Each session exchanges the device token for a short-lived user token
  and refreshes it before expiry or on a 401. Requests retry with backoff on
  429 and 5xx.
- **Content-addressed blobs.** Every file is a blob addressed by its SHA-256,
  read from and written to `/sync/v3/files/<hash>`. The `rm-filename` header
  carries the file's name in the document. Uploads also send an `x-goog-hash`
  header with the CRC32C of the body.
- **Index files.** A document is an index blob (`<id>.docSchema`) that lists
  its files (`.content`, `.metadata`, `.pdf`, `<id>/<page>.rm`). The root index
  (`root.docSchema`, schema v4) lists every document index. The current root
  comes from `/sync/v4/root` as a hash plus a generation number.
- **Compare-and-swap root updates.** Any change uploads the new blobs, a new
  document index and a new root index, then writes the root pointer
  (`PUT /sync/v3/root` with the hash and the generation it was built on). If
  the generation moved, the server answers 412 and `updateRoot` runs the
  mutation again on the fresh root, up to 5 attempts before it gives up with
  "reMarkable cloud kept changing". The root `PUT` is never retried after a
  network error, because the server may have applied it with only the response
  lost. The engine records a new document id before the commit so the next sync
  can recognise or forget a half-finished upload.
- **When the tablet changed the document meanwhile.** For `replacePdf`,
  `renameDocument` and `trashDocument`, the files to write are derived again
  from the document's current entries, so changes the tablet made in between
  (pages, metadata) are kept. For `updateDocument` (note pages), the writes were
  derived from a page read that cannot be redone, so the call throws "The tablet
  changed this document while syncing" and writes nothing. The next sync
  retries.
- **Caching.** Downloaded `.rm` page blobs are cached by hash in a
  byte-bounded LRU cache (64 MB default), released at the end of each
  attachment and sync.

## The `.rm` reader and writer

- `src/remarkable/rmscene.ts` reads v6 `.rm` files: tagged blocks, the CRDT
  scene tree, Line v1 and v2 points, GlyphRange highlights, ARGB colours (Paper
  Pro) and typed text. Every block and subblock is skipped to its declared
  length, so unknown blocks and extra fields from newer firmware are ignored.
  Images and stickers are not read.
- `src/remarkable/rmwrite.ts` writes typed text into a page the way the tablet
  records it in its text CRDT: existing runs are marked deleted and the new
  text is inserted after them under the plugin's author id. All other blocks
  (strokes, highlights, layers, scene info) are copied byte for byte, so
  handwriting is untouched. The writer is tested only against its own reader.
- `src/remarkable/content.ts` maps a document's `.content` file to page
  references: the page id, the index into the PDF (inserted notebook pages have
  none) and the order shown on the tablet. It handles the newer `cPages` layout
  and the older `pages` plus `redirectionPageMap` layout.

## Coordinate mapping

The tablet renders PDFs at 226 dpi, so one tablet unit is 72/226 PDF points.
`src/sync/convert.ts` maps a tablet point `(x, y)` on a PDF page to PDF user
space with the page's CropBox, recorded at upload time:

```
x_pt = cropX + width/2 + x · 72/226
y_pt = cropTop − y · 72/226        (cropTop = cropY + height)
```

The page's `/Rotate` entry is not applied. Rotated, landscape and
non-Letter/A4 pages are untested.

## Converter version

`CONVERTER_VERSION` in `src/sync/convert.ts` versions the import output. **Bump
it whenever the import output changes.** At the next sync, every tracked
document is pulled and each imported object is re-imported once, updated in
place by its tablet key, even if the tablet content did not change. Comments and
tags the user edited in Zotero are kept. The comment on the constant describes
the current version.

## Notes and note pages

A child note whose title starts with `reMarkable Note` (a whole word, any case)
is paired with its own page at the end of the tablet document
(`src/sync/noteSync.ts`, `src/sync/notes.ts`).

- The note body is written on the page as typed text. Supported formatting both
  ways: paragraphs, headings and bullet lists (two levels). Other markup, such
  as images, is dropped from the page.
- Text typed on the page comes back into the note. Handwriting on the page is
  added to the note as an SVG drawing. Only the drawing attachment the plugin
  created is replaced or erased.
- A notebook page added on the tablet becomes a new note, `reMarkable Note <n>`.
- If both sides changed since the last sync, a three-way merge against the
  recorded base text runs. On a real conflict, both versions are kept under an
  "Edited on reMarkable at the same time" heading.
- Deleting the page on the tablet moves the note to Zotero's trash. Deleting the
  note from the library removes the page. A note that is only in the trash, or
  was moved to another item, keeps its page and pairing, paused, until it is
  restored, moved back or erased.
- Other child notes are not paired. They are listed on the appended "Zotero
  notes" pages.
- Pairings are recorded only after the write that makes them true, so a failure
  never leaves the state ahead of the tablet. The tablet half of a pair's base
  text is queued in `afterCommit` (`applyPairPlan` in `noteSync.ts`) and applied
  only once the single `updateDocument` write succeeds.

## Invariants

These hold for every change. Unit tests cover the main ones.

- **Never modify or delete Zotero objects the user created.** Only objects
  recorded in `DocState.imported` (or the `detached` registry, for cleanup the
  user asked for) may be changed. The one deliberate exception is a note the
  user titled `reMarkable Note`, which is synced by design.
- **Imported annotations are never burned back into the uploaded PDF**, and the
  original PDF in Zotero is never changed. Imported and detached keys are
  excluded when the PDF is built.
- A tablet erase removes only what the plugin imported. If a page cannot be
  parsed, or handwriting import is off, its imported objects are kept.
- A user's edits to an imported annotation's comment and tags survive a
  re-import. The tablet owns geometry, text and colour. For `note` annotations
  the tablet owns the comment too.
- An imported object the user deleted in Zotero is not re-imported, except
  through "Re-import reMarkable annotations".
- Imported annotations and notes carry the tag `reMarkable import` (`IMPORT_TAG`
  in `src/sync/zotero.ts`) and the author name `reMarkable`. The sync tag
  (default `reMarkable`) is a different tag, and must stay different.
- An unreadable state file never gets overwritten.

## Testing

All tests are Node unit tests (`npm run test:unit`, the Node test runner with
`tsx`). They need no Zotero. There are no tests that run inside Zotero: check
UI and startup changes by hand with `npm start`.

- The parser and writer run against real `.rm` files in `test/fixtures`. Three
  come from rmscene, two were written on a Paper Pro for this project (see
  `test/fixtures/README.md`).
- `cloud.test.ts` runs the protocol client against an in-memory fake of the
  sync endpoints, including generation conflicts and retries.
- `test/unit/engineHarness.ts` stubs the Zotero and Gecko globals and provides
  an in-memory tablet and state file. The `engine*.test.ts` files (push, pull
  decisions, locking, removing imported objects) and the note tests
  (`note*.test.ts`) run on it end to end.
- `state.test.ts` covers the state file, its backup and its recovery.
  `serviceConnect.test.ts` covers pairing. `annotationMerge.test.ts`,
  `folderCache.test.ts`, `inkFit.test.ts` and the other small files cover single
  functions.

Add a unit test with every fix. Prefer pure functions in `src/remarkable` and
the pure `src/sync` modules, so they can be tested without Zotero.

## Releasing

```bash
npm run release        # bumps the version; commits, tags vX.Y.Z and pushes
```

[CONTRIBUTING.md](../CONTRIBUTING.md#releases) has the short version.

The pushed tag runs `.github/workflows/release.yml`. It runs the unit tests and
the build, creates the GitHub release `vX.Y.Z` with `zotero-remarkable-sync.xpi`
attached, and updates `update.json` on the `release` release. That file is the
plugin's `update_url`, which Zotero polls for automatic updates. Versions with a
`-` suffix are published as pre-releases (`update-beta.json`).

## Installing a built `.xpi`

`npm run build` writes the file to `.scaffold/build/`. To install it:

1. Quit Zotero.
2. Copy the `.xpi` into the `extensions` directory of the Zotero profile, named
   after the add-on ID: `zotero-remarkable@alfakini.github.io.xpi`.
3. Relaunch Zotero.

Reinstalling from inside Zotero (Tools → Plugins) does not reliably apply a
new build. Use the copy method when you test a build.

## Dev scripts

- `scripts/pull-preview.mts` downloads a document, runs the import conversion
  and writes a PDF with the result drawn on top. It helps when checking
  coordinates. Run it with
  `RM_DEVICE_TOKEN=... npx tsx scripts/pull-preview.mts <docId> <out> [originalPageCount]`.
- `scripts/split-pdf.mts` writes single-page PDFs from a source PDF, for small
  test cases.

## Limitations

- **One machine.** Sync state lives in the Zotero data directory
  (`remarkable-sync/state.json`). Syncing the same library from two computers
  duplicates documents and annotations.
- **Unofficial protocol.** The reMarkable cloud sync protocol and the `.rm`
  format are reverse-engineered and can break with a firmware or cloud change.
  The `.rm` text writer is tested only against its own reader. A paired tablet
  and the cloud are required; there is no USB or local sync.
- **Zotero annotations go one way.** They are burned into the uploaded PDF and
  cannot be edited on the tablet. Annotations imported from the tablet are never
  pushed back.
- **Standalone PDFs** (attachments without a parent item) are synced, but
  margin notes and notebook pages on them are skipped, because Zotero allows
  child notes only under a regular item.
- **Note formatting** is limited to headings, bullet lists and plain text.
  Images and other rich formatting in Zotero notes are not shown on the tablet.
- **Coordinates** are mapped at a fixed 226 dpi. Rotated (`/Rotate`), landscape
  and non-Letter/A4 pages are untested.
- **Large PDFs** are rebuilt on Zotero's main thread, so Zotero can freeze for a
  while. The plugin warns for files of 50 MB or more.
- **A changed page count** (for example, a replaced PDF file) uploads a new
  tablet document and moves the old one to the tablet's trash. Marks already
  imported stay in Zotero but are no longer tracked.
- Freehand highlighter strokes become area highlights without text.
- Images and stickers placed on pages (newer firmware) are ignored.
- EPUBs are not supported, only PDFs.
- Documents moved to the tablet's trash are still synced until they are emptied
  from the trash.
- Group libraries are untested.

## Credits

See [Credits in the README](../README.md#credits).

## License

[MIT](../LICENSE). Test fixtures from rmscene are MIT-licensed by their author;
see [test/fixtures/README.md](../test/fixtures/README.md).
