import type { AgentId, AgentRecord, Role, TaskRecord } from "../domain/types.js";
import { agentToBotType, type NativeEnvelope } from "./control/types.js";
import { projectProtectedInvariants } from "../contracts/executionContract.js";
import { continuationDispatchPayload, type DurableContinuationIntent } from "../runtime/continuationIntent.js";

export interface AgentDispatchContract {
  taskId: string;
  projectId: string;
  threadId: string;
  workroomId?: string;
  round: number;
  role: Role;
  executionMode: string;
  goal: string;
  originalGoal: string;
  continuationIntent?: DurableContinuationIntent;
  scope: string[];
  validation: string[];
  protectedInvariants: string[];
  authorityClass: string;
  handoffFrom: string;
  expectedResponse: string[];
}

export interface ResolvedAgentIdentity {
  agentId: AgentId;
  botType: ReturnType<typeof agentToBotType>;
  discordBotUserId: string;
  discordMention: string;
}

export function resolveAgentIdentity(agent: AgentRecord | undefined): ResolvedAgentIdentity {
  if (!agent?.discordBotId || !/^\d{17,20}$/.test(agent.discordBotId)) throw new Error("AGENT_DISCORD_IDENTITY_UNRESOLVED");
  return { agentId: agent.agentId, botType: agentToBotType(agent.agentId), discordBotUserId: agent.discordBotId,
    discordMention: agent.discordMention || `<@${agent.discordBotId}>` };
}

export function contractFromTask(task: TaskRecord, role: Role, agent: AgentRecord, round: number, handoffFrom = "ASUS", continuationIntent?: DurableContinuationIntent): AgentDispatchContract {
  if (!task.threadId) throw new Error("TASK_THREAD_REQUIRED");
  const contract = task.executionContract;
  return { taskId: task.taskId, projectId: task.projectId, threadId: task.threadId, round, role,
    ...(task.threadId ? { workroomId: task.threadId } : {}), executionMode: contract?.mode || "READ_ONLY_DISCOVERY",
    goal: continuationIntent?.instruction ?? task.goal, originalGoal: task.goal, ...(continuationIntent ? { continuationIntent } : {}),
    scope: task.fileScope, validation: task.validation, protectedInvariants: projectProtectedInvariants(contract || { mode: "READ_ONLY_DISCOVERY", canRead: true, canEditRequiredScope: false, canTypecheck: false, canTest: false, canBuild: false, canResetDirtyWorkspace: false, canEditUnrelatedScope: false }, task.doNot),
    authorityClass: task.authority?.authorityClass || "AUTO_DELEGATED", handoffFrom,
    expectedResponse: ["ACK", "ROLE_CLAIM", "WORK_START", "RESULT / REVIEW"] };
}

export function buildTypedAgentDispatch(task: TaskRecord, agent: AgentRecord, role: Role, round: number, handoffFrom = "ASUS", continuationIntent?: DurableContinuationIntent): { identity: ResolvedAgentIdentity; envelope: NativeEnvelope } {
  const identity = resolveAgentIdentity(agent); const contract = contractFromTask(task, role, agent, round, handoffFrom, continuationIntent);
  return { identity, envelope: { event_type: "TASK", task_id: task.taskId, sender: "ORCHESTRATOR", recipient: identity.botType,
    role, round, message_id: `dispatch:${task.taskId}:${role}:${round}`, thread_id: contract.threadId, created_at: new Date().toISOString(),
    payload: { task_id: contract.taskId, project_id: contract.projectId, workroom_id: contract.workroomId, thread_id: contract.threadId,
      round: contract.round, role: contract.role, execution_mode: contract.executionMode,
      ...continuationDispatchPayload(contract.originalGoal, contract.continuationIntent), scope: contract.scope,
      validation: contract.validation, protected_invariants: contract.protectedInvariants, authority_class: contract.authorityClass,
      handoff_from: contract.handoffFrom, expected_response: contract.expectedResponse } } };
}

export function assertTaskThread(threadId: string | undefined, taskThreadId: string | undefined): void {
  if (!threadId || !taskThreadId || threadId !== taskThreadId) throw new Error("TASK_THREAD_TARGET_REQUIRED");
}
