import type { AgentId, Role, TaskRecord, TaskRoleRecord } from "../domain/types.js";
import { agentToBotType } from "../discord/control/types.js";
import type { AgentRegistry } from "../registry/agentRegistry.js";
import type { AgentRouter } from "../routing/agentRouter.js";
import type { Store } from "../storage/database.js";
import type { TeamRepository } from "../teams/repository.js";
import type { WorkspaceLocks } from "../tasks/locks.js";
import type { Protocol } from "../tasks/protocol.js";
import type { TaskRepository } from "../tasks/repository.js";
import { canCompleteTeam } from "../review/verdict.js";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { RunBudgetController } from "./runBudget.js";
import { continuationDispatchPayload } from "./continuationIntent.js";

export type NoProgressClassification =
  | "PROCESS_STILL_RUNNING"
  | "PROCESS_EXITED_WITH_RESULT"
  | "WORKER_FAILED_WITH_RESULT"
  | "PROCESS_LOST"
  | "RECEIVED_BUT_NOT_STARTED"
  | "CLAIMED_BUT_NOT_STARTED"
  | "ACTIVE_NO_PROGRESS"
  | "RUNNING_NO_PROGRESS"
  | "WAITING_RESULT_NO_PROGRESS"
  | "STALE_INBOUND"
  | "ROUTING_BLOCKED"
  | "WORKER_UNAVAILABLE"
  | "DURABLE_STATE_ORPHAN"
  | "OTHER_EVIDENCE_BACKED_STATE";

export interface ContinuationWatchPolicy {
  startDeadlineMs: number;
  progressDeadlineMs: number;
  resultDeadlineMs: number;
  maxRecoveries: number;
}

export interface ContinuationObservation {
  taskId: string;
  projectId: string;
  role?: Role;
  roleSequence?: number;
  revisionRound?: number;
  assignedAgent?: AgentId;
  classification: NoProgressClassification;
  reason: string;
  actionable: boolean;
  action: "NONE" | "PROGRESS_EVIDENCE" | "DUPLICATE_SUPPRESSED" | "CANCEL_REQUESTED" | "BOUNDED_RETRY" | "REASSIGNED" | "RETRIED" | "STALE_SUPPRESSED" | "SAFE_STOP" | "DELIVERY_FAILED";
}

export interface ContinuationRunReport {
  reason: string;
  watchedTaskIds: string[];
  observations: ContinuationObservation[];
  globalDispatcherTickUsed: false;
}

interface WatchRow {
  task_id: string; project_id: string; start_deadline_ms: number; progress_deadline_ms: number;
  result_deadline_ms: number; max_recoveries: number;
}

interface TaskVersionRow { updated_at: string; }
interface ProcessRow {
  process_id: string; agent_id: AgentId; attempt: number; pid: number; started_at: string; last_seen: string;
  exit_code: number | null; status: string; log_path: string;
}
interface InboundRow {
  discord_message_id: string; recipient: string; role: Role | null; discussion_round: number; received_at: string;
}
interface ResultEventRow {
  event_id: string; event_type: string; sender: string; recipient: string; payload_json: string; created_at: string;
}

interface Snapshot {
  task: TaskRecord;
  taskVersion: string;
  role?: TaskRoleRecord | undefined;
  process?: ProcessRow | undefined;
  inbound?: InboundRow | undefined;
  staleInbound?: InboundRow | undefined;
  resultEvent?: ResultEventRow | undefined;
  classification: NoProgressClassification;
  reason: string;
  actionable: boolean;
}

export interface ScopedContinuationWatchdogOptions {
  nowMs?: () => number;
  pidAlive?: (pid: number) => boolean;
  cancelTask?: (taskId: string) => boolean;
  terminatePid?: (pid: number) => boolean;
  readProcessLog?: (logPath: string) => string;
  refreshHealth?: () => Promise<void>;
}

const DEFAULT_POLICY: ContinuationWatchPolicy = {
  startDeadlineMs: 120_000,
  progressDeadlineMs: 900_000,
  resultDeadlineMs: 60_000,
  maxRecoveries: 3,
};

const TERMINAL = new Set(["PASS", "FAIL", "CANCELLED"]);
const RESULT_EVENT: Partial<Record<Role, string>> = { REVIEWER: "REVIEW", ARCHITECT: "REVIEW", QA: "QA_RESULT" };

function resultIndicatesFailure(expectedResult: string, payloadJson: string): boolean {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if ("ok" in payload) return payload.ok === false;
    if (expectedResult === "REVIEW") return String(payload.verdict || "").toUpperCase() === "REVIEW_FAIL";
    if (expectedResult === "QA_RESULT") return String(payload.status || "").toUpperCase() === "FAIL";
    return false;
  } catch {
    return /FAILED TO AUTHENTICATE|API Error/i.test(payloadJson);
  }
}

function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function terminateProcess(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return result.status === 0;
    }
    process.kill(pid, "SIGTERM"); return true;
  } catch { return false; }
}

/**
 * Durable, Task-scoped continuation owned by the existing watchdog timer.
 *
 * This is deliberately not a scheduler: it only evaluates explicitly watched
 * Task ids, never calls Dispatcher.tick(), never creates Tasks, and emits at
 * most one fenced retry for the current Role/revision at a time.
 */
export class ScopedContinuationWatchdog {
  private readonly nowMs: () => number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly cancelTask: (taskId: string) => boolean;
  private readonly terminatePid: (pid: number) => boolean;
  private readonly readProcessLog: (logPath: string) => string;
  private readonly refreshHealth: () => Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly tasks: TaskRepository,
    private readonly teams: TeamRepository,
    private readonly agents: AgentRegistry,
    private readonly locks: WorkspaceLocks,
    private readonly router: AgentRouter,
    private readonly protocol: Pick<Protocol, "emit">,
    options: ScopedContinuationWatchdogOptions = {}, private readonly runBudget?: RunBudgetController,
  ) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.pidAlive = options.pidAlive ?? processAlive;
    this.cancelTask = options.cancelTask ?? (() => false);
    this.terminatePid = options.terminatePid ?? terminateProcess;
    this.readProcessLog = options.readProcessLog ?? ((logPath) => { try { return readFileSync(logPath, "utf8").slice(-256_000); } catch { return ""; } });
    this.refreshHealth = options.refreshHealth ?? (async () => {});
  }

  watch(projectId: string, taskIds: readonly string[], policy: Partial<ContinuationWatchPolicy> = {}): void {
    const effective = { ...DEFAULT_POLICY, ...policy };
    if (!taskIds.length) throw new Error("CONTINUATION_SCOPE_EMPTY");
    if ([effective.startDeadlineMs, effective.progressDeadlineMs, effective.resultDeadlineMs, effective.maxRecoveries].some((v) => !Number.isInteger(v) || v <= 0))
      throw new Error("CONTINUATION_POLICY_INVALID");
    const now = this.store.now();
    this.store.transaction(() => {
      for (const taskId of [...new Set(taskIds)]) {
        const task = this.tasks.get(taskId);
        if (!task || task.projectId !== projectId) throw new Error(`CONTINUATION_SCOPE_MISMATCH:${taskId}`);
        this.store.db.prepare(`INSERT INTO continuation_watches(task_id,project_id,enabled,start_deadline_ms,progress_deadline_ms,result_deadline_ms,max_recoveries,created_at,updated_at)
          VALUES(?,?,1,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET project_id=excluded.project_id,enabled=1,
          start_deadline_ms=excluded.start_deadline_ms,progress_deadline_ms=excluded.progress_deadline_ms,
          result_deadline_ms=excluded.result_deadline_ms,max_recoveries=excluded.max_recoveries,updated_at=excluded.updated_at`)
          .run(taskId, projectId, effective.startDeadlineMs, effective.progressDeadlineMs, effective.resultDeadlineMs, effective.maxRecoveries, now, now);
      }
    });
  }

  unwatch(taskId: string): void {
    this.store.db.prepare("UPDATE continuation_watches SET enabled=0,updated_at=? WHERE task_id=?").run(this.store.now(), taskId);
  }

  watchedTaskIds(): string[] {
    return (this.store.db.prepare("SELECT task_id FROM continuation_watches WHERE enabled=1 ORDER BY task_id").all() as Array<{ task_id: string }>).map((r) => r.task_id);
  }

  async runOnce(reason: string): Promise<ContinuationRunReport> {
    const watches = this.store.db.prepare("SELECT * FROM continuation_watches WHERE enabled=1 ORDER BY project_id,task_id").all() as unknown as WatchRow[];
    const observations: ContinuationObservation[] = [];
    for (const watch of watches) observations.push(await this.runTask(watch));
    const report: ContinuationRunReport = { reason, watchedTaskIds: watches.map((w) => w.task_id), observations, globalDispatcherTickUsed: false };
    this.store.upsertRuntimeState("runtime:scoped_continuation:last_run", report);
    return report;
  }

  private async runTask(watch: WatchRow): Promise<ContinuationObservation> {
    if (this.runBudget && !this.runBudget.canContinue(watch.task_id)) {
      const task = this.tasks.get(watch.task_id)!;
      return { taskId: task.taskId, projectId: task.projectId, classification: "OTHER_EVIDENCE_BACKED_STATE", reason: "RUN_BUDGET_EXHAUSTED", actionable: false, action: "SAFE_STOP" };
    }
    const snapshot = this.snapshot(watch);
    const base: ContinuationObservation = {
      taskId: snapshot.task.taskId, projectId: snapshot.task.projectId,
      ...(snapshot.role ? { role: snapshot.role.role, roleSequence: snapshot.role.sequence, revisionRound: snapshot.role.revisionRound } : {}),
      ...(snapshot.role?.assignedAgent ? { assignedAgent: snapshot.role.assignedAgent } : {}),
      classification: snapshot.classification, reason: snapshot.reason, actionable: snapshot.actionable, action: "NONE",
    };
    if (!snapshot.role || TERMINAL.has(snapshot.task.status)) {
      this.unwatch(snapshot.task.taskId);
      return { ...base, action: snapshot.task.status === "PASS" ? "PROGRESS_EVIDENCE" : "NONE" };
    }
    this.recordObservation(snapshot);
    if (!snapshot.actionable) {
      const progress = snapshot.classification === "PROCESS_STILL_RUNNING" || snapshot.classification === "PROCESS_EXITED_WITH_RESULT";
      if (progress) this.markAction(snapshot, "PROGRESS_EVIDENCE", false, true);
      return { ...base, action: progress ? "PROGRESS_EVIDENCE" : "NONE" };
    }
    return { ...base, ...(await this.recover(watch, snapshot)) };
  }

  private snapshot(watch: WatchRow): Snapshot {
    const task = this.tasks.get(watch.task_id);
    if (!task || task.projectId !== watch.project_id) throw new Error(`CONTINUATION_SCOPE_MISMATCH:${watch.task_id}`);
    const version = (this.store.db.prepare("SELECT updated_at FROM tasks WHERE task_id=?").get(task.taskId) as unknown as TaskVersionRow).updated_at;
    const roles = this.teams.roles(task.taskId);
    const team = this.teams.get(task.taskId);
    let role = roles.find((r) => r.sequence === team?.currentSequence) || roles.find((r) => r.sequence === task.currentRoleSequence);
    if (!role || role.status === "PASS") role = roles.find((r) => !["PASS", "SKIPPED"].includes(r.status));
    if (!role && roles.length > 0 && roles.every((item) => item.status === "PASS") && !canCompleteTeam(task, roles)) {
      const qa = roles.find((item) => item.role === "QA");
      const contributors = new Set(roles.filter((item) => ["DEVELOPER", "DEBUGGER", "REFACTORER", "REVIEWER"].includes(item.role) && item.assignedAgent).map((item) => item.assignedAgent));
      if (qa?.assignedAgent && contributors.has(qa.assignedAgent)) role = qa;
    }
    if (!role || task.executionHold || task.status === "HUMAN_GATE") return { task, taskVersion: version, role, classification: "OTHER_EVIDENCE_BACKED_STATE", reason: task.executionHold ? "EXECUTION_HOLD" : "NO_MACHINE_ACTIONABLE_ROLE", actionable: false };

    const processRow = role.assignedAgent ? this.store.db.prepare(`SELECT process_id,agent_id,attempt,pid,started_at,last_seen,exit_code,status,log_path FROM worker_processes
      WHERE task_id=? AND agent_id=? AND attempt=? ORDER BY started_at DESC LIMIT 1`).get(task.taskId, role.assignedAgent, task.attempt) as ProcessRow | undefined : undefined;
    const inbound = this.store.db.prepare(`SELECT discord_message_id,recipient,role,discussion_round,received_at FROM inbound_messages
      WHERE task_id=? AND state='RECEIVED' AND role=? AND discussion_round=? ORDER BY received_at DESC LIMIT 1`)
      .get(task.taskId, role.role, role.revisionRound) as InboundRow | undefined;
    const roleReference = role.startedAt || version;
    // A Discord delivery can arrive after a newer recovery dispatch even when
    // its envelope was created by the older execution.  received_at is
    // therefore not an execution-generation fence.  Use the latest durable
    // TASK dispatch for this exact Task/Role/round as the provenance boundary,
    // falling back to the legacy Role start timestamp for older records that
    // have no persisted dispatch event.
    const dispatchRows = this.store.db.prepare(`SELECT created_at,payload_json FROM protocol_events
      WHERE task_id=? AND event_type='TASK' AND recipient IN (?,?) ORDER BY created_at DESC`).all(
      task.taskId, role.assignedAgent || "", role.assignedAgent ? agentToBotType(role.assignedAgent) : "") as Array<{ created_at: string; payload_json: string }>;
    const currentDispatch = dispatchRows.find((row) => {
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        return String(payload.role || "") === role.role && Number(payload.round ?? -1) === role.revisionRound;
      } catch { return false; }
    });
    const executionReference = currentDispatch?.created_at || roleReference;
    const staleInbound = this.store.db.prepare(`SELECT discord_message_id,recipient,role,discussion_round,received_at FROM inbound_messages
      WHERE task_id=? AND state='RECEIVED' AND created_at>=? AND (role<>? OR discussion_round<>? OR recipient<>?) ORDER BY created_at DESC LIMIT 1`)
      .get(task.taskId, executionReference, role.role, role.revisionRound, role.assignedAgent ? agentToBotType(role.assignedAgent) : "") as InboundRow | undefined;
    const now = this.nowMs();
    const age = (value?: string) => value ? now - Date.parse(value) : Number.POSITIVE_INFINITY;
    const expectedResult = RESULT_EVENT[role.role] || "RESULT";
    const result = processRow ? this.store.db.prepare(`SELECT event_id,event_type,sender,recipient,payload_json,created_at FROM protocol_events
      WHERE task_id=? AND event_type=? AND created_at>=? ORDER BY created_at DESC LIMIT 1`)
      .get(task.taskId, expectedResult, processRow.started_at) as ResultEventRow | undefined : undefined;
    const policy: ContinuationWatchPolicy = { startDeadlineMs: Number(watch.start_deadline_ms), progressDeadlineMs: Number(watch.progress_deadline_ms), resultDeadlineMs: Number(watch.result_deadline_ms), maxRecoveries: Number(watch.max_recoveries) };

    if (processRow) {
      if (processRow.status === "RUNNING") {
        if (!this.pidAlive(processRow.pid)) return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, classification: "PROCESS_LOST", reason: `PID ${processRow.pid} is absent`, actionable: true };
        const processLog = this.readProcessLog(processRow.log_path);
        if (/(weekly usage limit reached|usage limit[^\r\n]*resets?|rate limit(?:ed)?|quota (?:exceeded|exhausted)|insufficient_quota)/i.test(processLog))
          return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, classification: "WORKER_UNAVAILABLE", reason: "WORKER_PROVIDER_CAPACITY_EXHAUSTED", actionable: true };
        const pipeTimeouts = new Set(processLog.split(/\r?\n/)
          .filter((line) => line.includes("Failed to create unified exec process") && line.includes("timed out after 15000ms"))
          .map((line) => line.match(/^\[([^\]]+)\]/)?.[1] || line)).size;
        if (pipeTimeouts >= 3) return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, classification: "RUNNING_NO_PROGRESS", reason: `REPEATED_CODEX_PIPE_TIMEOUT:${pipeTimeouts}`, actionable: true };
        if (age(processRow.last_seen) >= policy.progressDeadlineMs) return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, classification: "RUNNING_NO_PROGRESS", reason: `No process output/heartbeat for ${age(processRow.last_seen)}ms`, actionable: true };
        return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, classification: "PROCESS_STILL_RUNNING", reason: `PID ${processRow.pid} alive; heartbeat age ${age(processRow.last_seen)}ms`, actionable: false };
      }
      if (result && this.reviewRevisionHandoffMissing(task, role, result, roles)) {
        const resultAge = age(result.created_at);
        return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, resultEvent: result,
          classification: "DURABLE_STATE_ORPHAN", reason: `REVIEW persisted without its revision handoff; age ${resultAge}ms`, actionable: resultAge >= policy.resultDeadlineMs };
      }
      if (result) {
        // A durable failed Result (ok:false / REVIEW_FAIL / QA FAIL) is worker
        // failure evidence, not progress: the Company must reassign the Role
        // instead of waiting forever behind it.
        if (resultIndicatesFailure(expectedResult, result.payload_json))
          return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, resultEvent: result,
            classification: "WORKER_FAILED_WITH_RESULT", reason: `${expectedResult} recorded worker failure after process start`, actionable: true };
        return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, resultEvent: result, classification: "PROCESS_EXITED_WITH_RESULT", reason: `${expectedResult} exists after process start`, actionable: false };
      }
      if (["LOST", "CANCELLED"].includes(processRow.status)) return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, classification: "PROCESS_LOST", reason: `Process is durably ${processRow.status}`, actionable: true };
      const exitAge = age(processRow.last_seen);
      return { task, taskVersion: version, role, process: processRow, inbound, staleInbound, classification: "WAITING_RESULT_NO_PROGRESS", reason: `Process ${processRow.status} without ${expectedResult}; age ${exitAge}ms`, actionable: exitAge >= policy.resultDeadlineMs };
    }
    if (staleInbound && !inbound) return { task, taskVersion: version, role, staleInbound, classification: "STALE_INBOUND", reason: `Received message ${staleInbound.discord_message_id} does not match current Role/round/worker`, actionable: true };
    if (inbound) {
      const receivedAge = age(inbound.received_at);
      return { task, taskVersion: version, role, inbound, staleInbound, classification: "RECEIVED_BUT_NOT_STARTED", reason: `Inbound received without process; age ${receivedAge}ms`, actionable: receivedAge >= policy.startDeadlineMs };
    }
    const agent = role.assignedAgent ? this.agents.get(role.assignedAgent) : undefined;
    if (!role.assignedAgent || !agent || agent.health !== "ONLINE") return { task, taskVersion: version, role, classification: "WORKER_UNAVAILABLE", reason: role.assignedAgent ? `${role.assignedAgent} is ${agent?.health || "MISSING"}` : "Role has no assigned Worker", actionable: true };
    const reference = roleReference;
    const stalled = age(reference) >= policy.startDeadlineMs;
    if (task.status === "WAITING_MAIN") return { task, taskVersion: version, role, classification: "DURABLE_STATE_ORPHAN", reason: "Machine-actionable Role was left WAITING_MAIN", actionable: true };
    if (task.status === "CLAIMED") return { task, taskVersion: version, role, classification: "CLAIMED_BUT_NOT_STARTED", reason: `CLAIMED without process; age ${age(reference)}ms`, actionable: stalled };
    if (task.status === "RUNNING") return { task, taskVersion: version, role, classification: "RUNNING_NO_PROGRESS", reason: `RUNNING without process; age ${age(reference)}ms`, actionable: stalled };
    if (task.status === "WAITING_RESULT") return { task, taskVersion: version, role, classification: "WAITING_RESULT_NO_PROGRESS", reason: `WAITING_RESULT without process/result; age ${age(reference)}ms`, actionable: age(reference) >= policy.resultDeadlineMs };
    if (role.status === "ACTIVE") return { task, taskVersion: version, role, classification: "ACTIVE_NO_PROGRESS", reason: `ACTIVE Role without process; age ${age(reference)}ms`, actionable: stalled };
    return { task, taskVersion: version, role, classification: "ROUTING_BLOCKED", reason: `${task.status}/${role.status} has no inbound or process`, actionable: age(version) >= policy.startDeadlineMs };
  }

  private async recover(watch: WatchRow, snapshot: Snapshot): Promise<Pick<ContinuationObservation, "action" | "assignedAgent">> {
    const role = snapshot.role!;
    const state = this.state(snapshot);
    if (snapshot.classification === "WORKER_UNAVAILABLE" && role.assignedAgent)
      this.agents.setHealth(role.assignedAgent, { status: "ERROR", detail: snapshot.reason });
    if (state.retry_count >= watch.max_recoveries) {
      if (snapshot.process && ["RUNNING", "CANCELLED"].includes(snapshot.process.status) && this.pidAlive(snapshot.process.pid)) {
        const requested = this.terminatePid(snapshot.process.pid) || this.cancelTask(snapshot.task.taskId);
        if (requested) this.store.db.prepare("UPDATE worker_processes SET status='CANCELLED',last_seen=? WHERE process_id=? AND status='RUNNING'")
          .run(this.store.now(), snapshot.process.process_id);
        else {
          this.safeStop(snapshot, `Recovery bound ${watch.max_recoveries} exhausted and live PID ${snapshot.process.pid} could not be fenced`);
          return { action: "SAFE_STOP", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
        }
      }
      this.safeStop(snapshot, `Recovery bound ${watch.max_recoveries} exhausted after ${snapshot.classification}`);
      return { action: "SAFE_STOP", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
    }
    const acquired = this.store.db.prepare(`UPDATE continuation_recovery_state SET wake_in_progress=1,retry_count=retry_count+1,
      last_action='RECOVERY_ACQUIRED',last_wake_at=?,updated_at=? WHERE task_id=? AND role_sequence=? AND revision_round=? AND wake_in_progress=0 AND retry_count<?`)
      .run(this.store.now(), this.store.now(), snapshot.task.taskId, role.sequence, role.revisionRound, watch.max_recoveries);
    if (Number(acquired.changes) !== 1) return { action: "DUPLICATE_SUPPRESSED", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };

    if (!this.isCurrent(snapshot)) {
      this.markAction(snapshot, "STALE_SUPPRESSED", false);
      return { action: "STALE_SUPPRESSED", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
    }
    if (snapshot.classification === "DURABLE_STATE_ORPHAN" && snapshot.resultEvent && ["REVIEWER", "ARCHITECT"].includes(role.role))
      return this.replayReviewRevision(snapshot);
    if (snapshot.process && ["RUNNING", "CANCELLED"].includes(snapshot.process.status) && this.pidAlive(snapshot.process.pid)) {
      const requestedAt = state.cancel_requested_at;
      const cancelAge = requestedAt ? this.nowMs() - Date.parse(requestedAt) : 0;
      if (requestedAt && cancelAge >= watch.result_deadline_ms * 2) {
        this.safeStop(snapshot, `Live PID ${snapshot.process.pid} resisted bounded cancellation for ${cancelAge}ms`);
        return { action: "SAFE_STOP", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
      }
      const requested = requestedAt
        ? this.terminatePid(snapshot.process.pid)
        : this.terminatePid(snapshot.process.pid) || this.cancelTask(snapshot.task.taskId);
      if (!requested) {
        this.safeStop(snapshot, `Could not fence live PID ${snapshot.process.pid}`);
        return { action: "SAFE_STOP", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
      }
      const now = new Date(this.nowMs()).toISOString();
      this.store.db.prepare(`UPDATE continuation_recovery_state SET
        retry_count=CASE WHEN retry_count>0 THEN retry_count-1 ELSE 0 END,wake_in_progress=0,
        last_action='CANCEL_REQUESTED',cancel_requested_at=COALESCE(cancel_requested_at,?),updated_at=?
        WHERE task_id=? AND role_sequence=? AND revision_round=?`)
        .run(now, now, snapshot.task.taskId, role.sequence, role.revisionRound);
      return { action: "CANCEL_REQUESTED", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
    }

    this.fence(snapshot);
    // Refresh deterministic CLI availability only when a recovery is already
    // actionable. This lets transiently failed Workers re-enter the bounded
    // fallback pool without an Owner message or idle inference polling.
    await this.refreshHealth();
    const teamRoles = this.teams.roles(snapshot.task.taskId);
    const prior: Partial<Record<Role, AgentId>> = {};
    for (const item of teamRoles) if (item.assignedAgent && item.sequence < role.sequence && item.status === "PASS") prior[item.role] = item.assignedAgent;
    // Downstream Reviewer/QA reservations must stay visible to an upstream execution Role's
    // recovery routing even though they have not PASSed yet -- otherwise a replacement
    // Developer could be handed to a Worker already reserved as the independent Reviewer or
    // QA for this Task, collapsing separation-of-duties (V1 recovery SoD correction,
    // a prior bounded run). AgentRouter.route() enforces the actual exclusion; this
    // only makes the reservation visible to it.
    for (const item of teamRoles) if (item.assignedAgent && item.sequence > role.sequence && (item.role === "REVIEWER" || item.role === "QA")) prior[item.role] = item.assignedAgent;
    const excluded = new Set<AgentId>();
    if (role.assignedAgent) excluded.add(role.assignedAgent);
    // Durable recovery-lineage exclusion: every Worker ever selected to hold this exact Role
    // on this Task -- across every recovery cycle and Runtime restart -- stays excluded.
    // routing_decisions is append-only and durable (unlike the in-memory Watchdog process),
    // so a Worker that already failed this Role cannot become eligible again merely because a
    // *different* Worker failed afterward or the Runtime restarted (V1 recovery SoD
    // correction from a prior bounded run).
    const roleHistory = this.store.db.prepare(
      "SELECT DISTINCT selected_agent FROM routing_decisions WHERE task_id=? AND sequence=? AND selected_agent IS NOT NULL",
    ).all(snapshot.task.taskId, role.sequence) as Array<{ selected_agent: AgentId }>;
    for (const row of roleHistory) excluded.add(row.selected_agent);
    if (role.role === "QA") for (const agent of Object.values(prior)) if (agent) excluded.add(agent);
    // Worker-failure fallback fencing: a Worker whose latest durable attempt on
    // this Task failed must not win replacement routing back through
    // deterministic scoring -- CLI health probes cannot see execution-
    // environment failures (e.g. Codex unified-exec runner pipe timeouts).
    // The most recent attempt defines standing: a newer successful attempt
    // restores eligibility.  This is a routing PREFERENCE, not an absolute
    // bar: if every candidate carries a failed latest attempt (restart churn,
    // cascading environment faults), the second pass still selects the best
    // available Worker -- ordinary failure must not strand the Task because
    // the recovery bound already caps repeat offenders.
    const latestAttempts = this.store.db.prepare(`SELECT wp.agent_id, wp.status, wp.exit_code FROM worker_processes wp
      JOIN (SELECT agent_id, MAX(started_at) AS started_at FROM worker_processes WHERE task_id=? GROUP BY agent_id) latest
      ON latest.agent_id=wp.agent_id AND latest.started_at=wp.started_at
      WHERE wp.task_id=?`).all(snapshot.task.taskId, snapshot.task.taskId) as Array<{ agent_id: AgentId; status: string; exit_code: number | null }>;
    const failedStanding = new Set<AgentId>();
    for (const attempt of latestAttempts) {
      if (attempt.status === "LOST" || (attempt.status === "EXITED" && attempt.exit_code !== null && attempt.exit_code !== 0)) failedStanding.add(attempt.agent_id);
    }
    const preferred = new Set([...excluded, ...failedStanding]);
    let decision = this.router.route(snapshot.task, role.role, prior, undefined, preferred);
    if (!decision.selectedAgent && failedStanding.size) {
      decision = this.router.route(snapshot.task, role.role, prior, undefined, excluded);
    }
    let temporarilyBusy = decision.rejected.some((candidate) => candidate.reasons.length > 0
      && candidate.reasons.every((reason) => reason === "ROUTING_AGENT_BUSY"));
    const sameWorkerRetryable = new Set<NoProgressClassification>(["RECEIVED_BUT_NOT_STARTED", "STALE_INBOUND", "CLAIMED_BUT_NOT_STARTED", "ACTIVE_NO_PROGRESS"]);
    if (!decision.selectedAgent && !temporarilyBusy && role.assignedAgent && sameWorkerRetryable.has(snapshot.classification)) {
      const qaOnly = new Set<AgentId>(role.role === "QA" ? Object.values(prior).filter(Boolean) as AgentId[] : []);
      decision = this.router.route(snapshot.task, role.role, prior, undefined, qaOnly);
      temporarilyBusy = false;
    }
    this.teams.recordDecision(snapshot.task.taskId, role.sequence, decision);
    if (!decision.selectedAgent) {
      if (temporarilyBusy) {
        const capacityState = this.state(snapshot);
        const startedAt = capacityState.capacity_wait_started_at;
        const capacityAge = startedAt ? this.nowMs() - Date.parse(startedAt) : 0;
        if (!startedAt || capacityAge < watch.progress_deadline_ms) {
          const now = new Date(this.nowMs()).toISOString();
          this.store.db.prepare(`UPDATE continuation_recovery_state SET
            retry_count=CASE WHEN retry_count>0 THEN retry_count-1 ELSE 0 END,wake_in_progress=0,
            last_action='CAPACITY_WAIT',capacity_wait_started_at=COALESCE(capacity_wait_started_at,?),updated_at=?
            WHERE task_id=? AND role_sequence=? AND revision_round=?`)
            .run(now, now, snapshot.task.taskId, role.sequence, role.revisionRound);
          return { action: "BOUNDED_RETRY", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
        }
      }
      this.safeStop(snapshot, `${decision.reasonCode}: ${decision.rejected.map((r) => `${r.agentId}=${r.reasons.join("+")}`).join(",")}`);
      return { action: "SAFE_STOP", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
    }
    const selected = decision.selectedAgent;
    if (role.assignedAgent && selected !== role.assignedAgent) this.agents.setHealth(role.assignedAgent, { status: "ERROR", detail: `CONTINUATION_${snapshot.classification}` });
    if (!this.isCurrent(snapshot)) {
      this.markAction(snapshot, "STALE_SUPPRESSED", false);
      return { action: "STALE_SUPPRESSED", assignedAgent: selected };
    }

    this.teams.assign(snapshot.task.taskId, role.sequence, selected, `CONTINUATION_FALLBACK: ${snapshot.classification}; ${decision.reasonCode}`);
    this.store.db.prepare("UPDATE task_teams SET status='ACTIVE',current_sequence=?,updated_at=? WHERE task_id=?").run(role.sequence, this.store.now(), snapshot.task.taskId);
    this.tasks.setCurrentTeamRole(snapshot.task.taskId, role.sequence, role.role, selected);
    let task = this.tasks.get(snapshot.task.taskId)!;
    if (task.status === "DISPATCHED") task = this.tasks.transition(task.taskId, "QUEUED");
    else if (["CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING"].includes(task.status)) task = this.tasks.transition(task.taskId, "WAITING_MAIN", { result: `RECOVERY_FENCE:${snapshot.classification}` });
    else if (task.status === "BLOCKED") task = this.tasks.transition(task.taskId, "QUEUED");
    if (task.status === "QUEUED" || task.status === "WAITING_MAIN") task = this.tasks.transition(task.taskId, "DISPATCHED", { assignedAgent: selected, attempt: task.attempt + 1 });
    if (task.status !== "DISPATCHED") {
      this.safeStop(snapshot, `Cannot re-dispatch from ${task.status}`);
      return { action: "SAFE_STOP", assignedAgent: selected };
    }
    this.agents.markBusy(selected, task.taskId, task.projectId, role.role, task.workspace);
    const retry = this.state(snapshot).retry_count;
    const dispatchId = `watchdog:${task.taskId}:${role.sequence}:${role.revisionRound}:${retry}`;
    const version = (this.store.db.prepare("SELECT updated_at FROM tasks WHERE task_id=?").get(task.taskId) as unknown as TaskVersionRow).updated_at;
    try {
      const intent = this.runBudget?.continuation(task.taskId, role.role, role.revisionRound);
      await this.protocol.emit("TASK", task, "ORCHESTRATOR", selected, {
        title: task.title, ...continuationDispatchPayload(task.goal, intent), role: role.role, round: role.revisionRound,
        dispatch_id: dispatchId, retry_attempt: retry, task_version: version, recovery_reason: snapshot.classification,
      });
      this.markAction(snapshot, selected === role.assignedAgent ? "RETRIED" : "REASSIGNED", false, true);
      return { action: selected === role.assignedAgent ? "RETRIED" : "REASSIGNED", assignedAgent: selected };
    } catch (error) {
      if (this.agents.get(selected)?.currentTask === task.taskId) this.agents.release(selected, true);
      this.markAction(snapshot, `DELIVERY_FAILED:${error instanceof Error ? error.message : String(error)}`, false, true);
      return { action: "DELIVERY_FAILED", assignedAgent: selected };
    }
  }

  private isCurrent(snapshot: Snapshot): boolean {
    const task = this.tasks.get(snapshot.task.taskId); const role = snapshot.role && this.teams.role(snapshot.task.taskId, snapshot.role.sequence);
    if (!task || !role || TERMINAL.has(task.status)) return false;
    const team = this.teams.get(task.taskId);
    const currentSequence = team?.currentSequence ?? task.currentRoleSequence;
    return currentSequence === snapshot.role!.sequence && role.revisionRound === snapshot.role!.revisionRound
      && role.assignedAgent === snapshot.role!.assignedAgent
      && task.attempt === snapshot.task.attempt
      && (this.store.db.prepare("SELECT updated_at FROM tasks WHERE task_id=?").get(task.taskId) as unknown as TaskVersionRow).updated_at === snapshot.taskVersion;
  }

  private reviewRevisionHandoffMissing(task: TaskRecord, role: TaskRoleRecord, result: ResultEventRow, roles: TaskRoleRecord[]): boolean {
    if (!["REVIEWER", "ARCHITECT"].includes(role.role) || role.status !== "FAIL") return false;
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(result.payload_json) as Record<string, unknown>; } catch { return false; }
    if (String(payload.verdict || "").toUpperCase() === "REVIEW_PASS") return false;
    const previous = [...roles].reverse().find((item) => item.sequence < role.sequence && item.assignedAgent
      && ["DEVELOPER", "DEBUGGER", "REFACTORER"].includes(item.role));
    if (!previous?.assignedAgent) return true;
    const expectedRound = role.revisionRound + 1;
    const recipient = agentToBotType(previous.assignedAgent);
    const handoffs = this.store.db.prepare(`SELECT payload_json FROM protocol_events
      WHERE task_id=? AND event_type='REVISION_REQUEST' AND recipient=? AND created_at>=? ORDER BY created_at DESC`)
      .all(task.taskId, recipient, result.created_at) as Array<{ payload_json: string }>;
    return !handoffs.some((row) => {
      try { return Number((JSON.parse(row.payload_json) as Record<string, unknown>).round) === expectedRound; } catch { return false; }
    });
  }

  private async replayReviewRevision(snapshot: Snapshot): Promise<Pick<ContinuationObservation, "action" | "assignedAgent">> {
    const role = snapshot.role!; const result = snapshot.resultEvent!;
    const roles = this.teams.roles(snapshot.task.taskId);
    if (!this.reviewRevisionHandoffMissing(snapshot.task, role, result, roles)) {
      this.markAction(snapshot, "DUPLICATE_SUPPRESSED", false, true);
      return { action: "DUPLICATE_SUPPRESSED", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
    }
    const previous = [...roles].reverse().find((item) => item.sequence < role.sequence && item.assignedAgent
      && ["DEVELOPER", "DEBUGGER", "REFACTORER"].includes(item.role));
    if (!previous?.assignedAgent || !role.assignedAgent) {
      this.safeStop(snapshot, "Persisted REVIEW requires revision but no eligible prior implementation Role exists");
      return { action: "SAFE_STOP", ...(role.assignedAgent ? { assignedAgent: role.assignedAgent } : {}) };
    }
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(result.payload_json) as Record<string, unknown>; } catch { /* findings remain fail-closed */ }
    const findings = Array.isArray(payload.findings) ? payload.findings.map(String) : ["Persisted REVIEW requires Developer revision"];
    const round = role.revisionRound + 1;
    this.teams.reopen(snapshot.task.taskId, previous.sequence, round);
    try {
      await this.protocol.emit("REVISION_REQUEST", snapshot.task, role.assignedAgent, agentToBotType(previous.assignedAgent), {
        findings, requested_changes: findings, role: previous.role, round, thread_id: snapshot.task.threadId,
        next_owner: agentToBotType(previous.assignedAgent), recovery_reason: "DURABLE_REVIEW_HANDOFF_ORPHAN", source_event_id: result.event_id,
      });
      this.markAction(snapshot, "RETRIED", false, true);
      return { action: "RETRIED", assignedAgent: previous.assignedAgent };
    } catch (error) {
      this.markAction(snapshot, `DELIVERY_FAILED:${error instanceof Error ? error.message : String(error)}`, false);
      return { action: "DELIVERY_FAILED", assignedAgent: previous.assignedAgent };
    }
  }

  private fence(snapshot: Snapshot): void {
    const now = this.store.now(); const role = snapshot.role!;
    if (snapshot.process && !this.pidAlive(snapshot.process.pid)) this.store.db.prepare("UPDATE worker_processes SET status='LOST',last_seen=? WHERE process_id=? AND status IN ('RUNNING','STARTED','BUSY')").run(now, snapshot.process.process_id);
    this.store.db.prepare(`UPDATE inbound_messages SET state='SUPERSEDED',reason_code=?,processed_at=?
      WHERE task_id=? AND state='RECEIVED' AND role=? AND discussion_round=?`)
      .run(`CONTINUATION_${snapshot.classification}`, now, snapshot.task.taskId, role.role, role.revisionRound);
    if (snapshot.task.lockToken) this.locks.release(snapshot.task.lockToken);
    if (role.assignedAgent) {
      const agent = this.agents.get(role.assignedAgent);
      if (agent?.currentTask === snapshot.task.taskId) this.agents.release(role.assignedAgent, true);
    }
  }

  private safeStop(snapshot: Snapshot, detail: string): void {
    this.fence(snapshot);
    const task = this.tasks.get(snapshot.task.taskId);
    if (task && !TERMINAL.has(task.status)) {
      const terminal = ["RUNNING", "WAITING_RESULT", "REVIEWING"].includes(task.status) ? "FAIL" : "CANCELLED";
      this.tasks.transition(task.taskId, terminal as "FAIL" | "CANCELLED", { result: `SAFE_STOP:NO_PROGRESS_CONTINUATION:${detail}` });
    }
    if (snapshot.role) {
      try { this.teams.finish(snapshot.task.taskId, snapshot.role.sequence, "BLOCKED", `SAFE_STOP:${detail}`); } catch { /* durable Task stop is authoritative */ }
      this.store.db.prepare("UPDATE task_teams SET status='BLOCKED',updated_at=? WHERE task_id=?").run(this.store.now(), snapshot.task.taskId);
    }
    this.markAction(snapshot, `SAFE_STOP:${detail}`, false, true);
    this.unwatch(snapshot.task.taskId);
  }

  private recordObservation(snapshot: Snapshot): void {
    const role = snapshot.role!; const now = this.store.now();
    this.store.db.prepare(`INSERT INTO continuation_recovery_state(task_id,role_sequence,revision_round,retry_count,wake_in_progress,classification,last_reason,last_action,last_worker,last_process_id,task_version,updated_at)
      VALUES(?,?,?,0,0,?,?,?, ?,?,?,?) ON CONFLICT(task_id,role_sequence,revision_round) DO UPDATE SET
      classification=excluded.classification,last_reason=excluded.last_reason,last_worker=excluded.last_worker,
      last_process_id=excluded.last_process_id,task_version=excluded.task_version,updated_at=excluded.updated_at`)
      .run(snapshot.task.taskId, role.sequence, role.revisionRound, snapshot.classification, snapshot.reason, "OBSERVED",
        role.assignedAgent ?? null, snapshot.process?.process_id ?? null, snapshot.taskVersion, now);
  }

  private state(snapshot: Snapshot): { retry_count: number; wake_in_progress: number; capacity_wait_started_at: string | null; cancel_requested_at: string | null } {
    return this.store.db.prepare(`SELECT retry_count,wake_in_progress,capacity_wait_started_at,cancel_requested_at FROM continuation_recovery_state
      WHERE task_id=? AND role_sequence=? AND revision_round=?`).get(snapshot.task.taskId, snapshot.role!.sequence, snapshot.role!.revisionRound) as { retry_count: number; wake_in_progress: number; capacity_wait_started_at: string | null; cancel_requested_at: string | null };
  }

  private markAction(snapshot: Snapshot, action: string, wakeInProgress: boolean, clearWaits = false): void {
    this.store.db.prepare(`UPDATE continuation_recovery_state SET last_action=?,wake_in_progress=?,
      capacity_wait_started_at=CASE WHEN ?=1 THEN NULL ELSE capacity_wait_started_at END,
      cancel_requested_at=CASE WHEN ?=1 THEN NULL ELSE cancel_requested_at END,updated_at=?
      WHERE task_id=? AND role_sequence=? AND revision_round=?`)
      .run(action, wakeInProgress ? 1 : 0, clearWaits ? 1 : 0, clearWaits ? 1 : 0, this.store.now(), snapshot.task.taskId, snapshot.role!.sequence, snapshot.role!.revisionRound);
  }
}
