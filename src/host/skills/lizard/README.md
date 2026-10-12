# Lizard Skill

A skill that teaches your AI agent to run code and agents in Lizard Sandboxes and
to deploy apps on [Lizard](https://lizard.build), through the Lizard CLI.

## Install

```bash
npx skills add lizard-build/skill -g
```

Works with Claude Code, Cursor, Codex, Copilot, Gemini CLI, and other agents that
support the [Agent Skills](https://agentskills.io) format.

## How it works

This repo intentionally stays tiny. The `SKILL.md` here is a **bootstrap**: it

1. loads the full, up-to-date guide (sandboxes and deploys) straight from the CLI
   via `lizard skills get core --json`, installing the CLI first only if it's
   missing (`curl -fsSL https://lizard.build/install.sh | bash` on macOS and
   Linux, `npm install -g @lizard-build/cli` on Windows), and
2. checks for a newer CLI (`lizard upgrade --check`) so the guidance stays
   current.

The authoritative guide ships inside the CLI and is versioned with it, so the
instructions your agent follows are always matched to the installed CLI version -
no stale copies to maintain. Updating the CLI updates the guidance:

```bash
lizard upgrade
```
