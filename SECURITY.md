# Security

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/alfakini/zotero-reMarkable-plugin/security/advisories/new), not in a public issue.

## What the plugin handles

- Pairing stores a reMarkable device token in Zotero's preferences (`extensions.zotero.zoteroremarkable.deviceToken`). Anyone with access to your Zotero profile can use it to reach your reMarkable cloud account. Unpairing clears it, and you can revoke it from your reMarkable account.
- The plugin only talks to the reMarkable cloud. It sends no telemetry and contacts no other servers.
