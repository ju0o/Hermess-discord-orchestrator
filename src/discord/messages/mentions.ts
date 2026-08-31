import type { AgentId } from "../../domain/types.js";
import type { AgentRegistry } from "../../registry/agentRegistry.js";
import { config } from "../../config/env.js";

export function recipientMention(recipient: string, agents: AgentRegistry, orchestratorId?: string): string {
  if (recipient === "ORCHESTRATOR") return orchestratorId ? `<@${orchestratorId}>` : "@Orchestrator";
  if (recipient === "MAIN") {
    const id = config.DISCORD_MAIN_BOT_ID || config.DISCORD_MAIN_USER_ID;
    return id ? `<@${id}>` : "@Main";
  }
  const record = agents.get(recipient as AgentId);
  return record?.discordBotId ? `<@${record.discordBotId}>` : `@${record?.displayName || recipient}`;
}

export function ensureRecipientMention(content: string, discordBotId: string): string {
  const mention = `<@${discordBotId}>`;
  return content.includes(mention) ? content : `${mention}\n${content}`;
}
