# HERMESS Discord Orchestrator — Public Preview

HERMESS Discord Orchestrator is a local Runtime that coordinates approved coding Tasks through Discord, SQLite state, and configurable CLI-based Workers. It is the Discord-facing Runtime component of the wider HERMESS Company OS; it is not the Company OS supervisor itself.

## Public Preview status

This release is an early Public Preview. Interfaces, Worker compatibility, recovery behavior, and operational guidance may change. Run it only on a machine and Discord server where you accept local automation risk. Do not use production credentials or production repositories for first setup.

## Prerequisites

- Windows 10/11 for the supported setup.
- Node.js `>=22.13.0` and npm.
- A Discord application/bot with Message Content Intent enabled.
- At least one supported Worker CLI installed and authenticated as the same OS user that runs HERMESS.
- A local Git workspace that the Runtime may access.

## Clone and install

```powershell
git clone https://github.com/ju0o/Hermess-discord-orchestrator.git
Set-Location .\Hermess-discord-orchestrator
npm install
npm run check
```

## Configuration

```powershell
Copy-Item .env.example .env
```

Edit `.env` locally. Never commit it. Set a writable `HERMESS_ROOT`, `HERMESS_PROJECTS_ROOT`, and the Discord bot token variables for the Workers you intend to use. Paths may be absolute or relative to the checkout. Keep the control token unset unless a trusted local caller is required.

Optional JSON examples are in `config/discord-identities.example.json` and `config/project-workspaces.example.json`. Copy them to local filenames only when needed; do not commit real IDs or local workspace paths.

## Discord setup

For each Worker bot:

1. Create an Application and Bot in the Discord Developer Portal.
2. Enable Message Content Intent.
3. Invite the bot with `bot` scope and only the channel/thread permissions it needs: view, send, thread send/history, thread creation, embeds, and attachments.
4. Put the token in the matching local `.env` variable.

The Runtime discovers the connected bot identities. Set `DISCORD_GUILD_ID` only if the Runtime must be restricted to one guild. See `docs/setup/DISCORD_BOTS.md` for the permission details.

## Supported Workers and providers

The current supported Worker surfaces are Codex, Claude Code, OpenCode, and Command Code. Install each CLI separately, authenticate it outside this repository, and set its executable name/path in `.env` (`CODEX_CLI`, `CLAUDE_CODE_CLI`, `OPENCODE_CLI`, `COMMAND_CODE_CLI`). The Runtime does not copy or manage CLI credential files. The optional Hermes control transport is configured with `HERMES_CLI` and the local profile setting.

Use only the Worker/CLI combinations supported by the installed tool. Provider/model availability is reported by health checks and is not assumed from configuration alone.

## Start and verify

For the first run:

```powershell
npm start
```

The process must remain running while Discord is in use. In a second terminal:

```powershell
npm run health
```

Health output distinguishes missing CLI authentication, missing bot configuration, and reachable services. A successful HTTP/control response alone is not proof that a Worker completed a Task.

## Stop and restart

In the interactive Runtime terminal, press `Ctrl+C` and wait for the shutdown message. Start it again with `npm start`. Do not kill the process or delete the SQLite files while it is running. The optional Windows logon task is documented in `docs/operations/WINDOWS_24X7.md` and should be configured only after interactive startup works.

## Known limitations

- This is a Windows-first Public Preview.
- Worker CLI installation, login, model availability, and provider quotas remain external prerequisites.
- Discord bot identity discovery and dynamic workroom behavior are partial.
- Runtime recovery, session restoration, and ambiguous Discord delivery reconciliation are bounded rather than complete.
- Main Hermes integration is optional and is not required for the basic local Runtime path.
- No guarantee is made for unattended operation, production deployment, or arbitrary third-party agents.

## Security and reporting

Never report tokens, cookies, session files, private webhook URLs, or raw private logs in Issues or PRs. For a suspected vulnerability, open a private security report through the repository's GitHub security contact if enabled; otherwise contact the repository maintainers privately before disclosure.

## Contributing

Open an Issue with a minimal reproduction and redacted logs. For changes, use a fork or feature branch, keep the change scoped, add or update focused tests, run `npm run check`, and submit a PR for review. Do not include `.env`, runtime databases, local paths, Discord IDs, or private operational evidence.

## Relationship to HERMESS Company OS

Company OS provides the broader governance and supervisory context. This repository provides the local Discord Orchestrator Runtime and its Worker/Task coordination surfaces. The two repositories may be deployed separately; this README documents only the executable path for this repository.
