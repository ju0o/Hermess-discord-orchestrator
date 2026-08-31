import type { AgentId } from "../domain/types.js";
import type { SymphonyTaskBridge } from "../inbound/symphonyTaskBridge.js";
import type { Store } from "../storage/database.js";
import type { Recovery, RecoveryReport } from "./recovery/recovery.js";
import type { Watchdog } from "./watchdog.js";
import type { OfficeEventInput, OvernightOfficeQueue } from "../office/overnightQueue.js";
import type { ContinuationRunReport } from "./scopedContinuationWatchdog.js";

export interface SelfHealingConnection {
  agentId: AgentId | "ORCHESTRATOR";
  connected: boolean;
  botId?: string;
  detail?: string;
}

export interface SelfHealingSnapshot {
  observedAt: string;
  pid: number;
  gateway: {
    connected: number;
    disconnected: number;
    details: SelfHealingConnection[];
  };
  workers: {
    running: number;
    lost: number;
    deadPids: number;
  };
  tasks: {
    active: number;
    held: number;
  };
  state: {
    lastInbound?: unknown;
    lastOutbound?: unknown;
    lastRecovery?: unknown;
  };
}

export interface SelfHealingRun {
  reason: string;
  before: SelfHealingSnapshot;
  recovery: RecoveryReport;
  staleTasks: string[];
  bridgeReconciled: number;
  continuation?: ContinuationRunReport;
  after: SelfHealingSnapshot;
}

type ConnectionReader = () => SelfHealingConnection[];
type ContinuationRunner = { watchedTaskIds(): string[]; runOnce(reason: string): Promise<ContinuationRunReport> };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic control-plane observer/recovery loop.
 *
 * This loop never creates a Product task and never starts an Agent adapter.
 * It only reconciles already-durable runtime state through the existing
 * Recovery/Watchdog/Bridge owners. Product implementation remains owned by
 * WorkerRuntime and the task scheduler.
 */
export class SelfHealingLoop {
  constructor(
    private readonly store: Store,
    private readonly recovery: Pick<Recovery, "reconcile">,
    private readonly watchdog: Pick<Watchdog, "check">,
    private readonly bridge: Pick<SymphonyTaskBridge, "reconcile">,
    private readonly connectionReader: ConnectionReader,
    private readonly officeQueue?: Pick<OvernightOfficeQueue, "record">,
    private readonly ownerPaused: () => boolean = () => false,
    private readonly projectionBackfill?: () => { checked: number; projected: string[] },
    private readonly continuation?: ContinuationRunner,
  ) {}

  observe(): SelfHealingSnapshot {
    const connections = this.connectionReader();
    const workers = this.store.db.prepare(
      "SELECT status,pid FROM worker_processes",
    ).all() as Array<{ status: string; pid: number }>;
    const tasks = this.store.db.prepare(
      "SELECT status FROM tasks",
    ).all() as Array<{ status: string }>;
    const activeStatuses = new Set(["DISPATCHED", "CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING"]);
    return {
      observedAt: this.store.now(),
      pid: process.pid,
      gateway: {
        connected: connections.filter((item) => item.connected).length,
        disconnected: connections.filter((item) => !item.connected).length,
        details: connections,
      },
      workers: {
        running: workers.filter((item) => item.status === "RUNNING").length,
        lost: workers.filter((item) => item.status === "LOST").length,
        deadPids: workers.filter((item) => item.status === "RUNNING" && !pidAlive(Number(item.pid))).length,
      },
      tasks: {
        active: tasks.filter((item) => activeStatuses.has(item.status)).length,
        held: tasks.filter((item) => item.status === "HUMAN_GATE").length,
      },
      state: {
        lastInbound: this.store.getRuntimeState("discord:last_native_inbound"),
        lastOutbound: this.store.getRuntimeState("discord:last_native_outbound"),
        lastRecovery: this.store.getRuntimeState("runtime:last_recovery"),
      },
    };
  }

  async runOnce(reason: string): Promise<SelfHealingRun> {
    const before = this.observe();
    if (this.ownerPaused()) {
      const run: SelfHealingRun = {
        reason: `${reason}:PAUSED_BY_OWNER`, before,
        recovery: { processesChecked: 0, lostProcesses: 0, tasksMovedToWaitingMain: [], ambiguousDeliveries: 0, agentsReleased: [], locksReleased: [] },
        staleTasks: [], bridgeReconciled: 0, after: before,
      };
      this.store.upsertRuntimeState("runtime:self_healing:last_run", run);
      return run;
    }
    const watchedTaskIds = this.continuation?.watchedTaskIds() ?? [];
    const scope = watchedTaskIds.length ? { taskIds: watchedTaskIds } : undefined;
    const recovery = this.recovery.reconcile(scope);
    const staleTasks = await this.watchdog.check(watchedTaskIds.length ? watchedTaskIds : undefined);
    const reconciled = this.bridge.reconcile();
    try { this.projectionBackfill?.(); } catch { /* projection backfill is best-effort */ }
    const continuation = this.continuation ? await this.continuation.runOnce(reason) : undefined;
    const after = this.observe();
    this.recordAnomalies(reason, before, after, recovery, staleTasks);
    const run: SelfHealingRun = {
      reason,
      before,
      recovery,
      staleTasks,
      bridgeReconciled: reconciled.length,
      ...(continuation ? { continuation } : {}),
      after,
    };
    this.store.upsertRuntimeState("runtime:self_healing:last_run", run);
    return run;
  }

  private recordAnomalies(
    reason: string,
    before: SelfHealingSnapshot,
    after: SelfHealingSnapshot,
    recovery: RecoveryReport,
    staleTasks: string[],
  ): void {
    if (!this.officeQueue) return;
    const disconnected = after.gateway.details.filter((item) => !item.connected);
    if (disconnected.length) {
      this.record({
        eventType: "CAPACITY_EVENT", source: "ASUS",
        summary: `Gateway capacity degraded: ${disconnected.map((item) => item.agentId).join(", ")}`,
        evidence: disconnected.map((item) => `${item.agentId}: ${item.detail || "DISCONNECTED"}`),
        suspectedOwner: "ASUS", severity: "MEDIUM",
        recommendedNextStep: "Reconnect the affected Gateway identity and continue unaffected office work.",
        canContinueOtherWork: true,
        fingerprint: `gateway-disconnected:${disconnected.map((item) => item.agentId).sort().join(",")}`,
        question: "Which affected worker should receive the next bounded rehearsal after reconnection?",
      });
    }
    if (after.workers.deadPids || recovery.lostProcesses) {
      this.record({
        eventType: "UNRESOLVED_INCIDENT", source: "ASUS",
        summary: "Worker process health anomaly detected by the local watchdog.",
        evidence: [`dead_pids=${after.workers.deadPids}`, `lost_processes=${recovery.lostProcesses}`, `run=${reason}`],
        suspectedOwner: "WORKER_RUNTIME", severity: "HIGH",
        recommendedNextStep: "Reconcile the lost worker and reassign only the affected branch; keep the engineering floor running.",
        canContinueOtherWork: true,
        fingerprint: `worker-health:${after.workers.deadPids}:${recovery.lostProcesses}`,
      });
    }
    if (staleTasks.length) {
      this.record({
        eventType: "UNRESOLVED_INCIDENT", source: "ASUS",
        summary: `Watchdog found stale task heartbeat(s): ${staleTasks.join(", ")}`,
        evidence: staleTasks, suspectedOwner: "ASUS", severity: "HIGH",
        recommendedNextStep: "Keep the stale branch waiting for reconciliation while continuing independent office work.",
        canContinueOtherWork: true,
        fingerprint: `stale-task:${staleTasks.slice().sort().join(",")}`,
      });
    }
    if (recovery.ambiguousDeliveries) {
      this.record({
        eventType: "REVIEW_NOTE", source: "ASUS",
        summary: `${recovery.ambiguousDeliveries} delivery record(s) require evidence-backed reconciliation.`,
        evidence: [`ambiguous_deliveries=${recovery.ambiguousDeliveries}`], suspectedOwner: "ASUS", severity: "MEDIUM",
        recommendedNextStep: "Verify Discord readback before any retry; do not resend blindly.",
        canContinueOtherWork: true,
        fingerprint: `ambiguous-delivery:${recovery.ambiguousDeliveries}`,
      });
    }
    // Keep the snapshot itself durable even when there is no anomaly. The
    // queue is for actionable items; ordinary heartbeats stay in runtime_state.
    void before;
  }

  private record(input: OfficeEventInput): void {
    try { this.officeQueue?.record(input); } catch { /* queue failure must not stop the floor */ }
  }
}
