---
name: grow-setup
description: Connect the Grow planning plugin to a local or production account using a scoped agent credential stored in macOS Keychain.
---

This plugin runs on macOS with Node.js 22 or newer and network access. Its packaged CLI is `../../scripts/grow.mjs` relative to this skill directory. Resolve that path from the installed skill location; keep the absolute CLI path in composed scripts.

Have the user open Grow's agent connection settings, create a named connection, choose capabilities and expiry, and copy the one-time key. They run this themselves in an interactive terminal:

```sh
node /absolute/path/to/grow.mjs setup --connection production
```

For local development use `--connection local --port PORT`, using the actual local server port. The key is bound in Keychain to this exact origin. The CLI invokes macOS `security` with its hidden password prompt. Do not execute setup for the user, read their clipboard, ask them to paste the key into chat, or supply a password argument. Each origin needs its own credential. Production is fixed to `https://grow.ischemist.com`; local requests go only to `127.0.0.1`.

Successful setup remembers the chosen connection and local port. After setup, run `capabilities` without changing environment flags. For an existing Keychain entry after upgrading the plugin, reuse it with `select --connection local --port PORT` or `select --connection production`; this authenticates the existing key and remembers the endpoint without another hidden-password prompt. Only change the selected environment when the user requests it. A failed connection never authorizes a fallback to another endpoint. Missing permissions require the user to edit the connection in Grow. Revocation happens in Grow; `forget` removes only the origin-bound Keychain entry and keeps the selected endpoint and remembered local port. Commands then fail before HTTP when that credential is missing; they never switch to another endpoint.

Keys are not isolated from other shell programs running as the user. This client reduces accidental exposure; server capabilities enforce authority, including the timer ban. Do not claim that the plugin schedules unattended work or has installed an MCP server.
