# Grow for Codex

Let your personal agent help organize your Grow projects, tasks, arcs, and calendar, or review historical tracked-time summaries. Timer controls and time-entry writes are always forbidden.

Requires macOS, Node.js 22 or newer, a Grow account, and Codex with plugin support.

## Install

```sh
codex plugin marketplace add anmorgunov/grow-plugin
codex plugin add grow-planning@grow
```

Open a fresh Codex conversation, select Grow, and ask to connect your account. In Grow Settings, create a personal-agent connection, choose its permissions, and copy the one-time key. Follow the setup skill to save it using the hidden macOS Keychain prompt. Never paste a key into chat.

## Update

Ask “hey bro, can we update Grow?” to use the update skill. It refreshes the existing public Git marketplace and verifies the installed package while preserving your selected connection and Keychain credential. If your older plugin does not know this workflow, give your agent `https://github.com/anmorgunov/grow-plugin` and ask it to follow these instructions.

For an existing `grow` Git marketplace from this repository:

```sh
codex plugin marketplace list --json
codex plugin list --marketplace grow --json
codex plugin marketplace upgrade grow --json
codex plugin list --marketplace grow --json
```

Check the marketplace source first, inspect refresh errors, and verify the installed version and cached manifest. Keep `grow` explicit so other marketplaces are not refreshed. An isolated synthetic Git marketplace test on Codex CLI 0.162.1 confirmed that refresh also updated the installed plugin from 0.2.1 to 0.2.2; no separate install was needed. If your host refreshes the catalog but leaves an existing enabled installation behind, run `codex plugin add grow-planning@grow --json` and verify its installed version and path again. A disabled installation should remain disabled.

Open a fresh Codex conversation and select Grow to load updated skills. For ChatGPT desktop local-marketplace installs, restart the app and test in a new chat; see [official OpenAI packaging guidance](https://developers.openai.com/plugins/build/plugins). After verification, the agent can run the newly installed Grow CLI's `capabilities` command with the existing credential and no environment override. Package updates and server capabilities are checked separately.

If Codex or its plugin commands are unavailable, update a plugin-capable Codex client first. A missing marketplace, local-checkout source, or different repository needs an explicit installation/source decision; do not remove it automatically or claim that a public Git refresh completed. Updating does not require uninstalling, forgetting credentials, reconnecting, or switching environments. Missing or expired credentials remain a separate setup issue.

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
