import { existsSync, readFileSync } from "node:fs";
import type { AgentRegistry } from "../../registry/agentRegistry.js";
import type { Store } from "../../storage/database.js";
import { config } from "../../config/env.js";
import { AGENT_IDS } from "../../domain/types.js";
import { BOT_TYPES, agentToBotType, normalizeBotType, type BotType } from "./types.js";

export interface TrustedBotRecord { botType: BotType; discordBotId?: string; agentId?: string; source: string; state: "RESOLVED" | "UNRESOLVED" | "FALLBACK"; }

export class TrustedBotRegistry {
  constructor(private readonly store: Store, private readonly agents: AgentRegistry, private readonly configured: Partial<Record<BotType, string>> = loadIdentityConfig()) {}

  seed(): void {
    for (const type of BOT_TYPES) this.upsert({ botType: type, source: "registry", state: "UNRESOLVED" });
    for (const agentId of AGENT_IDS) {
      const bot = this.agents.get(agentId); const type = agentToBotType(agentId);
      this.upsert({ botType: type, ...(bot?.discordBotId ? { discordBotId: bot.discordBotId } : {}), agentId,
        source: "agent_registry", state: bot?.discordBotId ? "RESOLVED" : "UNRESOLVED" });
    }
    for (const [rawType, id] of Object.entries(this.configured)) {
      const type = normalizeBotType(rawType); if (type && id) this.upsert({ botType: type, discordBotId: id, source: "config", state: "RESOLVED" });
    }
  }

  upsert(record: TrustedBotRecord): void {
    this.store.db.prepare(`INSERT INTO trusted_bots(bot_type,discord_bot_id,agent_id,source,state,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(bot_type) DO UPDATE SET
      discord_bot_id=COALESCE(excluded.discord_bot_id,trusted_bots.discord_bot_id),
      agent_id=COALESCE(excluded.agent_id,trusted_bots.agent_id),source=excluded.source,state=excluded.state,updated_at=excluded.updated_at`)
      .run(record.botType, record.discordBotId ?? null, record.agentId ?? null, record.source, record.state, this.store.now());
  }

  get(value: string): TrustedBotRecord | undefined {
    const type = normalizeBotType(value); if (!type) return undefined;
    const row = this.store.db.prepare("SELECT * FROM trusted_bots WHERE bot_type=?").get(type) as Record<string, unknown> | undefined;
    return row ? { botType: row.bot_type as BotType, ...(row.discord_bot_id ? { discordBotId: String(row.discord_bot_id) } : {}),
      ...(row.agent_id ? { agentId: String(row.agent_id) } : {}), source: String(row.source), state: row.state as TrustedBotRecord["state"] } : undefined;
  }

  byDiscordId(discordBotId: string): TrustedBotRecord | undefined {
    const rows = this.store.db.prepare("SELECT bot_type FROM trusted_bots WHERE discord_bot_id=?").all(discordBotId) as Array<{ bot_type: string }>;
    // A Discord identity shared by multiple bot types cannot establish sender
    // provenance safely, so ambiguous mappings are rejected rather than guessed.
    if (rows.length !== 1) return undefined;
    return this.get(rows[0]!.bot_type);
  }

  resolveRecipient(value: string, controlFallback = true): TrustedBotRecord | undefined {
    const type = normalizeBotType(value); if (!type) return undefined;
    const direct = this.get(type); if (direct?.discordBotId) return direct;
    if (type === "ORCHESTRATOR" && controlFallback) {
      const asus = this.get("ASUS"); if (asus?.discordBotId) return { ...asus, state: "FALLBACK", source: "orchestrator_fallback" };
    }
    return undefined;
  }

  list(): TrustedBotRecord[] { return BOT_TYPES.map((type) => this.get(type)).filter(Boolean) as TrustedBotRecord[]; }
}

function loadIdentityConfig(): Partial<Record<BotType, string>> {
  const values: Partial<Record<BotType, string>> = {};
  if (existsSync(config.DISCORD_IDENTITY_CONFIG)) {
    try { Object.assign(values, JSON.parse(readFileSync(config.DISCORD_IDENTITY_CONFIG, "utf8"))); } catch { /* invalid optional config is represented as unresolved */ }
  }
  if (config.DISCORD_MAIN_BOT_ID) values.MAIN = config.DISCORD_MAIN_BOT_ID;
  if (config.DISCORD_ASUS_BOT_ID) values.ASUS = config.DISCORD_ASUS_BOT_ID;
  return values;
}
