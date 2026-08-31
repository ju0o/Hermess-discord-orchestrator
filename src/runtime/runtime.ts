import { mkdirSync } from "node:fs";
import { config } from "../config/env.js";
import type { AgentAdapter } from "../agents/adapter.js";
import type { AgentId, AgentRecord } from "../domain/types.js";
import { Store } from "../storage/database.js";
import { ProcessRunner } from "./processRunner.js";
import { CodexAdapter } from "../agents/codex/CodexAdapter.js";
import { ClaudeCodeAdapter } from "../agents/claude-code/ClaudeCodeAdapter.js";
import { OpenCodeAdapter } from "../agents/opencode/OpenCodeAdapter.js";
import { CommandCodeAdapter } from "../agents/command-code/CommandCodeAdapter.js";
import { AgentRegistry } from "../registry/agentRegistry.js";
import { RoleRegistry } from "../registry/roleRegistry.js";
import { TaskRepository } from "../tasks/repository.js";
import { WorkspaceLocks } from "../tasks/locks.js";
import { MemoryRouter } from "../context/memoryRouter.js";
import { ContextResolver } from "../context/resolver.js";
import { Protocol } from "../tasks/protocol.js";
import { Dispatcher } from "../tasks/dispatcher.js";
import { MultiBotGateway } from "../discord/routing/multiBotGateway.js";
import { HealthMonitor } from "./health.js";
import { Recovery } from "./recovery/recovery.js";
import { Watchdog } from "./watchdog.js";
import { TrustedBotRegistry } from "../discord/control/trustedBotRegistry.js";
import { InboundGuard } from "../discord/control/inboundGuard.js";
import { AsusHermesControlTransport } from "../discord/control/controlTransport.js";
import { TeamRepository } from "../teams/repository.js";
import { AgentRouter } from "../routing/agentRouter.js";
import { TeamPlanner } from "../teams/planner.js";
import { SequentialTeamScheduler } from "../teams/scheduler.js";
import { ModelCatalog } from "../models/catalog.js";
import { LocalModelDiscovery } from "../models/discovery.js";
import { ModelRouter } from "../models/router.js";
import { ModelEscalationService } from "../models/escalation.js";
import { ModelAvailabilityFallback } from "../models/availabilityFallback.js";
import { CollaborationContextResolver } from "../context/collaboration.js";
import { CollaborationService } from "../collaboration/service.js";
import { EngineeringMeetingService } from "../collaboration/meeting.js";
import { PerformanceService } from "../performance/service.js";
import { PerformanceScorer } from "../performance/scorer.js";
import { SymphonyTaskBridge } from "../inbound/symphonyTaskBridge.js";
import { WorkerRuntime } from "../worker/runtime.js";
import { CODING_AGENT_WORKERS } from "../worker/workerIdentities.js";
import { WorkerContract } from "../worker/workerContract.js";
import { RuntimeSingleton } from "./singleton.js";
import { SelfHealingLoop } from "./selfHealing.js";
import { OvernightOfficeQueue } from "../office/overnightQueue.js";
import { FreeModelRegistry } from "../models/freeTierRegistry.js";
import { OwnerInbox } from "../office/ownerInbox.js";
import { TaskCompletionProjection } from "../tasks/completionProjection.js";
import { OwnerControl } from "../office/ownerControl.js";
import { ScopedContinuationWatchdog, type ContinuationWatchPolicy } from "./scopedContinuationWatchdog.js";
import { recordHeartbeat } from "./correction.js";
import { RunBudgetController } from "./runBudget.js";
import { TaskAdmission } from "../tasks/taskAdmission.js";
import { LocalTaskControl } from "../control/localTaskControl.js";
import type { MaintenanceShutdownAccepted, MaintenanceShutdownRejected } from "../control/localTaskControl.js";
import { ManagerInferenceObservability } from "../observability/managerInference.js";
import { AsusManagerInferenceBoundary, NousHermesProvider } from "../manager/asusInferenceBoundary.js";
import { AsusProposalConsumer } from "../manager/asusProposalConsumer.js";
import { RuntimeDispatchRecovery } from "./dispatchRecovery.js";
import { ExecutionBindingReconciler } from "./executionBindingReconciliation.js";

export class OrchestratorRuntime {
  readonly store = new Store(); readonly runner = new ProcessRunner(this.store);
  readonly agents = new AgentRegistry(this.store); readonly roles = new RoleRegistry(this.store);
  readonly tasks = new TaskRepository(this.store); readonly locks = new WorkspaceLocks(this.store);
  readonly adapters: Map<AgentId, AgentAdapter>;
  readonly gateway: MultiBotGateway; readonly dispatcher: Dispatcher; readonly health: HealthMonitor; readonly recovery: Recovery;
  readonly trustedBots: TrustedBotRegistry; readonly inbound: InboundGuard; readonly controlTransport: AsusHermesControlTransport;
  readonly protocol: Protocol;
  readonly models: ModelCatalog; readonly modelDiscovery: LocalModelDiscovery;
  readonly freeModels: FreeModelRegistry;
  readonly modelRouter: ModelRouter; readonly modelEscalation: ModelEscalationService; readonly modelAvailability: ModelAvailabilityFallback;
  readonly collaboration: CollaborationService;
  readonly meeting: EngineeringMeetingService;
  readonly performance: PerformanceService; readonly performanceScorer = new PerformanceScorer();
  readonly inboundBridge: SymphonyTaskBridge;
  readonly teams: TeamRepository; readonly agentRouter: AgentRouter; readonly teamPlanner: TeamPlanner; readonly teamScheduler: SequentialTeamScheduler;
  readonly watchdog: Watchdog;
  readonly selfHealing: SelfHealingLoop;
  readonly continuation: ScopedContinuationWatchdog;
  readonly runBudget: RunBudgetController;
  readonly officeQueue: OvernightOfficeQueue;
  readonly ownerInbox: OwnerInbox;
  readonly ownerControl: OwnerControl;
  readonly taskAdmission: TaskAdmission;
  readonly managerInference: ManagerInferenceObservability;
  readonly asusInference: AsusManagerInferenceBoundary;
  readonly asusProposalConsumer: AsusProposalConsumer;
  readonly dispatchRecovery: RuntimeDispatchRecovery;
  readonly bindingReconciler: ExecutionBindingReconciler;
  readonly localTaskControl?: LocalTaskControl;
  private readonly singleton = new RuntimeSingleton();
  private scheduler?: NodeJS.Timeout; private healthTimer?: NodeJS.Timeout; private selfHealingTimer?: NodeJS.Timeout;
  private maintenanceShutdownRequested = false;

  constructor() {
    mkdirSync(config.dataDir, { recursive: true }); mkdirSync(config.logDir, { recursive: true }); mkdirSync(config.HERMESS_PROJECTS_ROOT, { recursive: true });
    this.adapters = new Map<AgentId, AgentAdapter>([
      ["CODEX", new CodexAdapter(this.runner)], ["CLAUDE_CODE", new ClaudeCodeAdapter(this.runner)],
      ["OPENCODE", new OpenCodeAdapter(this.runner)], ["COMMAND_CODE", new CommandCodeAdapter(this.runner)],
    ]);
    this.managerInference = new ManagerInferenceObservability(this.store);
    this.asusInference = new AsusManagerInferenceBoundary(this.store, new NousHermesProvider(), this.managerInference);
    this.models = new ModelCatalog(this.store, this.adapters); this.modelDiscovery = new LocalModelDiscovery(this.runner, this.models);
    this.freeModels = new FreeModelRegistry(this.store); this.freeModels.registerCandidates();
    this.modelRouter = new ModelRouter(this.store, this.tasks, this.models); this.modelEscalation = new ModelEscalationService(this.store, this.models, this.modelRouter); this.modelAvailability = new ModelAvailabilityFallback(this.store, this.models);
    this.seed(); this.trustedBots = new TrustedBotRegistry(this.store, this.agents); this.trustedBots.seed();
    this.inbound = new InboundGuard(this.store, this.trustedBots, config.MAX_DISCUSSION_ROUNDS);
    this.controlTransport = new AsusHermesControlTransport();
    this.taskAdmission = new TaskAdmission(this.tasks);
    this.asusProposalConsumer = new AsusProposalConsumer(this.store, this.taskAdmission);
    this.gateway = new MultiBotGateway(this.store, this.agents, this.tasks, this.adapters, this.runner, this.trustedBots, this.inbound, this.controlTransport, this.models, this.taskAdmission);
    if (config.HERMESS_CONTROL_TOKEN) {
      this.localTaskControl = new LocalTaskControl(this.taskAdmission, { host: config.HERMESS_CONTROL_HOST, port: config.HERMESS_CONTROL_PORT, token: config.HERMESS_CONTROL_TOKEN });
      this.localTaskControl.setAsusProposalConsumer(async (taskId, acceptanceId) => {
        const result = await this.asusProposalConsumer.consume(taskId, acceptanceId);
        return { observationId: result.observationId, taskId: result.task.taskId, status: result.task.status, continued: result.continued };
      });
    }
    this.ownerControl = new OwnerControl(this.store); this.gateway.attachOwnerControl(this.ownerControl);
    const memory = new MemoryRouter(this.store); const context = new ContextResolver(this.tasks, this.gateway, memory);
    this.protocol = new Protocol(this.store, this.gateway);
    this.performance = new PerformanceService(this.store, { earlySignalMin: config.PERFORMANCE_EARLY_SIGNAL_MIN, observedMin: config.PERFORMANCE_OBSERVED_MIN });
    this.inboundBridge = new SymphonyTaskBridge(this.store, this.tasks);
    this.protocol.attachObserver(this.performance); this.tasks.attachObserver(this.performance); this.gateway.attachPerformance(this.performance);
    this.teams = new TeamRepository(this.store);
    this.agentRouter = new AgentRouter(this.agents, this.roles, this.locks, (agentId) => this.gateway.connectionReport().some((item) => item.agentId === agentId && item.connected));
    this.teamPlanner = new TeamPlanner(this.tasks, this.teams, this.agentRouter);
    this.collaboration = new CollaborationService(this.store, this.tasks, this.teams, this.agents, this.agentRouter, this.modelRouter,
      this.protocol, this.gateway.workrooms, new CollaborationContextResolver(this.store, context), this.locks, this.adapters, config.MAX_DISCUSSION_ROUNDS);
    this.gateway.attachCollaboration(this.collaboration);
    this.meeting = new EngineeringMeetingService(this.store, this.tasks, this.gateway.workrooms, this.protocol);
    this.gateway.attachMeeting(this.meeting);
    this.teamScheduler = new SequentialTeamScheduler(this.tasks, this.teams, this.teamPlanner, this.agents, this.adapters, this.locks, context, this.protocol, this.gateway.workrooms, this.modelRouter, this.modelEscalation, this.store, this.runner);
    this.runBudget = new RunBudgetController(this.store);
    this.gateway.attachWorkerRuntime(new WorkerRuntime(this.store, this.tasks, this.teams, this.adapters, context, this.protocol, new Map(Object.entries(CODING_AGENT_WORKERS) as Array<[AgentId, import("../worker/workerContract.js").WorkerIdentity]>), (identity) => new WorkerContract(identity, this.inbound), () => this.ownerControl.isPaused(), this.agents, this.runBudget, this.models, this.modelAvailability));
    this.dispatcher = new Dispatcher(this.tasks, this.agents, this.adapters, this.locks, context, this.protocol, this.gateway.workrooms, this.teamScheduler, this.modelRouter, () => this.ownerControl.isPaused(), this.runBudget, this.runner);
    this.dispatchRecovery = new RuntimeDispatchRecovery(this.store, this.tasks, (taskId) => this.dispatcher.redriveTask(taskId));
    this.localTaskControl?.setDispatchRedrive((taskId, recoveryId, reason) => this.dispatchRecovery.recover(taskId, recoveryId, reason));
    this.bindingReconciler = new ExecutionBindingReconciler(this.store, this.tasks);
    this.localTaskControl?.setBindingReconcile((taskId, reconciliationId, oldSha, newSha, reason) => this.bindingReconciler.reconcile(taskId, reconciliationId, oldSha, newSha, reason));
    this.taskAdmission.attachActivation((taskId) => this.dispatcher.dispatchTask(taskId));
    this.health = new HealthMonitor(this.agents, this.adapters); this.recovery = new Recovery(this.store, this.tasks, this.agents, this.locks);
    this.watchdog = new Watchdog(this.store, this.tasks, this.agents, this.locks, (message) => this.gateway.alert(message));
    this.continuation = new ScopedContinuationWatchdog(this.store, this.tasks, this.teams, this.agents, this.locks, this.agentRouter, this.protocol,
      { cancelTask: (taskId) => this.runner.cancelTask(taskId), refreshHealth: async () => {
        await this.health.checkAll();
        this.gateway.reconcileWorkerHealth();
      } }, this.runBudget);
    this.officeQueue = new OvernightOfficeQueue(this.store);
    this.ownerInbox = new OwnerInbox(this.store);
    this.selfHealing = new SelfHealingLoop(this.store, this.recovery, this.watchdog, this.inboundBridge,
      () => this.gateway.connectionReport().map((item) => ({ agentId: item.agentId, connected: item.connected, ...(item.botId ? { botId: item.botId } : {}) })), this.officeQueue, () => this.ownerControl.isPaused(), () => { try { return new TaskCompletionProjection(this.store, this.tasks, this.teams, this.protocol).backfill(); } catch { return { checked: 0, projected: [] }; } }, this.continuation);
  }

  attachMaintenanceShutdown(handler: () => void | Promise<void>): void {
    this.localTaskControl?.setMaintenanceShutdown(() => {
      const active = this.store.db.prepare("SELECT 1 FROM worker_processes WHERE status IN ('RUNNING','STARTED','BUSY') LIMIT 1").get();
      if (active) return { accepted: false, error: "RUNTIME_MAINTENANCE_ACTIVE_WORK" } satisfies MaintenanceShutdownRejected;
      if (this.maintenanceShutdownRequested) return { accepted: true, alreadyRequested: true, onAccepted: () => undefined } satisfies MaintenanceShutdownAccepted;
      this.maintenanceShutdownRequested = true;
      return { accepted: true, alreadyRequested: false, onAccepted: handler } satisfies MaintenanceShutdownAccepted;
    });
  }

  private seed(): void {
    this.roles.seed();
    for (const adapter of this.adapters.values()) {
      const existing = this.agents.get(adapter.id);
      const record: AgentRecord = { agentId: adapter.id, displayName: adapter.name, backendType: "CLI", agentType: adapter.id,
        runtimeAdapter: adapter.name, availableModels: existing?.availableModels || [], status: existing?.status || "OFFLINE",
        capabilities: adapter.capabilities, health: existing?.health || "ERROR",
        ...(existing?.discordBotId ? { discordBotId: existing.discordBotId } : {}) };
      this.agents.upsert(record);
    }
  }

  async start(options: { scheduler?: boolean; continuation?: { projectId: string; taskIds: readonly string[]; policy?: Partial<ContinuationWatchPolicy>; wallClockBudgetMs?: number; noProgressBudgetMs?: number } } = {}): Promise<void> {
    this.singleton.acquire();
    try {
      if (options.continuation) {
        if (options.continuation.wallClockBudgetMs === undefined || options.continuation.noProgressBudgetMs === undefined) throw new Error("RUN_BUDGET_REQUIRED");
        for (const taskId of options.continuation.taskIds) this.runBudget.start(taskId, options.continuation.projectId, options.continuation.wallClockBudgetMs, options.continuation.noProgressBudgetMs);
        this.continuation.watch(options.continuation.projectId, options.continuation.taskIds, options.continuation.policy);
      }
      await this.models.restorePreferences();
      this.collaboration.recover(); this.performance.backfill(); try { new TaskCompletionProjection(this.store, this.tasks, this.teams, this.protocol).backfill(); } catch { /* projection is best-effort */ } const health = await this.health.checkAll(); await this.gateway.start(); this.gateway.reconcileWorkerHealth(); const recoveryRun = await this.selfHealing.runOnce("startup");
      await this.gateway.recoverPendingDeliveries();
      await this.localTaskControl?.start();
      if (recoveryRun.recovery.lostProcesses || recoveryRun.recovery.ambiguousDeliveries) await this.gateway.alert(`Recovery: lost workers=${recoveryRun.recovery.lostProcesses}, ambiguous deliveries=${recoveryRun.recovery.ambiguousDeliveries}`);
      const unhealthy = Object.entries(health).filter(([, result]) => result.status !== "ONLINE").map(([id, result]) => `${id}=${result.status}`);
      if (unhealthy.length) await this.gateway.alert(`Agent health: ${unhealthy.join(", ")}`);
      if (options.scheduler !== false) this.scheduler = setInterval(() => void this.dispatcher.tick().then(() => this.inboundBridge.reconcile()).catch((error) => console.error("dispatcher", error)), config.SCHEDULER_INTERVAL_MS);
      this.healthTimer = setInterval(() => void this.health.checkAll().then(() => {
        this.gateway.reconcileWorkerHealth();
        const active = this.store.db.prepare("SELECT task_id,status,workspace,assigned_agent,role,result FROM tasks WHERE status IN ('CLAIMED','RUNNING','WAITING_RESULT','REVIEWING','WAITING_MAIN') ORDER BY updated_at DESC LIMIT 1").get() as { task_id: string; status: string; workspace: string; assigned_agent: AgentId | null; role: import("../domain/types.js").Role; result: string | null } | undefined;
        const process = active ? this.store.db.prepare("SELECT started_at,last_seen FROM worker_processes WHERE task_id=? ORDER BY started_at DESC LIMIT 1").get(active.task_id) as { started_at: string; last_seen: string } | undefined : undefined;
        const online = this.store.db.prepare("SELECT value_json FROM runtime_state WHERE key='runtime:online'").get() as { value_json: string } | undefined;
        let runStartedAt = this.store.now(); try { if (online) runStartedAt = String((JSON.parse(online.value_json) as { at?: string }).at || runStartedAt); } catch {}
        const ownerActionRequired = active?.status === "WAITING_MAIN";
        recordHeartbeat(this.store, { runStartedAt, wallLimitSeconds: 3600, ...(active ? { task: { taskId: active.task_id, status: active.status as never, workspace: active.workspace, ...(active.assigned_agent ? { assignedAgent: active.assigned_agent } : {}), role: active.role } } : {}), phase: active?.status ?? "IDLE", ...(active?.assigned_agent ? { activeWorker: active.assigned_agent } : {}), ...(active?.role ? { workerRole: active.role } : {}), ...(process?.started_at ? { processStartedAt: process.started_at } : {}), ...(process?.last_seen ? { processLastSeen: process.last_seen } : {}), latestProgress: "HEALTH_INTERVAL", ...(ownerActionRequired ? { blocker: active?.result || "WAITING_MAIN" } : {}), ownerActionRequired, ...(ownerActionRequired ? { ownerActionReason: active?.result || "Runtime requires Owner decision" } : {}), nextTransition: active ? (ownerActionRequired ? "OWNER_DECISION" : "WORKER_RESULT_OR_HANDOFF") : "NEXT_TASK", nextTimeoutSeconds: 300, jutellMode: "NOT_RUNNING" });
      }).catch((error) => console.error("health", error)), 300_000);
      this.selfHealingTimer = setInterval(() => void this.selfHealing.runOnce("interval").catch((error) => console.error("self-healing", error)), 60_000);
      if (options.scheduler !== false) await this.dispatcher.tick(); this.store.upsertRuntimeState("runtime:online", { at: this.store.now(), pid: process.pid, scheduler: options.scheduler !== false });
    } catch (error) { await this.localTaskControl?.close(); this.singleton.release(); throw error; }
  }
  async stop(): Promise<void> {
    if (this.scheduler) clearInterval(this.scheduler); if (this.healthTimer) clearInterval(this.healthTimer); if (this.selfHealingTimer) clearInterval(this.selfHealingTimer);
    await this.localTaskControl?.close(); await this.gateway.stop(); this.store.upsertRuntimeState("runtime:offline", { at: this.store.now(), pid: process.pid }); this.store.close(); this.singleton.release();
  }
}
