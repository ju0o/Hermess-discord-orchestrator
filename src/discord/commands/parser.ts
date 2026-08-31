import { AGENT_IDS, DATA_CLASSES, ROLES, type AgentId, type DataClass, type Role } from "../../domain/types.js";

export type ParsedCommand =
  | { kind: "office-pause" }
  | { kind: "office-resume" }
  | { kind: "office-full-stop" }
  | { kind: "runtime-handoff" }
  | { kind: "agent-status" }
  | { kind: "agent-stop"; agentId: AgentId }
  | { kind: "agent-resume"; agentId: AgentId }
  | { kind: "agent-model"; agentId: AgentId; model?: string }
  | { kind: "agent-models"; agentId: AgentId }
  | { kind: "performance-agents"; dataClass: DataClass | "ALL" }
  | { kind: "performance-agent"; agentId: AgentId; dataClass: DataClass | "ALL" }
  | { kind: "performance-role"; role: Role; dataClass: DataClass | "ALL" }
  | { kind: "performance-models"; agentId: AgentId; dataClass: DataClass | "ALL" }
  | { kind: "performance-project"; projectId: string; dataClass: DataClass | "ALL" }
  | { kind: "task-status"; taskId: string }
  | { kind: "task-cancel"; taskId: string }
  | { kind: "task-assign"; payload: Record<string, unknown> };

function tokenize(value: string): string[] {
  return [...value.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map((match) => match[0]!.replace(/^"|"$/g, ""));
}

function keyValues(tokens: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const token of tokens) { const index = token.indexOf("="); if (index > 0) result[token.slice(0, index).toLowerCase()] = token.slice(index + 1); }
  return result;
}

export function parseCommand(input: string): ParsedCommand | undefined {
  const text = input.trim();
  if (/^(?:작업\s*중지|멈춰|pause)$/iu.test(text)) return { kind: "office-pause" };
  if (/^(?:시작해|resume)$/iu.test(text)) return { kind: "office-resume" };
  if (/^(?:완전\s*정지|full[_ -]?stop)$/iu.test(text)) return { kind: "office-full-stop" };
  if (/^TASK_JSON\s+/i.test(text)) {
    const payload = JSON.parse(text.replace(/^TASK_JSON\s+/i, "")) as Record<string, unknown>;
    return { kind: "task-assign", payload };
  }
  const tokens = tokenize(text.replace(/^!/, ""));
  const [group, action, third, ...rest] = tokens.map((token) => token.trim());
  const dataClass = parseDataClass(rest.at(-1) || third) || "REAL_PROJECT";
  if (group?.toLowerCase() === "runtime" && action?.toLowerCase() === "handoff") return { kind: "runtime-handoff" };
  if (group?.toLowerCase() === "agent" && action?.toLowerCase() === "status") return { kind: "agent-status" };
  if (group?.toLowerCase() === "agent" && action?.toLowerCase() === "stop" && AGENT_IDS.includes(third?.toUpperCase() as AgentId)) return { kind: "agent-stop", agentId: third!.toUpperCase() as AgentId };
  if (group?.toLowerCase() === "agent" && action?.toLowerCase() === "resume" && AGENT_IDS.includes(third?.toUpperCase() as AgentId)) return { kind: "agent-resume", agentId: third!.toUpperCase() as AgentId };
  if (group?.toLowerCase() === "agent" && action?.toLowerCase() === "model" && AGENT_IDS.includes(third?.toUpperCase() as AgentId)) return { kind: "agent-model", agentId: third!.toUpperCase() as AgentId, ...(rest[0] ? { model: rest[0] } : {}) };
  if (group?.toLowerCase() === "agent" && action?.toLowerCase() === "models" && AGENT_IDS.includes(third?.toUpperCase() as AgentId)) return { kind: "agent-models", agentId: third!.toUpperCase() as AgentId };
  if (group?.toLowerCase() === "performance" && action?.toLowerCase() === "agents") return { kind: "performance-agents", dataClass: parseDataClass(third) || "REAL_PROJECT" };
  if (group?.toLowerCase() === "performance" && AGENT_IDS.includes(action?.toUpperCase() as AgentId)) return { kind: "performance-agent", agentId: action!.toUpperCase() as AgentId, dataClass: parseDataClass(third) || "REAL_PROJECT" };
  if (group?.toLowerCase() === "performance" && action?.toLowerCase() === "role" && ROLES.includes(third?.toUpperCase() as Role)) return { kind: "performance-role", role: third!.toUpperCase() as Role, dataClass };
  if (group?.toLowerCase() === "performance" && action?.toLowerCase() === "models" && AGENT_IDS.includes(third?.toUpperCase() as AgentId)) return { kind: "performance-models", agentId: third!.toUpperCase() as AgentId, dataClass };
  if (group?.toLowerCase() === "performance" && action?.toLowerCase() === "project" && third) return { kind: "performance-project", projectId: third, dataClass };
  if (group?.toLowerCase() === "task" && action?.toLowerCase() === "status" && third) return { kind: "task-status", taskId: third };
  if (group?.toLowerCase() === "task" && action?.toLowerCase() === "cancel" && third) return { kind: "task-cancel", taskId: third };
  if (group?.toLowerCase() === "task" && action?.toLowerCase() === "assign") {
    const values = keyValues([third || "", ...rest]);
    return { kind: "task-assign", payload: { ...values,
      ...(values.agent && AGENT_IDS.includes(values.agent.toUpperCase() as AgentId) ? { assignedAgent: values.agent.toUpperCase() } : {}),
      ...(values.role && ROLES.includes(values.role.toUpperCase() as Role) ? { role: values.role.toUpperCase() } : {}),
    } };
  }
  return undefined;
}

function parseDataClass(value: string | undefined): DataClass | "ALL" | undefined {
  const item = value?.trim().toUpperCase(); if (item === "ALL") return "ALL";
  return DATA_CLASSES.includes(item as DataClass) ? item as DataClass : undefined;
}
