import type { ExpertRequestRecord, ProjectRecord, TaskRecord, TaskRoleRecord, TaskStatus } from "../../domain/types.js";
import type { Store } from "../../storage/database.js";
import type { TaskRepository } from "../../tasks/repository.js";
import { canTransition } from "../../tasks/stateMachine.js";
import { normalizeDiscordLabel, workroomThreadName } from "./normalization.js";
import { WorkroomError, type DiscordThreadSnapshot, type DiscordWorkroomPort, type WorkroomReason, type WorkroomRecord } from "./types.js";

const ACTIVE_STATUSES: TaskStatus[] = ["QUEUED", "DISPATCHED", "CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING", "FAIL", "BLOCKED", "WAITING_MAIN", "HUMAN_GATE"];

export class WorkroomManager {
  private readonly pending = new Map<string, Promise<WorkroomRecord>>();
  private readonly projectPending = new Map<string, Promise<string>>();
  constructor(private readonly store: Store, private readonly tasks: TaskRepository, private readonly discord: DiscordWorkroomPort) {}

  ensure(taskInput: TaskRecord): Promise<WorkroomRecord> {
    const current = this.pending.get(taskInput.taskId); if (current) return current;
    const operation = this.ensureOnce(taskInput).finally(() => this.pending.delete(taskInput.taskId));
    this.pending.set(taskInput.taskId, operation); return operation;
  }

  get(taskId: string): WorkroomRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM workrooms WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToWorkroom(row) : undefined;
  }

  async syncTaskState(taskInput: TaskRecord): Promise<WorkroomRecord | undefined> {
    const task = this.tasks.get(taskInput.taskId) ?? taskInput;
    if (!task.threadId) return undefined;
    if (task.status !== "PASS" && task.status !== "CANCELLED") return this.ensure(task);
    const snapshot = await this.discord.getThread(task.threadId);
    if (!snapshot) { this.recordMissing(task, task.threadId, task.parentChannelId); return this.get(task.taskId); }
    if (snapshot.archived) return this.persist(task, snapshot, "ARCHIVED", "WORKROOM_REUSED", this.get(task.taskId)?.bootstrapMessageId);
    try {
      const archived = await this.discord.setThreadArchived(snapshot.id, true);
      return this.persist(task, archived, "ARCHIVED", "WORKROOM_ARCHIVED", this.get(task.taskId)?.bootstrapMessageId);
    } catch (error) {
      this.persist(task, snapshot, "ACTIVE", "WORKROOM_ARCHIVE_FAILED", this.get(task.taskId)?.bootstrapMessageId);
      this.store.upsertRuntimeState(`workroom:issue:${task.taskId}`, { reason: "WORKROOM_ARCHIVE_FAILED", at: this.store.now() });
      return this.get(task.taskId);
    }
  }

  async reconcileActive(): Promise<{ restored: number; repaired: number; missing: string[] }> {
    const report = { restored: 0, repaired: 0, missing: [] as string[] };
    for (const task of this.tasks.listByStatus(...ACTIVE_STATUSES)) {
      if (!task.threadId) continue;
      const before = this.store.db.prepare("SELECT 1 FROM discord_mappings WHERE discord_id=? AND task_id=?").get(task.threadId, task.taskId);
      const snapshot = await this.discord.getThread(task.threadId);
      if (!snapshot) {
        if (isTerminalRecovery(task)) {
          await this.ensure(task);
          report.restored++; report.repaired++; continue;
        }
        this.recordMissing(task, task.threadId, task.parentChannelId); report.missing.push(task.taskId);
        if (task.status !== "WAITING_MAIN" && canTransition(task.status, "WAITING_MAIN"))
          this.tasks.transition(task.taskId, "WAITING_MAIN", { result: "WORKROOM_MISSING: Discord Task thread no longer exists; automatic replacement was not created." });
        continue;
      }
      await this.ensure(task); report.restored++;
      if (!before) report.repaired++;
    }
    this.store.upsertRuntimeState("workroom:last_recovery", { ...report, at: this.store.now() }); return report;
  }

  async publishTeamComposition(taskInput: TaskRecord, roles: TaskRoleRecord[]): Promise<string> {
    const task = this.tasks.get(taskInput.taskId) ?? taskInput; const workroom = await this.ensure(task);
    const team = this.store.db.prepare("SELECT composition_message_id FROM task_teams WHERE task_id=?").get(task.taskId) as { composition_message_id: string | null } | undefined;
    if (team?.composition_message_id) return team.composition_message_id;
    const lines = ["[SYMPHONY TEAM]", "", `TASK: ${task.taskId}`, "", ...roles.flatMap((item) => [ `${item.sequence}. ${item.role}:`, item.assignedAgent || "UNASSIGNED", "" ]), "MODE: SEQUENTIAL"];
    const messageId = await this.discord.sendControlMessage(workroom.threadId, lines.join("\n").slice(0, 1_950));
    this.store.db.prepare("UPDATE task_teams SET composition_message_id=?,updated_at=? WHERE task_id=?").run(messageId, this.store.now(), task.taskId); return messageId;
  }

  async publishExpertJoin(taskInput: TaskRecord, request: ExpertRequestRecord): Promise<string> {
    const task = this.tasks.get(taskInput.taskId) ?? taskInput; const workroom = await this.ensure(task);
    const existing = this.store.getRuntimeState<string>(`workroom:expert_join:${request.requestId}`); if (existing) return existing;
    const content = `[EXPERT JOIN]\n\nTASK_ID: ${task.taskId}\nROLE: ${request.requestedRole}\nAGENT: ${request.selectedAgent || "UNASSIGNED"}\nREQUESTED_BY: ${request.requestingAgent}\nREASON: ${request.reason}\nSCOPE:\n${list(request.scope)}`.slice(0, 1_950);
    const messageId = await this.discord.sendControlMessage(workroom.threadId, content); this.store.upsertRuntimeState(`workroom:expert_join:${request.requestId}`, messageId); return messageId;
  }

  markDeleted(threadId: string): void {
    const task = this.store.db.prepare("SELECT task_id FROM workrooms WHERE thread_id=?").get(threadId) as { task_id: string } | undefined;
    if (!task) return;
    const record = this.tasks.get(task.task_id); if (!record) return;
    this.recordMissing(record, threadId, record.parentChannelId);
    if (record.status !== "WAITING_MAIN" && canTransition(record.status, "WAITING_MAIN"))
      this.tasks.transition(record.taskId, "WAITING_MAIN", { result: "WORKROOM_MISSING: Discord Task thread was deleted." });
  }

  async reconcileThread(threadId: string): Promise<void> {
    const row = this.store.db.prepare("SELECT task_id FROM workrooms WHERE thread_id=?").get(threadId) as { task_id: string } | undefined;
    if (!row) return; const task = this.tasks.get(row.task_id); if (!task) return;
    if (task.status === "PASS" || task.status === "CANCELLED") await this.syncTaskState(task); else await this.ensure(task);
  }

  private async ensureOnce(taskInput: TaskRecord): Promise<WorkroomRecord> {
    const task = this.tasks.get(taskInput.taskId) ?? taskInput;
    if (task.status === "PASS" || task.status === "CANCELLED") {
      const existing = this.get(task.taskId); if (!task.threadId && !existing) throw new WorkroomError("WORKROOM_MISSING", "Terminal Task cannot create a new Workroom");
      return (await this.syncTaskState(task))!;
    }
    const stored = this.get(task.taskId); const threadId = task.threadId || (isTerminalRecovery(task) ? undefined : stored?.threadId);
    if (threadId) {
      const snapshot = await this.discord.getThread(threadId);
      if (!snapshot) {
        if (isTerminalRecovery(task)) {
          this.recordMissing(task, threadId, task.parentChannelId || stored?.parentChannelId);
          const detached = this.tasks.clearMissingThreadBindingForRecovery(task.taskId, threadId);
          return this.ensureOnce(detached);
        }
        this.recordMissing(task, threadId, task.parentChannelId || stored?.parentChannelId); throw new WorkroomError("WORKROOM_MISSING");
      }
      if (!snapshot.canView || !snapshot.canSend) { this.persist(task, snapshot, "ACCESS_DENIED", "THREAD_ACCESS_DENIED", stored?.bootstrapMessageId); throw new WorkroomError("THREAD_ACCESS_DENIED"); }
      let usable = snapshot; let reason: WorkroomReason = beforeMapping(this.store, threadId, task.taskId) ? "WORKROOM_REUSED" : "THREAD_MAPPING_REPAIRED";
      if (snapshot.archived) {
        try { usable = await this.discord.setThreadArchived(threadId, false); reason = "WORKROOM_REOPENED"; }
        catch { throw new WorkroomError("THREAD_ACCESS_DENIED", "Archived Workroom could not be reopened"); }
      }
      this.tasks.bindThread(task.taskId, usable.id, usable.parentId);
      return this.persist(this.tasks.get(task.taskId)!, usable, "ACTIVE", reason, stored?.bootstrapMessageId);
    }
    const project = this.tasks.getProject(task.projectId); if (!project) throw new WorkroomError("WORKROOM_PROJECT_NOT_FOUND");
    const creationReason: WorkroomReason = stored?.state === "MISSING" ? "WORKROOM_REACQUIRED" : "WORKROOM_CREATED";
    const parentChannelId = await this.resolveProjectChannel(project);
    const created = await this.discord.createPublicThread(parentChannelId, workroomThreadName(task.taskId, task.title));
    if (!created.canView || !created.canSend) {
      this.persist(task, created, "ACCESS_DENIED", "THREAD_ACCESS_DENIED"); throw new WorkroomError("THREAD_ACCESS_DENIED");
    }
    this.tasks.bindThread(task.taskId, created.id, created.parentId);
    const bound = this.tasks.get(task.taskId)!; let record = this.persist(bound, created, "ACTIVE", creationReason);
    const messageId = await this.discord.sendBootstrap(created.id, renderBrief(bound, project));
    try { await this.discord.pinMessage(created.id, messageId); } catch { /* pinning is best effort; the persisted ID prevents duplicate briefs */ }
    this.store.db.prepare("UPDATE workrooms SET bootstrap_message_id=?,last_synced_at=? WHERE task_id=?").run(messageId, this.store.now(), task.taskId);
    record = this.get(task.taskId)!; return record;
  }

  private resolveProjectChannel(project: ProjectRecord): Promise<string> {
    const key = normalizeDiscordLabel(project.projectId || project.name);
    const pending = this.projectPending.get(key); if (pending) return pending;
    const operation = this.resolveProjectChannelOnce(project).finally(() => this.projectPending.delete(key));
    this.projectPending.set(key, operation); return operation;
  }

  private async resolveProjectChannelOnce(project: ProjectRecord): Promise<string> {
    if (project.discordChannelId) {
      const explicit = this.store.db.prepare("SELECT discord_id,kind FROM discord_mappings WHERE discord_id=?").get(project.discordChannelId) as { discord_id: string; kind: string } | undefined;
      if (explicit?.kind === "CHANNEL") return explicit.discord_id;
    }
    const keys = new Set([normalizeDiscordLabel(project.projectId), normalizeDiscordLabel(project.name)].filter(Boolean));
    const rows = this.store.db.prepare("SELECT discord_id,name,project_id,policy_json FROM discord_mappings WHERE kind='CHANNEL'").all() as Array<Record<string, unknown>>;
    const matches = rows.filter((row) => {
      const policy = parsePolicy(row.policy_json); if (policy.projectDiscovery !== true) return false;
      const candidates = [normalizeDiscordLabel(String(row.name)), normalizeDiscordLabel(String(row.project_id || "")), normalizeDiscordLabel(String(policy.projectSlug || "")), ...topicKeys(String(policy.topic || ""))];
      return candidates.some((candidate) => candidate && keys.has(candidate));
    });
    if (matches.length === 0) {
      if (!this.discord.ensureProjectChannel) throw new WorkroomError("WORKROOM_PROJECT_NOT_FOUND");
      try {
        const created = await this.discord.ensureProjectChannel(project.projectId, project.name);
        this.tasks.bindProjectChannel(project.projectId, created.id);
        const now = this.store.now();
        this.store.db.prepare(`INSERT INTO discord_mappings(discord_id,guild_id,parent_id,kind,name,project_id,task_id,policy_json,discovered_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET name=excluded.name,project_id=excluded.project_id,policy_json=excluded.policy_json,updated_at=excluded.updated_at`)
          .run(created.id, "UNKNOWN", created.categoryId, "CHANNEL", created.name, normalizeDiscordLabel(project.projectId), null,
            JSON.stringify({ projectDiscovery: true, projectSlug: normalizeDiscordLabel(project.projectId), createdBy: "SYMPHONY_PROJECT_ROUTER" }), now, now);
        return created.id;
      } catch (error) {
        throw new WorkroomError("WORKROOM_PROJECT_NOT_FOUND", error instanceof Error ? error.message : String(error));
      }
    }
    if (matches.length > 1) throw new WorkroomError("WORKROOM_PROJECT_AMBIGUOUS");
    return String(matches[0]!.discord_id);
  }

  private persist(task: TaskRecord, thread: DiscordThreadSnapshot, state: WorkroomRecord["state"], reason: WorkroomReason, bootstrapMessageId?: string): WorkroomRecord {
    const now = this.store.now(); const createdAt = this.get(task.taskId)?.createdAt || now; const archivedAt = state === "ARCHIVED" ? now : null;
    this.store.db.prepare(`INSERT INTO workrooms(task_id,thread_id,parent_channel_id,thread_name,state,bootstrap_message_id,created_at,archived_at,last_synced_at,last_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET thread_id=excluded.thread_id,parent_channel_id=excluded.parent_channel_id,
      thread_name=excluded.thread_name,state=excluded.state,bootstrap_message_id=COALESCE(excluded.bootstrap_message_id,workrooms.bootstrap_message_id),
      archived_at=excluded.archived_at,last_synced_at=excluded.last_synced_at,last_reason=excluded.last_reason`)
      .run(task.taskId, thread.id, thread.parentId, thread.name, state, bootstrapMessageId ?? null, createdAt, archivedAt, now, reason);
    this.upsertMapping(task, thread, reason); this.store.upsertRuntimeState(`workroom:last_event:${task.taskId}`, { reason, threadId: thread.id, at: now });
    return this.get(task.taskId)!;
  }

  private upsertMapping(task: TaskRecord, thread: DiscordThreadSnapshot, reason: WorkroomReason): void {
    const parent = this.store.db.prepare("SELECT guild_id FROM discord_mappings WHERE discord_id=?").get(thread.parentId) as { guild_id: string } | undefined;
    this.store.db.prepare(`INSERT INTO discord_mappings(discord_id,guild_id,parent_id,kind,name,project_id,task_id,policy_json,discovered_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(discord_id) DO UPDATE SET parent_id=excluded.parent_id,kind=excluded.kind,name=excluded.name,
      project_id=excluded.project_id,task_id=excluded.task_id,policy_json=excluded.policy_json,updated_at=excluded.updated_at`)
      .run(thread.id, parent?.guild_id || "UNKNOWN", thread.parentId, "WORKROOM", thread.name, task.projectId, task.taskId,
        JSON.stringify({ inheritParent: true, workroom: true, reason }), this.store.now(), this.store.now());
  }

  private recordMissing(task: TaskRecord, threadId: string, parentChannelId?: string): void {
    const now = this.store.now(); const prior = this.get(task.taskId);
    this.store.db.prepare(`INSERT INTO workrooms(task_id,thread_id,parent_channel_id,thread_name,state,bootstrap_message_id,created_at,last_synced_at,last_reason)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET state='MISSING',last_synced_at=excluded.last_synced_at,last_reason='WORKROOM_MISSING'`)
      .run(task.taskId, threadId, parentChannelId || prior?.parentChannelId || "UNKNOWN", prior?.threadName || task.taskId, "MISSING",
        prior?.bootstrapMessageId ?? null, prior?.createdAt || now, now, "WORKROOM_MISSING");
    this.store.upsertRuntimeState(`workroom:issue:${task.taskId}`, { reason: "WORKROOM_MISSING", threadId, at: now });
  }
}

function rowToWorkroom(row: Record<string, unknown>): WorkroomRecord {
  return { taskId: String(row.task_id), threadId: String(row.thread_id), parentChannelId: String(row.parent_channel_id), threadName: String(row.thread_name),
    state: row.state as WorkroomRecord["state"], ...(row.bootstrap_message_id ? { bootstrapMessageId: String(row.bootstrap_message_id) } : {}),
    createdAt: String(row.created_at), ...(row.archived_at ? { archivedAt: String(row.archived_at) } : {}), lastSyncedAt: String(row.last_synced_at), lastReason: row.last_reason as WorkroomReason };
}
function parsePolicy(value: unknown): Record<string, unknown> { try { return JSON.parse(String(value)) as Record<string, unknown>; } catch { return {}; } }
function topicKeys(topic: string): string[] {
  const values: string[] = []; const pattern = /\b(?:project|project_id|project-id)\s*[:=]\s*([\p{L}\p{N}_-]+)/giu;
  for (const match of topic.matchAll(pattern)) values.push(normalizeDiscordLabel(match[1] || "")); return values.filter(Boolean);
}
function beforeMapping(store: Store, threadId: string, taskId: string): boolean { return Boolean(store.db.prepare("SELECT 1 FROM discord_mappings WHERE discord_id=? AND task_id=?").get(threadId, taskId)); }
function isTerminalRecovery(task: TaskRecord): boolean { return task.status !== "PASS" && task.status !== "CANCELLED" && String(task.result || "").startsWith("RECOVERY_REOPENED_FROM_CANCELLED:"); }
function list(values: string[]): string { return values.length ? values.map((item) => `- ${item}`).join("\n") : "- none"; }
function renderBrief(task: TaskRecord, project: ProjectRecord): string {
  return `[SYMPHONY WORKROOM]\n\nTASK_ID: ${task.taskId}\nPROJECT: ${project.name}\nTITLE: ${task.title}\nGOAL: ${task.goal}\n\nCURRENT_STATUS: ${task.status}\nREQUIRED_ROLE: ${task.role}\nASSIGNED_AGENT: ${task.assignedAgent || "UNASSIGNED"}\nWORKSPACE: ${task.workspace}\n\nFILE_SCOPE:\n${list(task.fileScope)}\n\nDO_NOT:\n${list(task.doNot)}\n\nVALIDATION:\n${list(task.validation)}\n\nOWNER: ${task.owner}\nNEXT_OWNER: ${task.nextOwner || "MAIN"}`.slice(0, 1_950);
}
