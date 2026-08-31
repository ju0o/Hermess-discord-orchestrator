import { ChannelType, type Client, type Guild, type GuildBasedChannel, PermissionFlagsBits } from "discord.js";
import type { Store } from "../../storage/database.js";
import { isProjectsCategory, normalizeDiscordLabel } from "../workrooms/normalization.js";

export class DiscordDiscovery {
  constructor(private readonly store: Store) {}

  async ensureCodingTeam(guild: Guild): Promise<void> {
    const me = guild.members.me; if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return;
    let category = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && normalizeDiscordLabel(channel.name) === "coding-team");
    category ??= await guild.channels.create({ name: "CODING TEAM", type: ChannelType.GuildCategory, reason: "HERMESS Symphony Coding Team V1" });
    for (const name of ["coding-control", "coding-status", "coding-alerts"]) {
      if (!guild.channels.cache.find((channel) => channel.parentId === category!.id && channel.name === name))
        await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, reason: "HERMESS Symphony Coding Team V1" });
    }
    await this.ensureHumanOffice(guild, category);
  }

  /**
   * Owner-readable human surfaces (Sprint 01: CODING_COMPANY_OFFICE_V0). coding-status stays the
   * machine/runtime log surface untouched -- these are additive, reused if already present.
   */
  async ensureHumanOffice(guild: Guild, category: GuildBasedChannel): Promise<void> {
    const topics: Record<string, string> = {
      "coding-office": "HERMESS Coding Office -- 사람이 읽는 진행 중 작업/미팅 현황",
      "owner-inbox": "HERMESS Owner Inbox -- APPROVAL / DECISION / LEARNING / FRICTION",
      "coding-reports": "HERMESS Coding Reports -- 일일/스프린트 요약",
    };
    for (const [name, topic] of Object.entries(topics)) {
      if (!guild.channels.cache.find((channel) => channel.parentId === category.id && channel.name === name))
        await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, topic, reason: "HERMESS Coding Company Office V0" });
    }
  }

  async reconcile(client: Client): Promise<void> {
    for (const guild of client.guilds.cache.values()) {
      await guild.channels.fetch(); await this.ensureCodingTeam(guild);
      for (const channel of guild.channels.cache.values()) if (channel) this.record(channel);
      const active = await guild.channels.fetchActiveThreads(); for (const thread of active.threads.values()) this.record(thread);
    }
    this.store.upsertRuntimeState("discord:last_discovery", { at: this.store.now() });
  }

  record(channel: GuildBasedChannel): void {
    const now = this.store.now(); const parent = channel.parent;
    const isThread = channel.isThread(); const parentCategory = isThread ? channel.parent?.parent : parent;
    const underProjects = Boolean(parentCategory && isProjectsCategory(parentCategory.name));
    const projectId = underProjects ? normalizeDiscordLabel((isThread ? channel.parent?.name : channel.name) ?? "") || null : null;
    const kind = isThread ? "THREAD" : channel.type === ChannelType.GuildCategory ? "CATEGORY" : "CHANNEL";
    const topic = "topic" in channel && typeof channel.topic === "string" ? channel.topic : undefined;
    this.store.db.prepare(`INSERT INTO discord_mappings(discord_id,guild_id,parent_id,kind,name,project_id,task_id,policy_json,discovered_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET parent_id=excluded.parent_id,
      name=excluded.name,project_id=CASE WHEN discord_mappings.kind='WORKROOM' THEN discord_mappings.project_id ELSE excluded.project_id END,
      task_id=CASE WHEN discord_mappings.kind='WORKROOM' THEN discord_mappings.task_id ELSE NULL END,
      kind=CASE WHEN discord_mappings.kind='WORKROOM' THEN 'WORKROOM' ELSE excluded.kind END,
      policy_json=CASE WHEN discord_mappings.kind='WORKROOM' THEN discord_mappings.policy_json ELSE excluded.policy_json END,updated_at=excluded.updated_at`)
      .run(channel.id, channel.guild.id, channel.parentId ?? null, kind, channel.name, projectId, null,
        JSON.stringify({ inheritParent: isThread, projectDiscovery: underProjects, ...(projectId ? { projectSlug: projectId } : {}), ...(topic ? { topic } : {}) }), now, now);
  }

  remove(discordId: string): void { this.store.db.prepare("DELETE FROM discord_mappings WHERE discord_id=? AND kind!='WORKROOM'").run(discordId); }
}
