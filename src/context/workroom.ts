import type { DiscordContextMessage } from "./discord.js";

export function selectWorkroomContext(messages: DiscordContextMessage[], limit = 60): DiscordContextMessage[] {
  const structured = messages.filter((message) => /\[SYMPHONY WORKROOM\]|\[EXPERT JOIN\]|SYMPHONY_EVENT |\b(REVIEW|REVISION_REQUEST|REVISION_RESULT|QA_RESULT|VERDICT|HANDOFF|QUESTION|ANSWER|PROPOSAL|OBJECTION|CLARIFICATION|CONSENSUS|EXPERT_REQUEST|EXPERT_INVITE|EXPERT_RESULT)\b/.test(message.content));
  const latest = messages.slice(-20); const selected = new Map<string, DiscordContextMessage>();
  for (const message of [...structured, ...latest]) selected.set(`${message.timestamp}|${message.author}|${message.content}`, message);
  return [...selected.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit);
}
