import { ChannelType, type Client, type TextChannel } from "discord.js";
import type { Store } from "../../storage/database.js";
import type { AgentRegistry } from "../../registry/agentRegistry.js";

export class StatusUi {
  constructor(private readonly store: Store, private readonly agents: AgentRegistry) {}
  render(): string {
    const lines = ["**SYMPHONY CODING TEAM**", ""];
    for (const agent of this.agents.list()) {
      lines.push(`**${agent.displayName}**`, `${agent.status} · ${agent.health}`);
      if (agent.currentTask) lines.push(`Task: ${agent.currentTask}`);
      if (agent.currentRole) lines.push(`Role: ${agent.currentRole}`);
      if (agent.currentTask) {
        const workroom = this.store.db.prepare("SELECT thread_id,thread_name FROM workrooms WHERE task_id=?").get(agent.currentTask) as { thread_id: string; thread_name: string } | undefined;
        if (workroom) lines.push(`Workroom: ${workroom.thread_name} (<#${workroom.thread_id}>)`);
      }
      lines.push("");
    }
    lines.push(`Updated: ${new Date().toISOString()}`); return lines.join("\n");
  }
  async update(client: Client): Promise<void> {
    const channel = client.channels.cache.find((candidate) => candidate.type === ChannelType.GuildText && candidate.name === "coding-status") as TextChannel | undefined;
    if (!channel) return;
    const key = `discord:status_message:${channel.id}`; const messageId = this.store.getRuntimeState<string>(key);
    if (messageId) { try { const message = await channel.messages.fetch(messageId); await message.edit(this.render()); return; } catch { /* recreate */ } }
    const message = await channel.send(this.render()); this.store.upsertRuntimeState(key, message.id);
  }
}
