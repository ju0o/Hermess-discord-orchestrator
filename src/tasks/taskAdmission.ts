import { randomUUID } from "node:crypto";
import { AGENT_IDS, DATA_CLASSES, MODEL_TIERS, REASONING_COMPLEXITIES, ROLES, TASK_TYPES, type AgentId, type DataClass, type ModelTier, type ProjectRecord, type ReasoningComplexity, type Role, type TaskRecord, type TaskType } from "../domain/types.js";
import { ROLE_CAPABILITIES } from "../registry/roleRegistry.js";
import type { TaskRepository } from "./repository.js";
import { assertExecutionContract, type ExecutionContract } from "../contracts/executionContract.js";

export interface TaskSubmissionContext {
  owner: string;
  defaultGoal: string;
  projectChannelId?: string;
  threadId?: string;
}

export type TaskActivation = (taskId: string) => Promise<boolean>;

export class TaskAdmission {
  private activation?: TaskActivation;
  constructor(private readonly tasks: TaskRepository) {}

  attachActivation(activation: TaskActivation): void {
    if (this.activation) throw new Error("TASK_ACTIVATION_ALREADY_ATTACHED");
    this.activation = activation;
  }

  status(taskId: string): Pick<TaskRecord, "taskId" | "status"> | undefined {
    const task = this.tasks.get(taskId); return task ? { taskId: task.taskId, status: task.status } : undefined;
  }

  async submit(payload: Record<string, unknown>, context: TaskSubmissionContext): Promise<TaskRecord> {
    const workspace = String(payload.workspace || "").trim();
    if (!workspace) throw new TaskAdmissionError("INVALID_TASK_REQUEST", "workspace is required");
    const projectId = String(payload.projectId || payload.project || "machine-project").trim();
    if (!projectId) throw new TaskAdmissionError("INVALID_TASK_REQUEST", "projectId is required");
    const goal = String(payload.goal || payload.title || context.defaultGoal);
    const validation = String(payload.validation || "tests pass").split(",");
    const executionContract = parseExecutionContract(payload.executionContract ?? payload.execution_contract, { goal, validation });
    const project: ProjectRecord = { projectId, name: projectId, workspace,
      ...(context.projectChannelId ? { discordChannelId: context.projectChannelId } : {}),
      ssotPaths: ["README.md", "AGENTS.md", "docs/PROJECT_STATUS.md"], status: "ACTIVE" };
    this.tasks.upsertProject(project);
    const requiredRoles = parseRoles(payload.required_roles ?? payload.requiredRoles);
    const role = requiredRoles[0] || String(payload.role || "DEVELOPER").toUpperCase() as Role;
    if (!ROLES.includes(role)) throw new TaskAdmissionError("INVALID_TASK_REQUEST", "invalid role");
    const assigned = payload.assignedAgent ? String(payload.assignedAgent).toUpperCase() as AgentId : undefined;
    if (assigned && !AGENT_IDS.includes(assigned)) throw new TaskAdmissionError("INVALID_TASK_REQUEST", "invalid assignedAgent");
    const overrides = parseAgentOverrides(payload.agent_overrides ?? payload.agentOverrides);
    const taskType = parseTaskType(payload.task_type ?? payload.taskType);
    const complexity = parseComplexity(payload.complexity ?? payload.complexity_override);
    const modelTier = parseModelTier(payload.model_tier ?? payload.modelTier);
    const dataClass = parseDataClass(payload.data_class ?? payload.dataClass);
    const modelOverride = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined;
    const task = this.tasks.create({ taskId: String(payload.taskId || randomUUID()), projectId,
      title: String(payload.title || "HERMESS task"), goal,
      role, requiredCapabilities: ROLE_CAPABILITIES[role] || ["coding"], ...(assigned ? { assignedAgent: assigned } : {}),
      status: "QUEUED", workspace, ...(context.threadId ? { threadId: context.threadId } : {}),
      ...(context.projectChannelId ? { parentChannelId: context.projectChannelId } : {}),
      readContext: { projectChannel: true, currentTaskThread: true, decisions: true, agentMemory: true },
      fileScope: String(payload.fileScope || payload.file || "").split(",").filter(Boolean),
      doNot: String(payload.doNot || "force push, history rewrite, credential changes").split(","),
      validation, owner: context.owner, nextOwner: "MAIN", ...(executionContract ? { executionContract } : {}),
      ...(taskType ? { taskType, teamMode: "SEQUENTIAL" as const } : {}),
      ...(requiredRoles.length ? { requiredRoles, teamMode: "SEQUENTIAL" as const } : {}),
      ...(Object.keys(overrides).length ? { agentOverrides: overrides, teamMode: "SEQUENTIAL" as const } : {}),
      ...(complexity ? { complexity, complexityReasons: ["COMPLEXITY_OVERRIDE"], complexitySource: "MANUAL" as const } : {}),
      ...(modelTier ? { modelTierOverride: modelTier } : {}), ...(modelOverride ? { modelOverride } : {}), ...(dataClass ? { dataClass } : {}) });
    try { await this.activation?.(task.taskId); } catch { /* accepted Task stays QUEUED; activation fails closed */ }
    return task;
  }

  async continueTask(taskId: string): Promise<{ task: TaskRecord; continued: boolean }> {
    const before = this.tasks.get(taskId); if (!before) throw new TaskAdmissionError("TASK_NOT_FOUND", "task was not found");
    const task = this.tasks.continueFromWatchdog(taskId);
    if (task.status !== "QUEUED" || before.status !== "WAITING_MAIN") return { task, continued: false };
    try { await this.activation?.(taskId); } catch { /* queue state remains durable and fail-closed */ }
    return { task: this.tasks.get(taskId)!, continued: true };
  }
}

export class TaskAdmissionError extends Error {
  constructor(readonly classification: string, message: string) { super(message); }
}

function parseRoles(value: unknown): Role[] { const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map((item) => String(item).trim().toUpperCase() as Role).filter((item) => ROLES.includes(item)))]; }
function parseTaskType(value: unknown): TaskType | undefined { const item = String(value || "").trim().toUpperCase() as TaskType; return TASK_TYPES.includes(item) ? item : undefined; }
function parseAgentOverrides(value: unknown): Partial<Record<Role, AgentId>> { if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Partial<Record<Role, AgentId>> = {}; for (const [rawRole, rawAgent] of Object.entries(value)) { const role = rawRole.toUpperCase() as Role; const agent = String(rawAgent).toUpperCase() as AgentId;
    if (ROLES.includes(role) && AGENT_IDS.includes(agent)) output[role] = agent; } return output; }
function parseComplexity(value: unknown): ReasoningComplexity | undefined { const item = String(value || "").toUpperCase() as ReasoningComplexity; return REASONING_COMPLEXITIES.includes(item) ? item : undefined; }
function parseModelTier(value: unknown): ModelTier | undefined { const item = String(value || "").toUpperCase() as ModelTier; return MODEL_TIERS.includes(item) ? item : undefined; }
function parseDataClass(value: unknown): DataClass | undefined { const item = String(value || "").toUpperCase() as DataClass; return DATA_CLASSES.includes(item) ? item : undefined; }

function parseExecutionContract(value: unknown, task: Pick<TaskRecord, "goal" | "validation">): ExecutionContract | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskAdmissionError("INVALID_TASK_REQUEST", "invalid executionContract");
  const raw = value as Record<string, unknown>;
  const keys: Array<keyof ExecutionContract> = ["mode", "canRead", "canEditRequiredScope", "canTypecheck", "canTest", "canBuild", "canResetDirtyWorkspace", "canEditUnrelatedScope"];
  if (Object.keys(raw).some((key) => !keys.includes(key as keyof ExecutionContract)) || (raw.mode !== "READ_ONLY_DISCOVERY" && raw.mode !== "IMPLEMENT_AND_VALIDATE")
    || keys.slice(1).some((key) => typeof raw[key] !== "boolean")) throw new TaskAdmissionError("INVALID_TASK_REQUEST", "invalid executionContract");
  try { return assertExecutionContract(raw as unknown as ExecutionContract, task); }
  catch { throw new TaskAdmissionError("INVALID_TASK_REQUEST", "invalid executionContract"); }
}
