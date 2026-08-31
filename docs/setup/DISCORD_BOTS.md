# Discord bot setup

HERMESS does not create applications or tokens. Create one Discord application and bot for each Worker you want to connect: Codex, Claude Code, OpenCode, and Command Code. A separate orchestrator bot is optional.

For each bot:

1. Create the Application and Bot in the Discord Developer Portal.
2. Enable Message Content Intent. Presence and Server Members intents are not required by the current Runtime path.
3. Invite the bot with `bot` scope and the minimum required view/send/history/thread/embed/attachment permissions.
4. Store its token only in the local `.env` variable documented by `.env.example`.

The Runtime discovers bot IDs after Gateway login. Do not commit identity JSON containing real IDs. Restrict the Runtime to one guild with `DISCORD_GUILD_ID` when appropriate. If the Runtime cannot create its control/status channels, create suitable channels manually and allow discovery to find them.
