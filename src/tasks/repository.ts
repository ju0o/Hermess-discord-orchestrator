import { randomUUID } from "node:crypto";
import type { AgentId, Capability, ModelTier, ProjectRecord, ReasoningComplexity, Role, TaskRecord, TaskStatus, TaskType } from "../domain/types.js";
import type { ExecutionContract } from "../contracts/executionContract.js";
import type { AuthorityDecision } from "../authority/delegatedAuthority.js";
import type { Store } from "../storage/database.js";
import { assertTransition } from "./stateMachine.js";
import type { PerformanceObserver } from "../performance/types.js";

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

function taskFromRow(row: Record<string, unknown>): TaskRecord {
  const task: TaskRecord = {
    taskId: String(row.task_id), projectId: String(row.project_id), title: String(row.title), goal: String(row.goal),
    role: row.role as Role, requiredCapabilities: parse<Capability[]>(row.required_capabilities_json),
    status: row.status as TaskStatus, executionHold: Boolean(row.execution_hold), workspace: String(row.workspace),
    readContext: parse(row.read_context_json), fileScope: parse(row.file_scope_json), doNot: parse(row.do_not_json),
    validation: parse(row.validation_json), owner: String(row.owner),
    attempt: Number(row.attempt), createdAt: String(row.created_at), evidence: parse(row.evidence_json),
  };
  if (row.assigned_agent) task.assignedAgent = row.assigned_agent as NonNullable<TaskRecord["assignedAgent"]>;
  if (row.thread_id) task.threadId = String(row.thread_id);
  if (row.parent_channel_id) task.parentChannelId = String(row.parent_channel_id);
  if (row.next_owner) task.nextOwner = String(row.next_owner);
  if (row.started_at) task.startedAt = String(row.started_at);
  if (row.completed_at) task.completedAt = String(row.completed_at);
  if (row.result) task.result = String(row.result);
  if (row.lock_token) task.lockToken = String(row.lock_token);
  if (row.task_type) task.taskType = row.task_type as TaskType;
  if (row.required_roles_json) task.requiredRoles = parse<Role[]>(row.required_roles_json);
  if (row.agent_overrides_json) task.agentOverrides = parse<Partial<Record<Role, AgentId>>>(row.agent_overrides_json);
  if (row.team_mode) task.teamMode = "SEQUENTIAL";
  if (row.current_role_sequence !== null && row.current_role_sequence !== undefined) task.currentRoleSequence = Number(row.current_role_sequence);
  task.completionCandidate = Boolean(row.completion_candidate);
  if (row.complexity) task.complexity = row.complexity as ReasoningComplexity;
  if (row.complexity_reasons_json) task.complexityReasons = parse<string[]>(row.complexity_reasons_json);
  if (row.complexity_source) task.complexitySource = row.complexity_source as "MANUAL" | "DETERMINISTIC";
  if (row.model_tier_override) task.modelTierOverride = row.model_tier_override as ModelTier;
  if (row.model_override) task.modelOverride = String(row.model_override);
  if (row.data_class) task.dataClass = row.data_class as NonNullable<TaskRecord["dataClass"]>;
  if (row.data_class_source) task.dataClassSource = row.data_class_source as NonNullable<TaskRecord["dataClassSource"]>;
  if (row.execution_contract_json) task.executionContract = parse<ExecutionContract>(row.execution_contract_json);
  if (row.authority_metadata_json) task.authority = parse<AuthorityDecision>(row.authority_metadata_json);
  return task;
}

export class TaskRepository {
  private observer?: PerformanceObserver;
  constructor(private readonly store: Store) {}
  attachObserver(observer: PerformanceObserver): void { this.observer = observer; }
  private observe(taskId: string): void { try { void this.observer?.observeTask(taskId); } catch { /* Metrics never own Task outcome. */ } }

  upsertProject(project: ProjectRecord): void {
    this.store.db.prepare(`INSERT INTO projects(project_id,name,workspace,discord_channel_id,ssot_paths_json,status,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,workspace=excluded.workspace,
      discord_channel_id=COALESCE(excluded.discord_channel_id,projects.discord_channel_id),
      ssot_paths_json=excluded.ssot_paths_json,status=excluded.status,updated_at=excluded.updated_at`)
      .run(project.projectId, project.name, project.workspace, project.discordChannelId ?? null,
        JSON.stringify(project.ssotPaths), project.status, this.store.now());
  }

  bindProjectChannel(projectId: string, discordChannelId: string): ProjectRecord {
    this.store.db.prepare("UPDATE projects SET discord_channel_id=?,updated_at=? WHERE project_id=?")
      .run(discordChannelId, this.store.now(), projectId);
    const project = this.getProject(projectId); if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM projects WHERE project_id=?").get(projectId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { projectId: String(row.project_id), name: String(row.name), workspace: String(row.workspace),
      ...(row.discord_channel_id ? { discordChannelId: String(row.discord_channel_id) } : {}),
      ssotPaths: parse(row.ssot_paths_json), status: String(row.status) };
  }

  create(input: Omit<TaskRecord, "taskId" | "createdAt" | "attempt" | "evidence"> & Partial<Pick<TaskRecord, "taskId" | "createdAt" | "attempt" | "evidence">>): TaskRecord {
    const task: TaskRecord = { ...input, taskId: input.taskId ?? randomUUID(), createdAt: input.createdAt ?? this.store.now(),
      attempt: input.attempt ?? 0, evidence: input.evidence ?? [] };
    this.store.db.prepare(`INSERT INTO tasks(task_id,project_id,title,goal,role,required_capabilities_json,assigned_agent,
      status,workspace,thread_id,parent_channel_id,read_context_json,file_scope_json,do_not_json,validation_json,
      owner,next_owner,attempt,created_at,started_at,completed_at,result,evidence_json,lock_token,updated_at,execution_hold,execution_contract_json,authority_metadata_json,
      task_type,required_roles_json,agent_overrides_json,team_mode,current_role_sequence,completion_candidate,
      complexity,complexity_reasons_json,complexity_source,model_tier_override,model_override,data_class,data_class_source)
      VALUES(${Array(41).fill("?").join(",")})`)
      .run(task.taskId, task.projectId, task.title, task.goal, task.role, JSON.stringify(task.requiredCapabilities),
        task.assignedAgent ?? null, task.status, task.workspace, task.threadId ?? null, task.parentChannelId ?? null,
        JSON.stringify(task.readContext), JSON.stringify(task.fileScope), JSON.stringify(task.doNot), JSON.stringify(task.validation),
        task.owner, task.nextOwner ?? null, task.attempt, task.createdAt, task.startedAt ?? null, task.completedAt ?? null,
        task.result ?? null, JSON.stringify(task.evidence), task.lockToken ?? null, this.store.now(), task.executionHold ? 1 : 0, task.executionContract ? JSON.stringify(task.executionContract) : null, task.authority ? JSON.stringify(task.authority) : null, task.taskType ?? null,
        task.requiredRoles ? JSON.stringify(task.requiredRoles) : null, task.agentOverrides ? JSON.stringify(task.agentOverrides) : null,
        task.teamMode ?? null, task.currentRoleSequence ?? null, task.completionCandidate ? 1 : 0,
        task.complexity ?? null, task.complexityReasons ? JSON.stringify(task.complexityReasons) : null, task.complexitySource ?? null,
        task.modelTierOverride ?? null, task.modelOverride ?? null, task.dataClass ?? null, task.dataClass ? (task.dataClassSource ?? "MANUAL") : null);
    this.observe(task.taskId); return task;
  }

  get(taskId: string): TaskRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  /** Requeue only a watchdog safe-stop; human-gated WAITING_MAIN states stay blocked. */
  continueFromWatchdog(taskId: string): TaskRecord {
    const current = this.get(taskId); if (!current) throw new Error("TASK_NOT_FOUND");
    if (current.status !== "WAITING_MAIN") return current;
    if (current.executionHold) throw new Error("TASK_EXECUTION_HOLD_ACTIVE");
    if (!/^Watchdog detected no worker heartbeat for \d+ms\.$/.test(String(current.result || ""))) {
      throw new Error("WAITING_MAIN_REQUIRES_MAIN_DECISION");
    }
    const activeWorker = this.store.db.prepare(
      "SELECT process_id FROM worker_processes WHERE task_id=? AND status IN ('RUNNING','STARTED','BUSY') LIMIT 1",
    ).get(taskId);
    if (activeWorker) throw new Error("ACTIVE_WORKER_PREVENTS_CONTINUATION");
    return this.transition(taskId, "QUEUED");
  }

  bindThread(taskId: string, threadId: string, parentChannelId: string): TaskRecord {
    this.store.db.prepare("UPDATE tasks SET thread_id=?,parent_channel_id=?,updated_at=? WHERE task_id=?")
      .run(threadId, parentChannelId, this.store.now(), taskId);
    const task = this.get(taskId); if (!task) throw new Error(`Task not found: ${taskId}`); return task;
  }

  /** Runtime workroom recovery may detach only the exact stale binding; the old
   * Workroom/mapping rows remain as historical evidence. */
  clearMissingThreadBindingForRecovery(taskId: string, expectedThreadId: string): TaskRecord {
    this.store.db.prepare("UPDATE tasks SET thread_id=NULL,parent_channel_id=NULL,updated_at=? WHERE task_id=? AND thread_id=? AND status NOT IN ('PASS','CANCELLED')")
      .run(this.store.now(), taskId, expectedThreadId);
    return this.get(taskId)!;
  }

  setAuthority(taskId: string, authority: AuthorityDecision): TaskRecord {
    this.store.db.prepare("UPDATE tasks SET authority_metadata_json=?,updated_at=? WHERE task_id=?")
      .run(JSON.stringify(authority), this.store.now(), taskId);
    const task = this.get(taskId); if (!task) throw new Error(`Task not found: ${taskId}`); return task;
  }

  holdExecution(taskId: string, reason = "External reconciliation requires explicit release"): TaskRecord {
    const current = this.get(taskId); if (!current) throw new Error(`Task not found: ${taskId}`);
    this.store.db.prepare("UPDATE tasks SET execution_hold=1,result=?,updated_at=? WHERE task_id=?")
      .run(reason, this.store.now(), taskId);
    const refreshed = this.get(taskId)!;
    if (refreshed.status === "WAITING_MAIN") return this.transition(taskId, "HUMAN_GATE", { result: reason });
    return refreshed;
  }

  releaseExecutionHold(taskId: string): TaskRecord {
    const current = this.get(taskId); if (!current) throw new Error(`Task not found: ${taskId}`);
    this.store.db.prepare("UPDATE tasks SET execution_hold=0,updated_at=? WHERE task_id=?").run(this.store.now(), taskId);
    const refreshed = this.get(taskId)!;
    return refreshed.status === "HUMAN_GATE" ? this.transition(taskId, "QUEUED") : refreshed;
  }

  reconcileStaleLease(taskId: string, expectedToken: string): TaskRecord {
    const current = this.get(taskId); if (!current) throw new Error(`Task not found: ${taskId}`);
    if (current.status !== "HUMAN_GATE" || !current.executionHold) throw new Error("STALE_LEASE_REQUIRES_HELD_TASK");
    if (!expectedToken || current.lockToken !== expectedToken) throw new Error("STALE_LEASE_TOKEN_MISMATCH");
    const workspaceLock = this.store.db.prepare("SELECT token FROM workspace_locks WHERE token=?").get(expectedToken);
    if (workspaceLock) throw new Error("LEASE_STILL_ACTIVE");
    const activeWorker = this.store.db.prepare(
      "SELECT process_id FROM worker_processes WHERE task_id=? AND status IN ('RUNNING','STARTED','BUSY') LIMIT 1",
    ).get(taskId);
    if (activeWorker) throw new Error("ACTIVE_WORKER_PREVENTS_LEASE_RECONCILIATION");
    this.store.db.prepare("UPDATE tasks SET lock_token=NULL,updated_at=? WHERE task_id=? AND status='HUMAN_GATE' AND execution_hold=1")
      .run(this.store.now(), taskId);
    return this.get(taskId)!;
  }

  setTeamMetadata(taskId: string, taskType: TaskType, requiredRoles: Role[], agentOverrides: Partial<Record<Role, AgentId>> = {}): TaskRecord {
    this.store.db.prepare(`UPDATE tasks SET task_type=?,required_roles_json=?,agent_overrides_json=?,team_mode='SEQUENTIAL',updated_at=? WHERE task_id=?`)
      .run(taskType, JSON.stringify(requiredRoles), JSON.stringify(agentOverrides), this.store.now(), taskId);
    const task = this.get(taskId); if (!task) throw new Error(`Task not found: ${taskId}`); return task;
  }

  setCurrentTeamRole(taskId: string, sequence: number | null, role?: Role, agentId?: AgentId): TaskRecord {
    this.store.db.prepare("UPDATE tasks SET current_role_sequence=?,role=COALESCE(?,role),assigned_agent=COALESCE(?,assigned_agent),updated_at=? WHERE task_id=?")
      .run(sequence, role ?? null, agentId ?? null, this.store.now(), taskId);
    return this.get(taskId)!;
  }

  setCompletionCandidate(taskId: string, value: boolean): TaskRecord {
    this.store.db.prepare("UPDATE tasks SET completion_candidate=?,updated_at=? WHERE task_id=?").run(value ? 1 : 0, this.store.now(), taskId);
    return this.get(taskId)!;
  }

  /**
   * Recovery authority only: terminal history is retained in the recovery event;
   * this method cannot be used as a general terminal transition.
   */
  reopenCancelledForRecovery(taskId: string, role: Role, sequence: number, agentId: AgentId, result: string): TaskRecord {
    const current = this.get(taskId); if (!current) throw new Error(`Task not found: ${taskId}`);
    const recoverable = current.status === "CANCELLED"
      || (current.status === "FAIL" && /^SAFE_STOP:(NO_PROGRESS_CONTINUATION|ROUTING_NO_ELIGIBLE_AGENT):/.test(String(current.result || "")));
    if (!recoverable) throw new Error("TERMINAL_RECOVERY_REQUIRES_CANCELLED");
    this.store.db.prepare(`UPDATE tasks SET status='QUEUED',role=?,assigned_agent=?,current_role_sequence=?,
      result=?,lock_token=NULL,updated_at=? WHERE task_id=? AND (status='CANCELLED' OR (status='FAIL' AND (result LIKE 'SAFE_STOP:NO_PROGRESS_CONTINUATION:%' OR result LIKE 'SAFE_STOP:ROUTING_NO_ELIGIBLE_AGENT:%')))`)
      .run(role, agentId, sequence, result, this.store.now(), taskId);
    return this.get(taskId)!;
  }

  setComplexity(taskId: string, complexity: ReasoningComplexity, reasons: string[], source: "MANUAL" | "DETERMINISTIC"): TaskRecord {
    this.store.db.prepare("UPDATE tasks SET complexity=?,complexity_reasons_json=?,complexity_source=?,updated_at=? WHERE task_id=?")
      .run(complexity, JSON.stringify(reasons), source, this.store.now(), taskId); return this.get(taskId)!;
  }

  listByStatus(...statuses: TaskStatus[]): TaskRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(",");
    return (this.store.db.prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statuses) as Record<string, unknown>[]).map(taskFromRow);
  }

  transition(taskId: string, to: TaskStatus, patch: Partial<TaskRecord> = {}): TaskRecord {
    const doTransition = (): TaskRecord => {
      const current = this.get(taskId); if (!current) throw new Error(`Task not found: ${taskId}`);
      assertTransition(current.status, to);
      const startedAt = patch.startedAt ?? current.startedAt ?? (["CLAIMED", "RUNNING"].includes(to) ? this.store.now() : null);
      const completedAt = patch.completedAt ?? current.completedAt ?? (["PASS", "COMPLETED", "FAIL", "CANCELLED"].includes(to) ? this.store.now() : null);
      this.store.db.prepare(`UPDATE tasks SET status=?,assigned_agent=?,next_owner=?,attempt=?,started_at=?,completed_at=?,
        result=?,evidence_json=?,lock_token=?,updated_at=? WHERE task_id=? AND status=?`)
        .run(to, patch.assignedAgent ?? current.assignedAgent ?? null, patch.nextOwner ?? current.nextOwner ?? null,
          patch.attempt ?? current.attempt, startedAt, completedAt, patch.result ?? current.result ?? null,
          JSON.stringify(patch.evidence ?? current.evidence), patch.lockToken ?? current.lockToken ?? null,
          this.store.now(), taskId, current.status);
      return this.get(taskId)!;
    };
    let updated: TaskRecord;
    try { updated = this.store.transaction(doTransition); } catch (e) {
      if (e instanceof Error && /cannot start a transaction within a transaction/i.test(e.message)) updated = doTransition();
      else throw e;
    }
    this.observe(taskId); return updated;
  }

  upsertSession(sessionKey: string, agentId: string, projectId: string, taskId: string, cliSessionId: string,
    model: { requestedModel?: string; effectiveModel?: string; provider?: string; source?: string } = {}): void {
    const now = this.store.now();
    this.store.db.prepare(`INSERT INTO sessions(session_id,agent_id,project_id,task_id,cli_session_id,model,requested_model,effective_model,provider,model_verification_source,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?) ON CONFLICT(session_id) DO UPDATE SET cli_session_id=excluded.cli_session_id,
      task_id=excluded.task_id,model=excluded.model,requested_model=excluded.requested_model,effective_model=excluded.effective_model,
      provider=excluded.provider,model_verification_source=excluded.model_verification_source,status='ACTIVE',updated_at=excluded.updated_at`)
      .run(sessionKey, agentId, projectId, taskId, cliSessionId, model.effectiveModel || model.requestedModel || null,
        model.requestedModel || null, model.effectiveModel || null, model.provider || null, model.source || null, now, now);
  }
}
