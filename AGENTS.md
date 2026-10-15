# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

Zotero plugin that syncs PDFs, annotations and notes two-way with a reMarkable tablet via the reMarkable cloud.

## Commands

```bash
npm start              # Zotero with hot reload (needs .env from .env.example)
npm run build          # .scaffold/build/*.xpi + tsc --noEmit
npm run test:unit      # Node unit tests, no Zotero needed
npm test               # tests inside a real Zotero
npm run lint:check     # biome check: lint + format (CI)
npm run lint:fix       # biome check --write
node --import tsx --test --test-name-pattern "<name>" test/unit/*.test.ts
```

Release: `npm run release` bumps the version, tags `vX.Y.Z` and pushes; the tag triggers `.github/workflows/release.yml`, which publishes the GitHub release with `zotero-remarkable-sync.xpi` and refreshes `update.json` on the `release` release (Zotero's update URL).

Install a built `.xpi`: quit Zotero, copy it into the profile's extensions directory, relaunch. Reinstalling from inside Zotero doesn't reliably apply.

## Structure

- `src/remarkable/`: cloud protocol, `.rm` reader/writer and `.content` handling. No Zotero dependency, so it can be unit-tested in Node.
- `src/sync/`: `engine.ts` runs pull (tablet → Zotero), then push (rebuild the PDF and replace only the PDF blob), then note sync. State lives in `<Zotero data dir>/remarkable-sync/state.json`.
- Bump `CONVERTER_VERSION` in `src/sync/convert.ts` when the import output changes; that re-imports existing documents.

## Invariants

- Never modify or delete Zotero objects the user created. Only objects recorded in `DocState.imported` may be changed.
- Imported annotations are never burned back into the uploaded PDF, and the original PDF in Zotero is never changed.
