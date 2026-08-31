import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId, Capability, Role, TaskStatus } from "../src/domain/types.js";
import { agentToBotType } from "../src/discord/control/types.js";
import { AgentRegistry } from "../src/registry/agentRegistry.js";
import { RoleRegistry } from "../src/registry/roleRegistry.js";
import { AgentRouter } from "../src/routing/agentRouter.js";
import { ScopedContinuationWatchdog } from "../src/runtime/scopedContinuationWatchdog.js";
import { Store } from "../src/storage/database.js";
import { TeamRepository } from "../src/teams/repository.js";
import { WorkspaceLocks } from "../src/tasks/locks.js";
import { Protocol, type ProtocolEvent, type ProtocolSink } from "../src/tasks/protocol.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { RunBudgetController } from "../src/runtime/runBudget.js";

const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const OLD = "2026-08-22T11:00:00.000Z";
const RECENT = "2026-08-22T11:59:59.500Z";
const ALL_CAPS: Capability[] = ["coding", "review", "repository_analysis", "testing", "debugging", "refactoring", "architecture", "mcp"];
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

class Sink implements ProtocolSink {
  events: ProtocolEvent[] = [];
  gate?: Promise<void>;
  async publish(event: ProtocolEvent) { this.events.push(event); if (this.gate) await this.gate; return `message-${this.events.length}`; }
}

function setup() {
  let clock = NOW;
  const dir = mkdtempSync(path.join(os.tmpdir(), "continuation-watchdog-")); dirs.push(dir);
  const store = new Store(path.join(dir, "state.db")); const tasks = new TaskRepository(store); const teams = new TeamRepository(store);
  const agents = new AgentRegistry(store); const roles = new RoleRegistry(store); roles.seed(); const locks = new WorkspaceLocks(store);
  tasks.upsertProject({ projectId: "p", name: "P", workspace: path.join(dir, "p"), ssotPaths: [], status: "ACTIVE" });
  tasks.upsertProject({ projectId: "other", name: "Other", workspace: path.join(dir, "other"), ssotPaths: [], status: "ACTIVE" });
  for (const agentId of ["CODEX", "CLAUDE_CODE", "OPENCODE", "COMMAND_CODE"] as AgentId[]) agents.upsert({ agentId, displayName: agentId,
    backendType: "TEST", discordBotId: `bot-${agentId}`, status: "AVAILABLE", health: "ONLINE", capabilities: ALL_CAPS });
  const sink = new Sink(); const protocol = new Protocol(store, sink); const router = new AgentRouter(agents, roles, locks, () => true);
  const alive = new Map<number, boolean>(); const processLogs = new Map<string, string>(); const processControl = { cancelCalls: 0, terminateCalls: 0 };
  let refreshHealth = async () => {};
  const budget = new RunBudgetController(store, () => clock, () => true);
  const watchdog = new ScopedContinuationWatchdog(store, tasks, teams, agents, locks, router, protocol,
    { nowMs: () => clock, pidAlive: (pid) => alive.get(pid) ?? false,
      cancelTask: () => { processControl.cancelCalls += 1; return true; }, terminatePid: () => { processControl.terminateCalls += 1; return true; },
      readProcessLog: (logPath) => processLogs.get(logPath) || "", refreshHealth: () => refreshHealth() }, budget);
  return { dir, store, tasks, teams, agents, sink, watchdog, budget, alive, processLogs, processControl, setNow: (value: number) => { clock = value; },
    setRefreshHealth: (fn: () => Promise<void>) => { refreshHealth = fn; } };
}

function task(x: ReturnType<typeof setup>, id: string, status: TaskStatus, role: Role = "DEVELOPER", agent: AgentId = "CODEX", projectId = "p") {
  x.tasks.create({ taskId: id, projectId, title: id, goal: "bounded continuation", taskType: "FEATURE", requiredRoles: [role], teamMode: "SEQUENTIAL",
    currentRoleSequence: 1, role, requiredCapabilities: ["coding"], assignedAgent: agent, status: "QUEUED",
    workspace: path.join(x.dir, projectId, id), readContext: {}, fileScope: ["src/**"], doNot: [], validation: [], owner: "MAIN", nextOwner: "MAIN" });
  x.teams.create(id, "FEATURE", [role]); x.teams.assign(id, 1, agent, "TEST"); x.teams.activate(id, 1); x.tasks.setCurrentTeamRole(id, 1, role, agent);
  let current = x.tasks.get(id)!;
  if (status !== "QUEUED") current = x.tasks.transition(id, "DISPATCHED");
  if (["CLAIMED", "RUNNING", "WAITING_RESULT"].includes(status)) current = x.tasks.transition(id, "CLAIMED", { attempt: 1 });
  if (["RUNNING", "WAITING_RESULT"].includes(status)) current = x.tasks.transition(id, "RUNNING");
  if (status === "WAITING_RESULT") current = x.tasks.transition(id, "WAITING_RESULT");
  x.store.db.prepare("UPDATE tasks SET updated_at=? WHERE task_id=?").run(OLD, id);
  x.store.db.prepare("UPDATE task_roles SET started_at=? WHERE task_id=? AND sequence=1").run(OLD, id);
  return current;
}

function inbound(x: ReturnType<typeof setup>, id: string, role: Role, agent: AgentId, round = 0) {
  const bot = agentToBotType(agent); const message = `in-${id}-${role}-${round}`;
  x.store.db.prepare(`INSERT INTO inbound_messages(discord_message_id,task_id,event_type,sender,recipient,role,status,next_owner,discussion_round,thread_id,channel_id,logical_key,envelope_json,state,reason_code,received_at,created_at)
    VALUES(?,?,'TASK','ASUS',?,?,NULL,NULL,?,NULL,'channel',?,'{}','RECEIVED','ALLOW',?,?)`)
    .run(message, id, bot, role, round, `${id}|TASK|ASUS|${bot}|${role}|${round}|`, OLD, OLD);
}

function worker(x: ReturnType<typeof setup>, id: string, status: string, pid: number, lastSeen: string, agent: AgentId = "CODEX") {
  x.store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path)
    VALUES(?,?,?,?,?,?,NULL,?,?,NULL,?,?)`).run(`proc-${id}`, agent, id, 1, pid, x.dir, OLD, lastSeen, status, path.join(x.dir, `${id}.log`));
}

function watch(x: ReturnType<typeof setup>, ...ids: string[]) {
  x.watchdog.watch("p", ids, { startDeadlineMs: 1_000, progressDeadlineMs: 5_000, resultDeadlineMs: 1_000, maxRecoveries: 2 });
}

describe("project-scoped no-progress continuation watchdog", () => {
  it("delivers the durable current action on the real scoped reassignment path instead of restoring the original goal", async () => {
    const x = setup(); task(x, "intent-dispatch", "DISPATCHED"); inbound(x, "intent-dispatch", "DEVELOPER", "CODEX");
    x.store.db.prepare("UPDATE task_roles SET revision_round=15 WHERE task_id='intent-dispatch' AND sequence=1").run();
    x.store.db.prepare("UPDATE inbound_messages SET discussion_round=15 WHERE task_id='intent-dispatch'").run();
    const old = x.budget.start("intent-dispatch", "p", 1_000, 5_000); x.setNow(NOW + 1_000); x.budget.evaluate("intent-dispatch"); x.setNow(NOW + 1_100);
    x.budget.rearm({ requestId: "intent-rearm", taskId: "intent-dispatch", projectId: "p", previousRunId: old.runId,
      budgetDurationMs: 5_000, noProgressBudgetMs: 2_000, actor: "OWNER", reason: "evidence-only closure",
      authority: { authorityClass: "HUMAN_REQUIRED", approvedBy: "owner", decisionReason: "bounded evidence closure",
        riskCategory: "BOUNDED_RUN_REARM", decisionTimestamp: new Date(NOW + 1_000).toISOString() },
      continuationIntent: { role: "DEVELOPER", revisionRound: 15, instruction: "evidence-only RESULT; do not modify Product",
        evidenceReferences: [{ task_id: "intent-dispatch", type: "TEST", command: "npm test", exit_code: 0, status: "PASS",
          timestamp: OLD, worktree: x.dir, branch: "task/x", source: "REUSED" }] } });
    watch(x, "intent-dispatch"); const report = await x.watchdog.runOnce("disposable-proof");
    expect(report.globalDispatcherTickUsed).toBe(false); expect(report.observations[0]?.action).toBe("REASSIGNED");
    const payload = x.sink.events.find((event) => event.type === "TASK")?.payload;
    expect(payload).toMatchObject({ original_goal: "bounded continuation", current_action: "evidence-only RESULT; do not modify Product",
      goal: "evidence-only RESULT; do not modify Product", current_action_authoritative: true, round: 15,
      continuation_intent: { role: "DEVELOPER", revision_round: 15, evidence_references: [expect.objectContaining({ source: "REUSED" })] } });
    expect(payload?.goal).not.toBe(payload?.original_goal); x.store.close();
  });
  it("automatically recovers RECEIVED work that never creates a process", async () => {
    const x = setup(); task(x, "received", "DISPATCHED"); inbound(x, "received", "DEVELOPER", "CODEX"); watch(x, "received");
    const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "RECEIVED_BUT_NOT_STARTED", action: "REASSIGNED" });
    expect(x.sink.events.filter((e) => e.type === "TASK")).toHaveLength(1); expect(x.tasks.get("received")?.assignedAgent).not.toBe("CODEX"); x.store.close();
  });

  it("recovers CLAIMED/ACTIVE work with no process", async () => {
    const x = setup(); task(x, "claimed", "CLAIMED"); watch(x, "claimed"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "CLAIMED_BUT_NOT_STARTED", action: "REASSIGNED" }); x.store.close();
  });

  it("recovers an ACTIVE Role that has neither inbound receipt nor a process", async () => {
    const x = setup(); task(x, "active", "DISPATCHED"); watch(x, "active"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "ACTIVE_NO_PROGRESS", action: "REASSIGNED" }); x.store.close();
  });

  it("retries the assigned Worker when a current stale-round inbound has no eligible fallback", async () => {
    const x = setup(); task(x, "stale-round-retry", "DISPATCHED", "QA", "CODEX"); inbound(x, "stale-round-retry", "QA", "CODEX", 1);
    for (const id of ["CLAUDE_CODE", "COMMAND_CODE", "OPENCODE"] as AgentId[]) x.agents.setHealth(id, { status: "ERROR", detail: "unavailable" });
    watch(x, "stale-round-retry"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "STALE_INBOUND", action: "RETRIED", assignedAgent: "CODEX" });
    expect(x.sink.events.filter((event) => event.type === "TASK" && event.recipient === "CODEX")).toHaveLength(1); x.store.close();
  });

  it("does not treat an inbound from before the active Role began as a current stale inbound", async () => {
    const x = setup(); task(x, "historical-inbound", "DISPATCHED", "QA", "CODEX"); inbound(x, "historical-inbound", "REVIEWER", "OPENCODE", 0);
    x.store.db.prepare("UPDATE inbound_messages SET received_at='2026-08-22T10:00:00.000Z' WHERE task_id='historical-inbound'").run();
    x.store.db.prepare("UPDATE task_roles SET started_at=? WHERE task_id='historical-inbound' AND sequence=1").run(RECENT);
    watch(x, "historical-inbound"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "ACTIVE_NO_PROGRESS", actionable: false, action: "NONE" }); x.store.close();
  });

  it("does not let delayed historical inbound poison the newer dispatch generation", async () => {
    const x = setup(); task(x, "generation-fence", "DISPATCHED", "QA", "CLAUDE_CODE");
    x.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at)
      VALUES('dispatch-generation-fence','generation-fence','TASK','ORCHESTRATOR','CLAUDE',?,?)`)
      .run(JSON.stringify({ role: "QA", round: 0, dispatch_id: "current-generation" }), RECENT);
    x.store.db.prepare("UPDATE task_roles SET started_at=? WHERE task_id=? AND sequence=1").run(RECENT, "generation-fence");
    inbound(x, "generation-fence", "REVIEWER", "OPENCODE", 0);
    x.store.db.prepare("UPDATE inbound_messages SET received_at=? WHERE task_id=?").run(RECENT, "generation-fence");
    watch(x, "generation-fence"); const report = await x.watchdog.runOnce("generation-fence");
    expect(report.observations[0]).toMatchObject({ classification: "ACTIVE_NO_PROGRESS", actionable: false, action: "NONE" });
    expect(x.store.db.prepare("SELECT state FROM inbound_messages WHERE task_id=?").get("generation-fence")).toMatchObject({ state: "RECEIVED" });
    expect(x.store.db.prepare("SELECT 1 FROM protocol_events WHERE event_id='dispatch-generation-fence'").get()).toBeTruthy();
    x.store.close();
  });

  it("fences a dead RUNNING process and selects an alternate Worker", async () => {
    const x = setup(); task(x, "dead", "RUNNING"); worker(x, "dead", "RUNNING", 7001, OLD); x.alive.set(7001, false); watch(x, "dead");
    const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "PROCESS_LOST", action: "REASSIGNED" });
    expect(x.store.db.prepare("SELECT status FROM worker_processes WHERE process_id='proc-dead'").get()).toMatchObject({ status: "LOST" });
    expect(x.tasks.get("dead")?.assignedAgent).not.toBe("CODEX"); x.store.close();
  });

  it("does not recover a live process with recent progress evidence", async () => {
    const x = setup(); task(x, "healthy", "RUNNING"); worker(x, "healthy", "RUNNING", 7002, RECENT); x.alive.set(7002, true); watch(x, "healthy");
    const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "PROCESS_STILL_RUNNING", action: "PROGRESS_EVIDENCE" });
    expect(x.sink.events).toHaveLength(0); expect(x.tasks.get("healthy")?.status).toBe("RUNNING"); x.store.close();
  });

  it("does not let repeated Codex pipe failures masquerade as a healthy heartbeat", async () => {
    const x = setup(); task(x, "pipe-timeout", "RUNNING"); worker(x, "pipe-timeout", "RUNNING", 7005, RECENT); x.alive.set(7005, true);
    x.processLogs.set(path.join(x.dir, "pipe-timeout.log"), [
      "[2026-08-22T11:59:57.000Z] stderr: Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in",
      "[2026-08-22T11:59:58.000Z] stderr: Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in",
      "[2026-08-22T11:59:59.000Z] stderr: Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in",
    ].join("\n"));
    watch(x, "pipe-timeout"); const first = await x.watchdog.runOnce("timer-1");
    expect(first.observations[0]).toMatchObject({ classification: "RUNNING_NO_PROGRESS", action: "CANCEL_REQUESTED" });
    expect(first.observations[0]?.reason).toBe("REPEATED_CODEX_PIPE_TIMEOUT:3");
    x.alive.set(7005, false); const second = await x.watchdog.runOnce("timer-2");
    expect(second.observations[0]).toMatchObject({ classification: "PROCESS_LOST", action: "REASSIGNED" }); x.store.close();
  });

  it("treats a printed provider quota failure as immediate Worker unavailability", async () => {
    const x = setup(); task(x, "provider-quota", "RUNNING", "QA", "OPENCODE"); worker(x, "provider-quota", "RUNNING", 7009, RECENT, "OPENCODE"); x.alive.set(7009, true);
    x.processLogs.set(path.join(x.dir, "provider-quota.log"), "AI_APICallError: Weekly usage limit reached. Resets in 1 day.");
    watch(x, "provider-quota"); const first = await x.watchdog.runOnce("timer-1");
    expect(first.observations[0]).toMatchObject({ classification: "WORKER_UNAVAILABLE", reason: "WORKER_PROVIDER_CAPACITY_EXHAUSTED", action: "CANCEL_REQUESTED" });
    expect(x.agents.get("OPENCODE")?.health).toBe("ERROR");
    x.alive.set(7009, false); const second = await x.watchdog.runOnce("timer-2");
    expect(second.observations[0]).toMatchObject({ classification: "PROCESS_LOST", action: "REASSIGNED" }); x.store.close();
  });

  it("cancels a live stalled process, then fences and reassigns after the PID exits", async () => {
    const x = setup(); task(x, "stalled", "RUNNING"); worker(x, "stalled", "RUNNING", 7004, OLD); x.alive.set(7004, true); watch(x, "stalled");
    const first = await x.watchdog.runOnce("timer-1"); expect(first.observations[0]).toMatchObject({ classification: "RUNNING_NO_PROGRESS", action: "CANCEL_REQUESTED" });
    expect(x.store.db.prepare("SELECT retry_count,cancel_requested_at FROM continuation_recovery_state WHERE task_id='stalled'").get())
      .toMatchObject({ retry_count: 0, cancel_requested_at: new Date(NOW).toISOString() });
    expect(x.processControl).toMatchObject({ terminateCalls: 1, cancelCalls: 0 });
    x.alive.set(7004, false); const second = await x.watchdog.runOnce("timer-2");
    expect(second.observations[0]).toMatchObject({ classification: "PROCESS_LOST", action: "REASSIGNED" }); x.store.close();
  });

  it("safe-stops when a live process resists bounded cancel and terminate requests", async () => {
    const x = setup(); task(x, "resists-cancel", "RUNNING"); worker(x, "resists-cancel", "RUNNING", 7006, OLD); x.alive.set(7006, true); watch(x, "resists-cancel");
    expect((await x.watchdog.runOnce("timer-1")).observations[0]?.action).toBe("CANCEL_REQUESTED");
    x.setNow(NOW + 1_001); expect((await x.watchdog.runOnce("timer-2")).observations[0]?.action).toBe("CANCEL_REQUESTED");
    x.setNow(NOW + 2_001); expect((await x.watchdog.runOnce("timer-3")).observations[0]?.action).toBe("SAFE_STOP");
    expect(x.tasks.get("resists-cancel")?.status).toBe("FAIL"); x.store.close();
  });

  it("fences a live stalled process before safe-stop when prior recoveries exhausted the bound", async () => {
    const x = setup(); task(x, "exhausted-live", "RUNNING"); worker(x, "exhausted-live", "RUNNING", 7008, OLD); x.alive.set(7008, true); watch(x, "exhausted-live");
    expect((await x.watchdog.runOnce("timer-1")).observations[0]?.action).toBe("CANCEL_REQUESTED");
    x.store.db.prepare("UPDATE continuation_recovery_state SET retry_count=2 WHERE task_id='exhausted-live'").run();
    const stopped = await x.watchdog.runOnce("timer-2");
    expect(stopped.observations[0]?.action).toBe("SAFE_STOP"); expect(x.tasks.get("exhausted-live")?.status).toBe("FAIL");
    expect(x.store.db.prepare("SELECT status FROM worker_processes WHERE process_id='proc-exhausted-live'").get()).toMatchObject({ status: "CANCELLED" }); x.store.close();
  });

  it("revalidates transient Worker health before declaring fallback unavailable", async () => {
    const x = setup(); task(x, "health-refresh", "WAITING_RESULT"); worker(x, "health-refresh", "EXITED", 7007, OLD);
    for (const id of ["CLAUDE_CODE", "COMMAND_CODE", "OPENCODE"] as AgentId[]) x.agents.setHealth(id, { status: "ERROR", detail: "transient" });
    x.setRefreshHealth(async () => { x.agents.setHealth("CLAUDE_CODE", { status: "ONLINE", detail: "probe passed" }); });
    watch(x, "health-refresh"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "WAITING_RESULT_NO_PROGRESS", action: "REASSIGNED", assignedAgent: "CLAUDE_CODE" });
    expect(x.agents.get("CLAUDE_CODE")?.health).toBe("ONLINE"); x.store.close();
  });

  it("fails closed and recovers WAITING_RESULT after process exit without a valid Result", async () => {
    const x = setup(); task(x, "missing-result", "WAITING_RESULT"); worker(x, "missing-result", "EXITED", 7003, OLD); watch(x, "missing-result");
    const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "WAITING_RESULT_NO_PROGRESS", action: "REASSIGNED" }); x.store.close();
  });

  it("replays a persisted failed Review whose Developer revision handoff was interrupted", async () => {
    const x = setup(); const id = "review-handoff-orphan";
    x.tasks.create({ taskId: id, projectId: "p", title: id, goal: "replay only the missing durable transition", taskType: "FEATURE",
      requiredRoles: ["DEVELOPER", "REVIEWER", "QA"], teamMode: "SEQUENTIAL", currentRoleSequence: 2, role: "REVIEWER",
      requiredCapabilities: ["coding"], assignedAgent: "CLAUDE_CODE", status: "QUEUED", workspace: path.join(x.dir, "p", id),
      readContext: {}, fileScope: ["src/**"], doNot: [], validation: ["npm test"], owner: "MAIN", nextOwner: "MAIN" });
    x.teams.create(id, "FEATURE", ["DEVELOPER", "REVIEWER", "QA"]);
    x.teams.assign(id, 1, "COMMAND_CODE", "TEST"); x.teams.activate(id, 1); x.teams.finish(id, 1, "PASS", "implementation");
    x.teams.assign(id, 2, "CLAUDE_CODE", "TEST"); x.teams.activate(id, 2); x.teams.finish(id, 2, "FAIL", "validation missing");
    x.teams.assign(id, 3, "CODEX", "TEST"); x.tasks.setCurrentTeamRole(id, 2, "REVIEWER", "CLAUDE_CODE");
    x.tasks.transition(id, "DISPATCHED"); x.tasks.transition(id, "CLAIMED", { attempt: 1, assignedAgent: "CLAUDE_CODE" }); x.tasks.transition(id, "RUNNING");
    worker(x, id, "EXITED", 7010, OLD, "CLAUDE_CODE");
    x.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at)
      VALUES('review-orphan',?,'REVIEW','CLAUDE_CODE','MAIN',?,?)`)
      .run(id, JSON.stringify({ verdict: "REVISION_REQUIRED", findings: ["npm test was not run"], role: "REVIEWER", round: 0 }), OLD);
    watch(x, id); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "DURABLE_STATE_ORPHAN", action: "RETRIED", assignedAgent: "COMMAND_CODE" });
    expect(x.sink.events).toHaveLength(1); expect(x.sink.events[0]).toMatchObject({ type: "REVISION_REQUEST", sender: "CLAUDE_CODE", recipient: "COMMANDCODE" });
    expect(x.sink.events[0]?.payload).toMatchObject({ round: 1, source_event_id: "review-orphan", recovery_reason: "DURABLE_REVIEW_HANDOFF_ORPHAN" });
    expect(x.teams.role(id, 1)).toMatchObject({ status: "ACTIVE", revisionRound: 1 }); x.store.close();
  });

  it("suppresses duplicate timer wakes idempotently", async () => {
    const x = setup(); task(x, "duplicate", "DISPATCHED"); inbound(x, "duplicate", "DEVELOPER", "CODEX"); watch(x, "duplicate");
    await Promise.all([x.watchdog.runOnce("timer-a"), x.watchdog.runOnce("timer-b")]);
    expect(x.sink.events.filter((e) => e.type === "TASK")).toHaveLength(1);
    const row = x.store.db.prepare("SELECT retry_count FROM continuation_recovery_state WHERE task_id='duplicate'").get() as { retry_count: number };
    expect(row.retry_count).toBe(1); x.store.close();
  });

  it("does not let a stale wake completion mutate a newer Role round", async () => {
    const x = setup(); task(x, "stale", "DISPATCHED"); inbound(x, "stale", "DEVELOPER", "CODEX"); watch(x, "stale");
    let release!: () => void; x.sink.gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = x.watchdog.runOnce("timer"); await new Promise((resolve) => setTimeout(resolve, 0));
    const selected = x.tasks.get("stale")!.assignedAgent!; x.teams.reopen("stale", 1, 1); x.tasks.setCurrentTeamRole("stale", 1, "DEVELOPER", selected);
    release(); await pending;
    expect(x.teams.role("stale", 1)).toMatchObject({ revisionRound: 1, assignedAgent: selected }); x.store.close();
  });

  it("never dispatches an unrelated historical Task", async () => {
    const x = setup(); task(x, "watched", "DISPATCHED"); inbound(x, "watched", "DEVELOPER", "CODEX");
    task(x, "historical", "DISPATCHED", "DEVELOPER", "OPENCODE", "other"); inbound(x, "historical", "DEVELOPER", "OPENCODE"); watch(x, "watched");
    const report = await x.watchdog.runOnce("timer");
    expect(report.globalDispatcherTickUsed).toBe(false); expect(x.sink.events.map((e) => e.taskId)).toEqual(["watched"]);
    expect(x.tasks.get("historical")?.assignedAgent).toBe("OPENCODE"); x.store.close();
  });

  it("reserves fallback capacity so two scoped recoveries do not launch on one Worker", async () => {
    const x = setup(); task(x, "parallel-a", "DISPATCHED", "DEVELOPER", "CODEX"); inbound(x, "parallel-a", "DEVELOPER", "CODEX");
    task(x, "parallel-b", "DISPATCHED", "DEVELOPER", "OPENCODE"); inbound(x, "parallel-b", "DEVELOPER", "OPENCODE"); watch(x, "parallel-a", "parallel-b");
    await x.watchdog.runOnce("timer");
    expect(x.tasks.get("parallel-a")?.assignedAgent).not.toBe(x.tasks.get("parallel-b")?.assignedAgent);
    expect(x.sink.events.filter((e) => e.type === "TASK")).toHaveLength(2); x.store.close();
  });

  it("durably waits for a temporarily busy eligible fallback without consuming the recovery bound", async () => {
    const x = setup(); task(x, "capacity-wait", "DISPATCHED", "DEVELOPER", "CODEX"); inbound(x, "capacity-wait", "DEVELOPER", "CODEX");
    x.agents.markBusy("CLAUDE_CODE", "other-task", "p", "DEVELOPER", x.dir);
    x.agents.setHealth("COMMAND_CODE", { status: "ERROR", detail: "unavailable" }); x.agents.setHealth("OPENCODE", { status: "ERROR", detail: "unavailable" });
    watch(x, "capacity-wait"); const waiting = await x.watchdog.runOnce("timer-1");
    expect(waiting.observations[0]?.action).toBe("BOUNDED_RETRY");
    expect(x.store.db.prepare("SELECT retry_count,capacity_wait_started_at FROM continuation_recovery_state WHERE task_id='capacity-wait'").get())
      .toMatchObject({ retry_count: 0, capacity_wait_started_at: new Date(NOW).toISOString() });
    expect(x.tasks.get("capacity-wait")?.status).toBe("DISPATCHED");
    x.agents.release("CLAUDE_CODE"); const resumed = await x.watchdog.runOnce("timer-2");
    expect(resumed.observations[0]).toMatchObject({ action: "REASSIGNED", assignedAgent: "CLAUDE_CODE" }); x.store.close();
  });

  it("safe-stops when the durable fallback-capacity deadline expires", async () => {
    const x = setup(); task(x, "capacity-expired", "DISPATCHED", "DEVELOPER", "CODEX"); inbound(x, "capacity-expired", "DEVELOPER", "CODEX");
    x.agents.markBusy("CLAUDE_CODE", "other-task", "p", "DEVELOPER", x.dir);
    x.agents.setHealth("COMMAND_CODE", { status: "ERROR", detail: "unavailable" }); x.agents.setHealth("OPENCODE", { status: "ERROR", detail: "unavailable" });
    watch(x, "capacity-expired"); expect((await x.watchdog.runOnce("timer-1")).observations[0]?.action).toBe("BOUNDED_RETRY");
    x.setNow(NOW + 5_001); const stopped = await x.watchdog.runOnce("timer-2");
    expect(stopped.observations[0]?.action).toBe("SAFE_STOP"); expect(x.tasks.get("capacity-expired")?.status).toBe("CANCELLED"); x.store.close();
  });

  it("never reassigns a Task to a Worker whose latest attempt on it failed", async () => {
    // Dual Dogfood Run 02 worker-fallback proof: Codex's latest durable attempt on the
    // Task died on unified-exec runner pipe timeouts (exit 1), but CLI health probes
    // still report ONLINE -- deterministic scoring must not hand the replacement back
    // to the failed Worker.
    const x = setup(); task(x, "failed-worker", "DISPATCHED", "DEVELOPER", "CLAUDE_CODE");
    worker(x, "failed-worker", "EXITED", 7011, OLD, "CODEX");
    x.store.db.prepare("UPDATE worker_processes SET exit_code=1 WHERE task_id='failed-worker' AND agent_id='CODEX'").run();
    watch(x, "failed-worker"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "ACTIVE_NO_PROGRESS", action: "REASSIGNED" });
    expect(x.tasks.get("failed-worker")?.assignedAgent).not.toBe("CODEX"); x.store.close();
  });

  it("restores Worker eligibility after a newer successful attempt on the same Task", async () => {
    const x = setup(); task(x, "recovered-worker", "DISPATCHED", "DEVELOPER", "CLAUDE_CODE");
    worker(x, "recovered-worker", "EXITED", 7012, OLD, "CODEX");
    x.store.db.prepare("UPDATE worker_processes SET exit_code=1 WHERE task_id='recovered-worker' AND agent_id='CODEX'").run();
    x.store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path)
      VALUES('proc-recovered-newer','CODEX','recovered-worker',1,7013,?,NULL,?,?,0,'EXITED',?)`).run(x.dir, RECENT, RECENT, path.join(x.dir, "newer.log"));
    watch(x, "recovered-worker"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "ACTIVE_NO_PROGRESS", action: "REASSIGNED", assignedAgent: "CODEX" });
    expect(x.tasks.get("recovered-worker")?.assignedAgent).toBe("CODEX"); x.store.close();
  });

  it("still selects a replacement when every Worker carries a failed latest attempt", async () => {
    // Restart churn / cascading environment faults can leave no clean candidate.
    // Failed-standing exclusion is a routing preference, not an absolute bar:
    // the second pass picks the best available Worker instead of stranding the
    // Task -- the recovery bound already caps repeat offenders.
    const x = setup(); task(x, "all-failed", "DISPATCHED", "DEVELOPER", "CLAUDE_CODE");
    worker(x, "all-failed", "EXITED", 7014, OLD, "CODEX");
    x.store.db.prepare("UPDATE worker_processes SET exit_code=1 WHERE task_id='all-failed' AND agent_id='CODEX'").run();
    x.store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path)
      VALUES('proc-all-failed-open','OPENCODE','all-failed',1,7015,?,NULL,?,?,NULL,'LOST',?)`).run(x.dir, OLD, OLD, path.join(x.dir, "af-o.log"));
    x.store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path)
      VALUES('proc-all-failed-cmd','COMMAND_CODE','all-failed',1,7016,?,NULL,?,?,1,'EXITED',?)`).run(x.dir, OLD, OLD, path.join(x.dir, "af-c.log"));
    watch(x, "all-failed"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "ACTIVE_NO_PROGRESS", action: "REASSIGNED" });
    expect(x.tasks.get("all-failed")?.assignedAgent).toBeTruthy(); x.store.close();
  });

  it("reassigns a Role whose durable Result recorded a worker failure", async () => {
    // DDF-002 round 13: Claude Code exited with "401 OAuth token expired" and a
    // durable ok:false RESULT -- failure evidence, not progress evidence.
    const x = setup(); task(x, "failed-result", "WAITING_RESULT", "DEVELOPER", "CLAUDE_CODE"); worker(x, "failed-result", "EXITED", 7017, OLD, "CLAUDE_CODE");
    x.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at)
      VALUES('failed-result-r',?,'RESULT','CLAUDE_CODE','COMMANDCODE',?,?)`)
      .run("failed-result", JSON.stringify({ ok: false, result: "Failed to authenticate. API Error: 401 OAuth access token has expired." }), OLD);
    watch(x, "failed-result"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "WORKER_FAILED_WITH_RESULT", actionable: true, action: "REASSIGNED" });
    expect(x.tasks.get("failed-result")?.assignedAgent).not.toBe("CLAUDE_CODE"); x.store.close();
  });

  it("WORKER_FAILURE: a Reviewer execution failure still reaches existing reassignment", async () => {
    const x = setup(); task(x, "failed-reviewer", "WAITING_RESULT", "REVIEWER", "CODEX"); worker(x, "failed-reviewer", "EXITED", 7018, OLD, "CODEX");
    x.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at)
      VALUES('failed-reviewer-r',?,'REVIEW','CODEX','ASUS',?,?)`)
      .run("failed-reviewer", JSON.stringify({ ok: false, verdict: "REVIEW_FAIL", result: "Reviewer transport execution failed" }), OLD);
    watch(x, "failed-reviewer"); const report = await x.watchdog.runOnce("timer-reviewer-failure");
    expect(report.observations[0]).toMatchObject({ classification: "WORKER_FAILED_WITH_RESULT", actionable: true, action: "REASSIGNED" });
    expect(x.tasks.get("failed-reviewer")?.assignedAgent).not.toBe("CODEX"); x.store.close();
  });

  it("repairs a legacy all-PASS Team whose fallback Reviewer made the QA assignment violate SoD", async () => {
    const x = setup(); const id = "legacy-sod";
    x.tasks.create({ taskId: id, projectId: "p", title: id, goal: "repair stale QA separation", taskType: "FEATURE",
      requiredRoles: ["DEVELOPER", "REVIEWER", "QA"], teamMode: "SEQUENTIAL", currentRoleSequence: 3, role: "QA",
      requiredCapabilities: ["coding"], assignedAgent: "CLAUDE_CODE", status: "QUEUED", workspace: path.join(x.dir, "p", id),
      readContext: {}, fileScope: ["src/**"], doNot: [], validation: [], owner: "MAIN", nextOwner: "MAIN" });
    x.teams.create(id, "FEATURE", ["DEVELOPER", "REVIEWER", "QA"]);
    for (const [sequence, role, agent] of [[1, "DEVELOPER", "CODEX"], [2, "REVIEWER", "CLAUDE_CODE"], [3, "QA", "CLAUDE_CODE"]] as const) {
      x.teams.assign(id, sequence, agent, "LEGACY_ASSIGNMENT"); x.teams.activate(id, sequence); x.teams.finish(id, sequence, "PASS", `${role} pass`);
    }
    x.tasks.setCurrentTeamRole(id, 3, "QA", "CLAUDE_CODE"); x.tasks.transition(id, "DISPATCHED"); x.tasks.transition(id, "CLAIMED", { attempt: 1 });
    x.tasks.transition(id, "RUNNING"); x.tasks.transition(id, "WAITING_MAIN"); watch(x, id);
    const report = await x.watchdog.runOnce("timer"); const qa = x.teams.role(id, 3)!;
    expect(report.observations[0]).toMatchObject({ classification: "DURABLE_STATE_ORPHAN", action: "REASSIGNED" });
    expect(qa.assignedAgent).not.toBe("CODEX"); expect(qa.assignedAgent).not.toBe("CLAUDE_CODE");
    expect(x.tasks.get(id)?.status).toBe("DISPATCHED"); x.store.close();
  });

  it("requires no human message or owner event to produce a retry", async () => {
    const x = setup(); task(x, "owner-independent", "DISPATCHED"); inbound(x, "owner-independent", "DEVELOPER", "CODEX"); watch(x, "owner-independent");
    expect(x.store.db.prepare("SELECT 1 FROM inbound_messages WHERE task_id=? AND sender IN ('MAIN','OWNER')").get("owner-independent")).toBeUndefined();
    const report = await x.watchdog.runOnce("interval"); expect(report.observations[0]?.action).toBe("REASSIGNED"); x.store.close();
  });

  it("enters a durable terminal SAFE_STOP when no eligible Worker exists", async () => {
    const x = setup(); task(x, "no-worker", "DISPATCHED");
    for (const agent of x.agents.list()) x.agents.setHealth(agent.agentId, { status: "ERROR", detail: "unavailable" });
    watch(x, "no-worker"); const report = await x.watchdog.runOnce("timer");
    expect(report.observations[0]).toMatchObject({ classification: "WORKER_UNAVAILABLE", action: "SAFE_STOP" });
    expect(x.tasks.get("no-worker")).toMatchObject({ status: "CANCELLED" });
    expect(x.tasks.get("no-worker")?.result).toContain("SAFE_STOP:NO_PROGRESS_CONTINUATION"); expect(x.watchdog.watchedTaskIds()).toEqual([]); x.store.close();
  });

  // V1 recovery separation-of-duties correction: a failed
  // Developer must never be replaced by a Worker already reserved for the independent
  // downstream Reviewer or QA Role, and a Worker's failure history for this Role must survive
  // both a later Worker's failure and a Runtime restart instead of being forgotten.
  describe("recovery separation-of-duties and durable failure history", () => {
    function sodTeam(x: ReturnType<typeof setup>, id: string, developer: AgentId) {
      x.tasks.create({ taskId: id, projectId: "p", title: id, goal: "bounded recovery test", taskType: "FEATURE",
        requiredRoles: ["DEVELOPER", "REVIEWER", "QA"], teamMode: "SEQUENTIAL", currentRoleSequence: 1, role: "DEVELOPER",
        requiredCapabilities: ["coding"], assignedAgent: developer, status: "QUEUED", workspace: path.join(x.dir, "p", id),
        readContext: {}, fileScope: ["src/**"], doNot: [], validation: [], owner: "MAIN", nextOwner: "MAIN" });
      x.teams.create(id, "FEATURE", ["DEVELOPER", "REVIEWER", "QA"]);
      x.teams.assign(id, 1, developer, "TEST"); x.teams.activate(id, 1);
      // Real initial planning (TeamPlanner.plan) always durably records its routing decision --
      // mirror that here so the Developer's original identity is part of the same append-only
      // routing_decisions history a real fresh-planned Task would have, instead of a test-seed
      // artifact silently skipping it.
      x.teams.recordDecision(id, 1, { role: "DEVELOPER", selectedAgent: developer, reasonCode: "ROLE_ASSIGNED", selectedReasons: ["TEST_SEED"], rejected: [] });
      x.teams.assign(id, 2, "CODEX", "RESERVED_REVIEWER"); x.teams.assign(id, 3, "COMMAND_CODE", "RESERVED_QA");
      x.tasks.setCurrentTeamRole(id, 1, "DEVELOPER", developer);
      x.tasks.transition(id, "DISPATCHED"); x.tasks.transition(id, "CLAIMED", { attempt: 1 }); x.tasks.transition(id, "RUNNING"); x.tasks.transition(id, "WAITING_RESULT");
    }
    function failResult(x: ReturnType<typeof setup>, id: string, agent: AgentId, pid: number, eventId: string) {
      // worker_processes.attempt must match the Task's current attempt (the Watchdog looks up
      // the process row by task_id+agent_id+attempt), which advances by 1 on every recovery
      // reassignment -- read it fresh rather than assuming attempt=1 like the shared `worker()`
      // helper does, so this also works for a Task's second/third recovery cycle.
      const attempt = x.tasks.get(id)!.attempt;
      x.store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path)
        VALUES(?,?,?,?,?,?,NULL,?,?,NULL,'EXITED',?)`).run(`proc-${id}-${eventId}`, agent, id, attempt, pid, x.dir, OLD, OLD, path.join(x.dir, `${id}-${eventId}.log`));
      x.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at)
        VALUES(?,?,'RESULT',?,'COMMANDCODE',?,?)`).run(eventId, id, agent, JSON.stringify({ ok: false, result: "semantic RESULT classified fail-closed" }), OLD);
    }

    it("DEVELOPER_FAILURE_WITH_RESERVED_REVIEWER / RESERVED_QA / LAWFUL_ALTERNATE_WORKER: recovers to the unreserved Worker, never the reserved Reviewer or QA", async () => {
      const x = setup(); const id = "cert-d023-sod"; sodTeam(x, id, "CLAUDE_CODE"); failResult(x, id, "CLAUDE_CODE", 7101, "d023-r1");
      watch(x, id); const report = await x.watchdog.runOnce("timer");
      expect(report.observations[0]).toMatchObject({ classification: "WORKER_FAILED_WITH_RESULT", action: "REASSIGNED" });
      const newDeveloper = x.tasks.get(id)?.assignedAgent;
      expect(newDeveloper).not.toBe("CLAUDE_CODE"); expect(newDeveloper).not.toBe("CODEX"); expect(newDeveloper).not.toBe("COMMAND_CODE");
      expect(newDeveloper).toBe("OPENCODE");
      const decision = x.store.db.prepare("SELECT rejected_json FROM routing_decisions WHERE task_id=? AND sequence=1 ORDER BY created_at DESC LIMIT 1").get(id) as { rejected_json: string };
      const rejected = JSON.parse(decision.rejected_json) as Array<{ agentId: string; reasons: string[] }>;
      expect(rejected.find((r) => r.agentId === "CODEX")?.reasons).toContain("SEPARATION_OF_DUTIES");
      expect(rejected.find((r) => r.agentId === "COMMAND_CODE")?.reasons).toContain("SEPARATION_OF_DUTIES");
      x.store.close();
    });

    it("MULTIPLE_FAILURE_HISTORY / NO_LAWFUL_REPLACEMENT: a later Worker's failure does not resurrect the originally failed Worker -- fails closed instead", async () => {
      const x = setup(); const id = "cert-d023-multi"; sodTeam(x, id, "CLAUDE_CODE"); failResult(x, id, "CLAUDE_CODE", 7102, "d023-m1");
      watch(x, id); const first = await x.watchdog.runOnce("timer-1");
      expect(first.observations[0]?.action).toBe("REASSIGNED"); expect(x.tasks.get(id)?.assignedAgent).toBe("OPENCODE");
      x.tasks.transition(id, "CLAIMED", { attempt: 2 }); x.tasks.transition(id, "RUNNING"); x.tasks.transition(id, "WAITING_RESULT");
      failResult(x, id, "OPENCODE", 7103, "d023-m2");
      const second = await x.watchdog.runOnce("timer-2");
      // Every capable Worker is now exhausted: CLAUDE_CODE and OPENCODE both carry durable
      // Role failure history, CODEX/COMMAND_CODE remain SoD-reserved -- the Company must fail
      // closed instead of destroying separation-of-duties or reintroducing a failed Worker.
      expect(second.observations[0]?.action).toBe("SAFE_STOP");
      const finalAgent = x.tasks.get(id)?.assignedAgent;
      expect(finalAgent).not.toBe("CLAUDE_CODE"); expect(finalAgent).not.toBe("CODEX"); expect(finalAgent).not.toBe("COMMAND_CODE");
      x.store.close();
    });

    it("RESTART_DURABILITY: a fresh Runtime instance reconstructs the failed-Worker history instead of forgetting all but the latest failure", async () => {
      const x = setup(); const id = "cert-d023-restart"; sodTeam(x, id, "CLAUDE_CODE"); failResult(x, id, "CLAUDE_CODE", 7104, "d023-s1");
      watch(x, id); await x.watchdog.runOnce("timer-1");
      expect(x.tasks.get(id)?.assignedAgent).toBe("OPENCODE");
      x.tasks.transition(id, "CLAIMED", { attempt: 2 }); x.tasks.transition(id, "RUNNING"); x.tasks.transition(id, "WAITING_RESULT");
      failResult(x, id, "OPENCODE", 7105, "d023-s2");
      // Simulate a Runtime restart: build entirely fresh repository/router/watchdog instances
      // over the same durable Store rather than reusing any in-process object from before.
      const restartedTasks = new TaskRepository(x.store); const restartedTeams = new TeamRepository(x.store);
      const restartedAgents = new AgentRegistry(x.store); const restartedRoles = new RoleRegistry(x.store);
      const restartedLocks = new WorkspaceLocks(x.store); const restartedRouter = new AgentRouter(restartedAgents, restartedRoles, restartedLocks, () => true);
      const restartedProtocol = new Protocol(x.store, x.sink);
      const restartedBudget = new RunBudgetController(x.store, () => Date.now(), () => true);
      const restartedWatchdog = new ScopedContinuationWatchdog(x.store, restartedTasks, restartedTeams, restartedAgents, restartedLocks, restartedRouter, restartedProtocol,
        { nowMs: () => Date.now(), pidAlive: () => false, cancelTask: () => true, terminatePid: () => true, readProcessLog: () => "", refreshHealth: async () => {} }, restartedBudget);
      const afterRestart = await restartedWatchdog.runOnce("post-restart");
      expect(afterRestart.observations[0]?.action).toBe("SAFE_STOP");
      const finalAgent = restartedTasks.get(id)?.assignedAgent;
      expect(finalAgent).not.toBe("CLAUDE_CODE"); expect(finalAgent).not.toBe("CODEX"); expect(finalAgent).not.toBe("COMMAND_CODE");
      x.store.close();
    });

    it("CROSS_TASK_ISOLATION: Developer failure history on one Task does not blacklist the Worker on an unrelated Task", async () => {
      const x = setup();
      // Task A: CLAUDE_CODE fails as Developer and is durably excluded for Task A's Role.
      sodTeam(x, "cert-d023-cross-a", "CLAUDE_CODE"); failResult(x, "cert-d023-cross-a", "CLAUDE_CODE", 7106, "d023-x1");
      watch(x, "cert-d023-cross-a"); await x.watchdog.runOnce("timer-a");
      expect(x.tasks.get("cert-d023-cross-a")?.assignedAgent).toBe("OPENCODE");
      x.watchdog.unwatch("cert-d023-cross-a"); // isolate the next runOnce to Task B only
      // Being replaced on Task A also marks CLAUDE_CODE's global CLI health ERROR -- that is a
      // separate, intentionally cross-Task health signal (see "revalidates transient Worker
      // health"), not the failed-Role-history exclusion under test here. Reset it so this test
      // isolates the routing_decisions-based exclusion specifically.
      x.agents.setHealth("CLAUDE_CODE", { status: "ONLINE", detail: "unrelated health signal reset for isolation test" });
      // Task B: an unrelated Task with the same reserved Reviewer/QA, but a *different* Worker
      // (OPENCODE) fails as Developer. CLAUDE_CODE is the only remaining lawful candidate --
      // if Task A's history leaked across Tasks, CLAUDE_CODE would be wrongly excluded here too
      // and Task B would fail closed instead of recovering.
      sodTeam(x, "cert-d023-cross-b", "OPENCODE"); failResult(x, "cert-d023-cross-b", "OPENCODE", 7107, "d023-x2");
      watch(x, "cert-d023-cross-b"); const other = await x.watchdog.runOnce("timer-b");
      expect(other.observations[0]?.action).toBe("REASSIGNED");
      expect(x.tasks.get("cert-d023-cross-b")?.assignedAgent).toBe("CLAUDE_CODE");
      x.store.close();
    });
  });
});
