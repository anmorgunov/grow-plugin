# Grow for Codex

Let your personal agent help organize your Grow projects, tasks, arcs, and calendar, or review historical tracked-time summaries. Timer controls and time-entry writes are always forbidden.

Requires macOS, Node.js 22 or newer, a Grow account, and Codex with plugin support.

## Install

```sh
codex plugin marketplace add anmorgunov/grow-plugin
codex plugin add grow-planning@grow
```

Open a fresh Codex conversation, select Grow, and ask to connect your account. In Grow Settings, create a personal-agent connection, choose its permissions, and copy the one-time key. Follow the setup skill to save it using the hidden macOS Keychain prompt. Never paste a key into chat.

If you already registered a marketplace named `grow` from a local checkout, remove that marketplace before adding this one:

```sh
codex plugin marketplace remove grow
```

Reinstalling the plugin preserves your existing origin-specific Keychain credential. A new or expired connection needs setup again.

## Try it

- “Review my projects. Which ones look ready to complete or move to the backlog?”
- “What did I work on last week?”
- “Help me make these task names more actionable.”
- “Help me plan my week.”

The connection permissions determine what the agent can read or change. Task completion, cancellation, and deferral have a separate permission. Revoke access at any time in Grow Settings.

## Local development

Use the setup skill with `--connection local --port PORT` to connect to a local server. Local and production credentials are separate. Production uses `https://grow.ischemist.com`; local connections use loopback only.

## Contributing

```sh
npm test
```

This repository owns the standalone plugin package, skills, and dependency-free HTTP client. The Grow application and API are maintained separately. No app source, database dumps, or credentials belong here. The plugin uses Grow’s versioned planning HTTP API; it does not run an MCP server or background scheduler.

The manifest is `plugins/grow-planning/plugin.json`; the installation catalog is `.agents/plugins/marketplace.json`. Update the plugin version when publishing package changes so hosts can refresh their cached installation.
