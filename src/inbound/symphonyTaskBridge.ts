import path from "node:path";
import { ROLE_CAPABILITIES } from "../registry/roleRegistry.js";
import { DATA_CLASSES, TASK_TYPES, type DataClass, type ProjectRecord, type Role, type TaskType } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import type { TaskRepository } from "../tasks/repository.js";
import { normalizeDiscordLabel } from "../discord/workrooms/normalization.js";
import { assertExecutionContract, effectiveExecutionContract, projectProtectedInvariants, type ExecutionContract } from "../contracts/executionContract.js";
import { classifyAuthority, type AuthorityDecision } from "../authority/delegatedAuthority.js";
import { WorkspaceRegistry } from "../registry/workspaceRegistry.js";

export interface ExternalSymphonyTask {
  taskId: string;
  taskType: string;
  dataClass: string;
  workspace: string;
  projectId?: string;
  title: string;
  goal: string;
  sourceMessageId: string;
  sourceChannelId: string;
  authorId: string;
  recipientId: string;
  executionHold?: boolean;
  threadId?: string;
  parentChannelId?: string;
  executionContract?: ExecutionContract;
  round?: number;
  retryApproval?: boolean;
  authority?: AuthorityDecision;
}

export interface ExternalTaskRegistration {
  taskId: string;
  state: string;
  created: boolean;
  projectId: string;
  ackMessageId?: string;
}

interface InboxRow {
  source_message_id: string; task_id: string; state: string; ack_message_id: string | null; execution_hold?: number;
}

const DEFAULT_ROLE: Record<TaskType, Role> = {
  FEATURE: "DEVELOPER", BUG: "DEBUGGER", REFACTOR: "REFACTORER", ARCHITECTURE: "ARCHITECT",
  QA_ONLY: "QA", REVIEW_ONLY: "REVIEWER", MCP: "MCP_SPECIALIST", VALIDATION: "QA",
  SCRIPT: "DEVELOPER", UNKNOWN: "DEVELOPER",
};

export class SymphonyTaskBridge {
  private readonly workspaces: WorkspaceRegistry;

  constructor(private readonly store: Store, private readonly tasks: TaskRepository, workspaces?: WorkspaceRegistry) {
    this.workspaces = workspaces || new WorkspaceRegistry(store);
  }

  register(input: ExternalSymphonyTask): ExternalTaskRegistration {
    validate(input);
    const prior = this.store.db.prepare("SELECT * FROM external_task_inbox WHERE source_message_id=? OR task_id=?")
      .get(input.sourceMessageId, input.taskId) as InboxRow | undefined;
    if (prior) {
      const existing = this.tasks.get(prior.task_id);
      if (!existing) throw new Error("BRIDGE_INTEGRITY_ERROR: inbox references a missing Task");
      if (input.executionHold) this.hold(input.sourceMessageId);
      return { taskId: existing.taskId, state: input.executionHold ? "RECONCILIATION_HOLD" : prior.state, created: false, projectId: existing.projectId,
        ...(prior.ack_message_id ? { ackMessageId: prior.ack_message_id } : {}) };
    }
    const existingTask = this.tasks.get(input.taskId);
    if (existingTask) throw new Error("TASK_ID_SOURCE_CONFLICT: Task ID already exists with a different source message");
    const project = this.resolveProject(input);
    const taskType = normalizeTaskType(input.taskType); const role = DEFAULT_ROLE[taskType];
    const dataClass = normalizeDataClass(input.dataClass);
    const executionContract = assertExecutionContract(input.executionContract, { goal: input.goal, validation: ["typecheck", "test", "build"] });
    this.store.transaction(() => {
      this.tasks.upsertProject(project);
      this.tasks.create({
        taskId: input.taskId, projectId: project.projectId, title: input.title, goal: input.goal,
        role, requiredCapabilities: ROLE_CAPABILITIES[role], status: input.executionHold ? "HUMAN_GATE" : "QUEUED", executionHold: Boolean(input.executionHold), executionContract, workspace: input.workspace,
        readContext: { projectChannel: true, currentTaskThread: true, decisions: true, agentMemory: true },
        fileScope: ["README.md", "AGENTS.md", "DESIGN.md", "ai-ops/**", "docs/**", "src/**", "content/**", "firebase.json"],
        doNot: projectProtectedInvariants(executionContract, []),
        validation: executionContract.mode === "IMPLEMENT_AND_VALIDATE" ? ["typecheck", "test", "build"] : ["READ_ONLY_DISCOVERY"], owner: input.authorId, nextOwner: input.authorId,
        authority: input.authority || classifyAuthority({ operation: "state reconciliation and task activation" }),
        taskType, teamMode: "SEQUENTIAL", dataClass, dataClassSource: "MANUAL",
        evidence: [`DISCORD_MESSAGE:${input.sourceMessageId}`, `DISCORD_CHANNEL:${input.sourceChannelId}`, "ASUS_SYMPHONY_BRIDGE"],
      });
      if (input.threadId) this.tasks.bindThread(input.taskId, input.threadId, input.parentChannelId || input.sourceChannelId);
      const now = this.store.now();
      this.store.db.prepare(`INSERT INTO external_task_inbox(source_message_id,task_id,source_channel_id,author_id,recipient_id,state,execution_hold,registered_at,updated_at)
        VALUES(?,?,?,?,?,?,?, ?,?)`).run(input.sourceMessageId, input.taskId, input.sourceChannelId,
          input.authorId, input.recipientId, input.executionHold ? "RECONCILIATION_HOLD" : "REGISTERED", input.executionHold ? 1 : 0,
          now, now);
    });
    return { taskId: input.taskId, state: input.executionHold ? "RECONCILIATION_HOLD" : "REGISTERED", created: true, projectId: project.projectId };
  }

  hold(sourceMessageId: string, reason = "External reconciliation requires explicit release"): ExternalTaskRegistration {
    const row = this.store.db.prepare("SELECT * FROM external_task_inbox WHERE source_message_id=?").get(sourceMessageId) as InboxRow | undefined;
    if (!row) throw new Error("BRIDGE_SOURCE_NOT_FOUND");
    const task = this.tasks.holdExecution(row.task_id, reason);
    this.store.db.prepare("UPDATE external_task_inbox SET execution_hold=1,state='RECONCILIATION_HOLD',last_error=?,updated_at=? WHERE source_message_id=?")
      .run(reason, this.store.now(), sourceMessageId);
    return { taskId: task.taskId, state: "RECONCILIATION_HOLD", created: false, projectId: task.projectId,
      ...(row.ack_message_id ? { ackMessageId: row.ack_message_id } : {}) };
  }

  markAck(sourceMessageId: string, ackMessageId: string): ExternalTaskRegistration {
    if (!/^\d{17,20}$/.test(ackMessageId)) throw new Error("ACK_MESSAGE_ID_INVALID");
    this.store.db.prepare("UPDATE external_task_inbox SET ack_message_id=COALESCE(ack_message_id,?),state=CASE WHEN state='REGISTERED' THEN 'ACKED' ELSE state END,updated_at=? WHERE source_message_id=?")
      .run(ackMessageId, this.store.now(), sourceMessageId);
    const row = this.store.db.prepare("SELECT * FROM external_task_inbox WHERE source_message_id=?").get(sourceMessageId) as InboxRow | undefined;
    if (!row) throw new Error("BRIDGE_SOURCE_NOT_FOUND");
    const task = this.tasks.get(row.task_id)!;
    return { taskId: task.taskId, state: row.state, created: false, projectId: task.projectId,
      ...(row.ack_message_id ? { ackMessageId: row.ack_message_id } : {}) };
  }

  release(sourceMessageId: string): ExternalTaskRegistration {
    const row = this.store.db.prepare("SELECT * FROM external_task_inbox WHERE source_message_id=?").get(sourceMessageId) as InboxRow | undefined;
    if (!row) throw new Error("BRIDGE_SOURCE_NOT_FOUND");
    const task = this.tasks.releaseExecutionHold(row.task_id);
    this.store.db.prepare("UPDATE external_task_inbox SET execution_hold=0,state=CASE WHEN ack_message_id IS NOT NULL THEN 'ACKED' ELSE 'REGISTERED' END,updated_at=? WHERE source_message_id=?")
      .run(this.store.now(), sourceMessageId);
    return { taskId: task.taskId, state: row.ack_message_id ? "ACKED" : "REGISTERED", created: false, projectId: task.projectId,
      ...(row.ack_message_id ? { ackMessageId: row.ack_message_id } : {}) };
  }

  releaseTask(taskId: string): ExternalTaskRegistration {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("BRIDGE_TASK_NOT_FOUND");
    const row = this.store.db.prepare("SELECT * FROM external_task_inbox WHERE task_id=?").get(taskId) as InboxRow | undefined;
    if (!row) throw new Error("BRIDGE_TASK_NOT_REGISTERED");
    const released = this.tasks.releaseExecutionHold(taskId);
    this.store.db.prepare("UPDATE external_task_inbox SET execution_hold=0,state=CASE WHEN ack_message_id IS NOT NULL THEN 'ACKED' ELSE 'REGISTERED' END,updated_at=? WHERE task_id=?")
      .run(this.store.now(), taskId);
    return { taskId: released.taskId, state: row.ack_message_id ? "ACKED" : "REGISTERED", created: false, projectId: released.projectId,
      ...(row.ack_message_id ? { ackMessageId: row.ack_message_id } : {}) };
  }

  retryExisting(taskId: string, round: number, executionContract?: ExecutionContract): ExternalTaskRegistration & { round: number; workroomReused: boolean } {
    if (!Number.isInteger(round) || round < 2) throw new Error("RETRY_ROUND_INVALID");
    const current = this.tasks.get(taskId);
    if (!current) throw new Error("BRIDGE_TASK_NOT_FOUND");
    if (!current.threadId) throw new Error("RETRY_WORKROOM_NOT_BOUND");
    const workroom = this.store.db.prepare("SELECT task_id FROM workrooms WHERE task_id=? AND thread_id=?").get(taskId, current.threadId);
    if (!workroom) throw new Error("RETRY_WORKROOM_NOT_FOUND");
    const validation = executionContract?.mode === "IMPLEMENT_AND_VALIDATE"
      ? ["typecheck", "test", "build"]
      : current.validation;
    // A Task created without a persisted contract (for example by a direct
    // supervisor create with npm-prefixed validations) is still lawful: the
    // Runtime's own worker-side default already interprets that shape through
    // effectiveExecutionContract() at execution time. Falling back to the same
    // default here keeps retryExisting usable for exactly those live Tasks
    // (prior bounded run: retry of a WAITING_MAIN
    // Task whose goal lawfully matches mutation keywords but whose row never
    // stored an explicit contract threw EXECUTION_CONTRACT_MISSING even though
    // every other Runtime boundary accepts the same Task). The parameter still
    // wins, and validation stays `current.validation` whenever the caller did
    // not pass IMPLEMENT_AND_VALIDATE, so executed evidence commands are never
    // silently rewritten.
    const contract = assertExecutionContract(executionContract || current.executionContract || effectiveExecutionContract(current), { goal: current.goal, validation });
    const team = this.store.db.prepare("SELECT task_id FROM task_teams WHERE task_id=?").get(taskId);
    if (!team) throw new Error("RETRY_TEAM_NOT_REGISTERED");
    const now = this.store.now();
    this.store.transaction(() => {
      // A timed-out native dispatch may have reached the worker gateway but stopped
      // after inbound receipt (for example, before ROLE_CLAIM). Preserve that audit
      // row while releasing its logical claim so the same Task can be retried
      // idempotently with a fresh Discord message id.
      this.store.db.prepare("UPDATE inbound_messages SET state='SUPERSEDED',reason_code='ACK_TIMEOUT_REDISPATCH',logical_key=logical_key||'|superseded|'||discord_message_id,processed_at=? WHERE task_id=? AND event_type='TASK' AND state IN ('RECEIVED','PROCESSED')").run(now, taskId);
      this.store.db.prepare("UPDATE tasks SET status='QUEUED',execution_hold=0,attempt=?,current_role_sequence=NULL,completion_candidate=0,completed_at=NULL,result=NULL,execution_contract_json=?,authority_metadata_json=?,validation_json=?,do_not_json=?,updated_at=? WHERE task_id=?")
        .run(round, JSON.stringify(contract), JSON.stringify(classifyAuthority({ operation: "same-task retry and stale state reconciliation" }, now)), JSON.stringify(validation), JSON.stringify(projectProtectedInvariants(contract, current.doNot)), now, taskId);
      this.store.db.prepare("UPDATE task_teams SET status='PLANNED',current_sequence=NULL,updated_at=? WHERE task_id=?").run(now, taskId);
      this.store.db.prepare("UPDATE task_roles SET status=CASE WHEN assigned_agent IS NULL THEN 'PENDING' ELSE 'ASSIGNED' END,revision_round=?,started_at=NULL,completed_at=NULL,result=NULL,evidence_json='[]' WHERE task_id=?").run(round, taskId);
    });
    return { taskId, state: "QUEUED", created: false, projectId: current.projectId, round, workroomReused: true };
  }

  reconcile(): Array<{ taskId: string; state: string; gap?: string }> {
    const rows = this.store.db.prepare("SELECT * FROM external_task_inbox ORDER BY registered_at").all() as Array<Record<string, unknown>>;
    const result: Array<{ taskId: string; state: string; gap?: string }> = [];
    for (const row of rows) {
      const taskId = String(row.task_id); const task = this.tasks.get(taskId);
      if (!task) { result.push({ taskId, state: String(row.state), gap: "ACKED_BUT_NO_REGISTRATION" }); continue; }
      let state = String(row.state); const patch: string[] = []; const values: unknown[] = [];
      if (Number(row.execution_hold) === 1 || task.executionHold) {
        state = "RECONCILIATION_HOLD";
        patch.push("execution_hold=1");
      } else if (["PASS", "FAIL", "BLOCKED", "WAITING_MAIN", "HUMAN_GATE", "CANCELLED"].includes(task.status)) {
        state = "COMPLETED"; patch.push("completed_at=COALESCE(completed_at,?)"); values.push(this.store.now());
      } else if (["CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING"].includes(task.status)) {
        state = "AGENT_ACKED"; patch.push("agent_ack_at=COALESCE(agent_ack_at,?)"); values.push(this.store.now());
      } else if (task.threadId) {
        state = "WORKROOM_CREATED"; patch.push("workroom_at=COALESCE(workroom_at,?)"); values.push(this.store.now());
      }
      patch.unshift("state=?"); values.unshift(state); patch.push("updated_at=?"); values.push(this.store.now(), String(row.source_message_id));
      this.store.db.prepare(`UPDATE external_task_inbox SET ${patch.join(",")} WHERE source_message_id=?`).run(...values as never[]);
      const registeredMs = Date.parse(String(row.registered_at));
      const gap = !task.threadId && Date.now() - registeredMs > 120_000 ? "REGISTERED_BUT_NO_WORKROOM"
        : task.status === "DISPATCHED" && Date.now() - registeredMs > 300_000 ? "WORKROOM_BUT_NO_AGENT_ACK" : undefined;
      result.push({ taskId, state, ...(gap ? { gap } : {}) });
    }
    const gaps = result.filter((item) => item.gap);
    this.store.upsertRuntimeState("bridge:watchdog", { checkedAt: this.store.now(), gaps });
    return result;
  }

  private resolveProject(input: ExternalSymphonyTask): ProjectRecord {
    const rows = this.store.db.prepare("SELECT discord_id,name,project_id,policy_json FROM discord_mappings WHERE kind='CHANNEL'")
      .all() as Array<Record<string, unknown>>;
    const explicit = String(input.projectId || "").trim();
    const configuredWorkspace = this.workspaces.resolve(explicit) || this.workspaces.resolveByLabel(input.workspace);
    const resolvedWorkspace = configuredWorkspace?.workspace || input.workspace;
    if (!path.isAbsolute(resolvedWorkspace)) throw new Error("WORKSPACE_REGISTRY_PROJECT_NOT_FOUND");
    const explicitKey = normalizeDiscordLabel(explicit);
    const workspaceKey = normalizeDiscordLabel(path.basename(resolvedWorkspace));
    const matches = rows.filter((row) => {
      const policy = parseObject(row.policy_json); if (policy.projectDiscovery !== true) return false;
      const exact = [row.project_id, row.name, policy.projectSlug].map((value) => normalizeDiscordLabel(String(value || "")));
      if (explicit) {
        return exact.includes(explicitKey);
      }
      const topic = normalizeDiscordLabel(String(policy.topic || ""));
      return exact.includes(workspaceKey) || (workspaceKey.length >= 5 && topic.includes(workspaceKey));
    });
    if (explicit && matches.length === 0) {
      const topicMatches = rows.filter((row) => {
        const policy = parseObject(row.policy_json); if (policy.projectDiscovery !== true) return false;
        return normalizeDiscordLabel(String(policy.topic || "")).includes(explicitKey);
      });
      if (topicMatches.length === 1) matches.push(topicMatches[0]!);
    }
    if (matches.length === 0) {
      // Project channel creation belongs to WorkroomManager's Discord port.
      // Registration must therefore persist the explicit Main PROJECT_ID
      // first; rejecting here made a missing channel indistinguishable from
      // a malformed task and prevented deterministic channel provisioning.
      const projectId = explicit || configuredWorkspace?.projectId || workspaceKey;
      if (!projectId) throw new Error("WORKROOM_PROJECT_NOT_FOUND");
      return { projectId, name: projectId, workspace: resolvedWorkspace, ssotPaths: ["README.md", "AGENTS.md", "docs/PROJECT_STATUS.md", "docs/STATE.md", "docs/ROADMAP.md"], status: "ACTIVE" };
    }
    if (matches.length > 1) throw new Error("WORKROOM_PROJECT_AMBIGUOUS");
    const match = matches[0]!;
    const existingProject = this.store.db.prepare("SELECT project_id FROM projects WHERE workspace=?").get(resolvedWorkspace) as { project_id?: string } | undefined;
    const projectId = String(existingProject?.project_id || match.project_id || match.name);
    return { projectId, name: projectId, workspace: resolvedWorkspace, discordChannelId: String(match.discord_id),
      ssotPaths: ["README.md", "AGENTS.md", "docs/PROJECT_STATUS.md", "docs/STATE.md", "docs/ROADMAP.md"], status: "ACTIVE" };
  }
}

function normalizeTaskType(value: string): TaskType { const normalized = value.trim().toUpperCase() as TaskType; return TASK_TYPES.includes(normalized) ? normalized : "UNKNOWN"; }
function normalizeDataClass(value: string): DataClass { const normalized = value.trim().toUpperCase() as DataClass; return DATA_CLASSES.includes(normalized) ? normalized : "REAL_PROJECT"; }
function parseObject(value: unknown): Record<string, unknown> { try { return JSON.parse(String(value)) as Record<string, unknown>; } catch { return {}; } }
function validate(input: ExternalSymphonyTask): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/.test(input.taskId)) throw new Error("TASK_ID_INVALID");
  if (!/^\d{17,20}$/.test(input.sourceMessageId) || !/^\d{17,20}$/.test(input.sourceChannelId)) throw new Error("DISCORD_SOURCE_INVALID");
  if (!/^\d{17,20}$/.test(input.authorId) || !/^\d{17,20}$/.test(input.recipientId)) throw new Error("DISCORD_IDENTITY_INVALID");
  if (!path.isAbsolute(input.workspace)) throw new Error("WORKSPACE_ABSOLUTE_PATH_REQUIRED");
  if (!input.goal.trim()) throw new Error("TASK_GOAL_REQUIRED");
}
