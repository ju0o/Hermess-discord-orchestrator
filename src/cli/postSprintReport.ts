// Real, reusable, committed entrypoint for posting the Sprint Report -- formalizes what was
// previously only a one-off scratch script (independent review finding: the report/preferences
// loop was proven only by unit tests and manual scratch scripts, never wired into anything
// reusable). Run with: npx tsx src/cli/postSprintReport.ts
//
// This is still manually invoked, not on an automatic schedule -- Sprint 01 deliberately did
// not enable the Task Dispatcher scheduler (Owner directive: scoped resume only, no sweeping
// unrelated Tasks). Wiring this onto a recurring timer is a reasonable next step once the
// Owner reviews this Sprint's output.
import { config } from "../config/env.js";
import { Store } from "../storage/database.js";
import { gatherSprintReport, renderSprintReport } from "../office/report.js";
import { deriveReportPreferences } from "../office/reportPreferences.js";
import { Client, GatewayIntentBits, ChannelType, type Guild, type TextChannel, type ThreadChannel } from "discord.js";

/** #coding-reports if it exists; otherwise the Sprint 01 V0 interim thread bridge under #coding-control. */
async function resolveReportsSurface(guild: Guild): Promise<TextChannel | ThreadChannel> {
  await guild.channels.fetch();
  const real = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === "coding-reports") as TextChannel | undefined;
  if (real) return real;
  const controlChannel = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === "coding-control") as TextChannel | undefined;
  if (!controlChannel) throw new Error("Neither #coding-reports nor #coding-control exists yet.");
  const activeThreads = await controlChannel.threads.fetchActive();
  const existing = activeThreads.threads.find((t) => t.name.includes("코딩 리포트"));
  if (existing) return existing;
  return controlChannel.threads.create({ name: "📊 코딩 리포트 (임시)", autoArchiveDuration: 1440, reason: "Sprint 01 interim Coding Reports surface" });
}

async function main(): Promise<void> {
  const store = new Store();
  try {
    const sinceIso = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const input = gatherSprintReport(store, sinceIso);
    const preferences = deriveReportPreferences(store);
    const text = renderSprintReport(input, preferences);

    const token = config.botTokens.CLAUDE_CODE;
    if (!token) { console.log(text); console.log("\n(DISCORD_CLAUDE_BOT_TOKEN not configured -- printed only, not posted)"); return; }

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await new Promise<void>((resolve, reject) => { client.once("clientReady", () => resolve()); client.once("error", reject); void client.login(token).catch(reject); });
    try {
      const guild = config.DISCORD_GUILD_ID ? await client.guilds.fetch(config.DISCORD_GUILD_ID) : client.guilds.cache.first();
      if (!guild) throw new Error("No Discord guild available.");
      const surface = await resolveReportsSurface(guild);
      const message = await surface.send(text.slice(0, 1_950));
      console.log(JSON.stringify({ posted: true, surfaceId: surface.id, surfaceName: "name" in surface ? surface.name : undefined, messageId: message.id, preferences }));
    } finally { await client.destroy(); }
  } finally { store.close(); }
}

main().catch((error) => { console.error("postSprintReport failed:", error); process.exitCode = 1; });
