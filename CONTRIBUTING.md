# Contributing

See [AGENTS.md](AGENTS.md) for the code layout and the invariants a change must keep.

## Setup

```bash
npm ci
cp .env.example .env   # set the Zotero binary and a dev profile
npm start              # Zotero with hot reload
```

## Checks

CI runs these on every pull request:

```bash
npm run lint:check
npm run test:unit
npm run build
```

## Pull requests

Open them against `main` and fill in the [PR template](.github/pull_request_template.md): the linked issue, what changed, and how to validate it.

## Releases

`npm run release` bumps the version, tags `vX.Y.Z` and pushes. The tag triggers the release workflow, which publishes the `.xpi` and updates `update.json`.
