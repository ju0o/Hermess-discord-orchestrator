import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { TeamRepository } from "../src/teams/repository.js";
import { TaskCompletionProjection } from "../src/tasks/completionProjection.js";
import { AgentRegistry } from "../src/registry/agentRegistry.js";
import { RoleRegistry } from "../src/registry/roleRegistry.js";
import { agentToBotType } from "../src/discord/control/types.js";
import type { AgentId } from "../src/domain/types.js";
import { Protocol, type ProtocolSink, type ProtocolEvent } from "../src/tasks/protocol.js";
import type { TaskRecord } from "../src/domain/types.js";
import { RunBudgetController } from "../src/runtime/runBudget.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) { const d = dirs.pop()!; try { rmSync(d, { recursive: true, force: true }); } catch {} } });

class CompletionSink implements ProtocolSink {
  events: ProtocolEvent[] = [];
  async publish(event: ProtocolEvent, _task: TaskRecord): Promise<string> { this.events.push(event); return `completion-${this.events.length}`; }
}

function recordTeamChain(store: Store, taskId: string, payload: Record<string, unknown> = { status: "PASS", result: "TEAM_CHAIN_COMPLETE", role: "QA", chain_complete: true }): void {
  store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(`verdict-${taskId}-${Math.random()}`, taskId, "VERDICT", "COMMAND_CODE", "ASUS", JSON.stringify(payload), store.now());
}

function setupTeam(opts: { status?: string; taskStatus?: string; allPass?: boolean; withSoD?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "proj-test-"));
  dirs.push(dir);
  const store = new Store(path.join(dir, "test.db"));
  const tasks = new TaskRepository(store);
  const teams = new TeamRepository(store);
  const agents = new AgentRegistry(store); const roles = new RoleRegistry(store); roles.seed();
  for (const a of ["CODEX","CLAUDE_CODE","COMMAND_CODE"] as AgentId[]) agents.upsert({ agentId: a, displayName: a, backendType: "TEST", discordBotId: `id-${a}`, status: "AVAILABLE", capabilities: ["coding"], health: "ONLINE" });
  tasks.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  const taskId = `T-${Math.random().toString(16).slice(2,6)}`;
  tasks.create({ taskId, projectId: "p", title: "proj", goal: "goal", taskType: "FEATURE", requiredRoles: ["DEVELOPER","REVIEWER","QA"], teamMode: "SEQUENTIAL", currentRoleSequence: 1, role: "DEVELOPER", requiredCapabilities: ["coding"], assignedAgent: "CODEX", status: (opts.taskStatus as never) ?? "DISPATCHED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "ASUS", nextOwner: "ASUS" });
  // Use stub workroom to avoid Discord.
  store.db.prepare("INSERT INTO workrooms(task_id,thread_id,parent_channel_id,thread_name,state,created_at,last_synced_at,last_reason) VALUES(?,?,?,?,?,?,?,?)").run(taskId, `thread-${taskId}`, "parent", taskId, "ACTIVE", store.now(), store.now(), "TEST");
  store.db.prepare("UPDATE tasks SET thread_id=? WHERE task_id=?").run(`thread-${taskId}`, taskId);
  teams.create(taskId, "FEATURE", ["DEVELOPER","REVIEWER","QA"]);
  teams.assign(taskId, 1, "CODEX", "test");
  teams.assign(taskId, 2, "CLAUDE_CODE", "test");
  teams.assign(taskId, 3, opts.withSoD ? "CODEX" as AgentId : "COMMAND_CODE" as AgentId, "test");
  if (opts.allPass === false) {
    teams.finish(taskId, 1, "PASS", "ok", ["ev"]);
    teams.finish(taskId, 2, "FAIL", "fail", ["ev"]);
    teams.finish(taskId, 3, "PASS", "ok", ["ev"]);
  } else {
    teams.finish(taskId, 1, "PASS", "ok dev", ["ev"]);
    teams.finish(taskId, 2, "PASS", "ok review", ["ev"]);
    teams.finish(taskId, 3, "PASS", "ok qa", ["ev"]);
  }
  if (opts.status === "COMPLETE" || opts.status === undefined) teams.complete(taskId);
  else if (opts.status === "ACTIVE") { /* leave ACTIVE */ }
  const proj = new TaskCompletionProjection(store, tasks, teams);
  return { dir, store, tasks, teams, taskId, proj };
}

describe("TaskCompletionProjection", () => {
  it("stale DISPATCHED with all PASS + COMPLETE projects to PASS", () => {
    const { store, tasks, taskId, proj } = setupTeam({ taskStatus: "DISPATCHED" });
    try {
      const r = proj.reconcile(taskId);
      expect(r.projected).toBe(true);
      expect(tasks.get(taskId)!.status).toBe("PASS");
      expect(tasks.get(taskId)!.completionCandidate).toBe(true);
      const r2 = proj.reconcile(taskId);
      expect(r2.projected).toBe(false);
    } finally { store.close(); }
  });

  it("does not project when team not COMPLETE", () => {
    const { store, tasks, taskId, proj } = setupTeam({ status: "ACTIVE" });
    try {
      const r = proj.reconcile(taskId);
      expect(r.projected).toBe(false);
      expect(tasks.get(taskId)!.status).not.toBe("PASS");
    } finally { store.close(); }
  });

  it("does not project when not all roles passed", () => {
    const { store, tasks, taskId, proj } = setupTeam({ allPass: false });
    try {
      const r = proj.reconcile(taskId);
      expect(r.projected).toBe(false);
      expect(tasks.get(taskId)!.status).not.toBe("PASS");
    } finally { store.close(); }
  });

  it("does not project when SoD violated (same agent as QA)", () => {
    const { store, tasks, taskId, proj } = setupTeam({ withSoD: true });
    try {
      const r = proj.reconcile(taskId);
      expect(r.projected).toBe(false);
      expect(tasks.get(taskId)!.status).not.toBe("PASS");
    } finally { store.close(); }
  });

  it("does not project from terminal FAIL/BLOCKED/WAITING_MAIN", () => {
    for (const s of ["FAIL","BLOCKED","WAITING_MAIN","HUMAN_GATE"] as const) {
      const { store, tasks, taskId, proj } = setupTeam({ taskStatus: s as never });
      try {
        const r = proj.reconcile(taskId);
        expect(r.projected).toBe(false);
        expect(tasks.get(taskId)!.status).toBe(s);
      } finally { store.close(); }
    }
  });

  it("idempotent: already PASS stays PASS, no duplicate transition", () => {
    const { store, tasks, taskId, proj } = setupTeam({ taskStatus: "PASS" });
    try {
      // Need to manually set team COMPLETE and task PASS (setup defaults PASS for DISPATCHED only)
      // For PASS task, reconcile should be no-op.
      const r = proj.reconcile(taskId);
      expect(r.projected).toBe(false);
      expect(tasks.get(taskId)!.status).toBe("PASS");
    } finally { store.close(); }
  });

  it("backfill projects stale COMPLETE teams", () => {
    const { store, tasks, proj } = setupTeam({ taskStatus: "DISPATCHED" });
    // create second stale task in same store
    const task2 = `T2-${Math.random().toString(16).slice(2,6)}`;
    tasks.create({ taskId: task2, projectId: "p", title: "2", goal: "g", taskType: "FEATURE", requiredRoles: ["DEVELOPER","REVIEWER"], teamMode: "SEQUENTIAL", currentRoleSequence: 1, role: "DEVELOPER", requiredCapabilities: ["coding"], assignedAgent: "CODEX", status: "DISPATCHED", workspace: store.db.prepare("SELECT workspace FROM projects WHERE project_id='p'").get() ? (store.db.prepare("SELECT workspace FROM projects WHERE project_id='p'").get() as {workspace:string}).workspace : "/tmp", readContext: {}, fileScope: [], doNot: [], validation: [], owner: "ASUS", nextOwner: "ASUS" });
    store.db.prepare("INSERT INTO workrooms(task_id,thread_id,parent_channel_id,thread_name,state,created_at,last_synced_at,last_reason) VALUES(?,?,?,?,?,?,?,?)").run(task2, `thread-${task2}`, "parent", task2, "ACTIVE", store.now(), store.now(), "TEST");
    store.db.prepare("UPDATE tasks SET thread_id=? WHERE task_id=?").run(`thread-${task2}`, task2);
    const teams2 = new TeamRepository(store);
    teams2.create(task2, "FEATURE", ["DEVELOPER","REVIEWER"]);
    teams2.assign(task2, 1, "CODEX", "t");
    teams2.assign(task2, 2, "CLAUDE_CODE", "t");
    teams2.finish(task2, 1, "PASS", "ok", ["ev"]);
    teams2.finish(task2, 2, "PASS", "ok", ["ev"]);
    teams2.complete(task2);
    try {
      const r = proj.backfill();
      expect(r.projected.length).toBeGreaterThanOrEqual(1);
      expect(tasks.get(task2)!.status).toBe("PASS");
    } finally { store.close(); }
  });

  it("no-QA team: still projects when all roles passed and gate satisfied", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "noqa-")); dirs.push(dir);
    const store = new Store(path.join(dir, "test.db"));
    const tasks = new TaskRepository(store); const teams = new TeamRepository(store);
    const agents = new AgentRegistry(store); const roles = new RoleRegistry(store); roles.seed();
    for (const a of ["CODEX","CLAUDE_CODE"] as AgentId[]) agents.upsert({ agentId: a, displayName: a, backendType: "TEST", discordBotId: `id-${a}`, status: "AVAILABLE", capabilities: ["coding"], health: "ONLINE" });
    tasks.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
    const taskId = "T-NOQA";
    tasks.create({ taskId, projectId: "p", title: "noqa", goal: "g", taskType: "FEATURE", requiredRoles: ["DEVELOPER","REVIEWER"], teamMode: "SEQUENTIAL", currentRoleSequence: 1, role: "DEVELOPER", requiredCapabilities: ["coding"], assignedAgent: "CODEX", status: "DISPATCHED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "ASUS", nextOwner: "ASUS" });
    store.db.prepare("INSERT INTO workrooms(task_id,thread_id,parent_channel_id,thread_name,state,created_at,last_synced_at,last_reason) VALUES(?,?,?,?,?,?,?,?)").run(taskId, `thread-${taskId}`, "parent", taskId, "ACTIVE", store.now(), store.now(), "TEST");
    store.db.prepare("UPDATE tasks SET thread_id=? WHERE task_id=?").run(`thread-${taskId}`, taskId);
    teams.create(taskId, "FEATURE", ["DEVELOPER","REVIEWER"]);
    teams.assign(taskId, 1, "CODEX", "t"); teams.assign(taskId, 2, "CLAUDE_CODE", "t");
    teams.finish(taskId, 1, "PASS", "ok", ["ev"]); teams.finish(taskId, 2, "PASS", "ok", ["ev"]);
    teams.complete(taskId);
    const proj = new TaskCompletionProjection(store, tasks, teams);
    try {
      expect(proj.reconcile(taskId).projected).toBe(true);
      expect(tasks.get(taskId)!.status).toBe("PASS");
    } finally { store.close(); }
  });

  it("lawful Developer + independent Reviewer + QA PASS emits one authoritative Completion", async () => {
    const { store, tasks, teams, taskId } = setupTeam();
    const sink = new CompletionSink(); const protocol = new Protocol(store, sink);
    try {
      const projection = new TaskCompletionProjection(store, tasks, teams, protocol);
      expect(projection.reconcile(taskId).reason).toBe("AUTHORITATIVE_COMPLETION");
      expect(tasks.get(taskId)).toMatchObject({ status: "COMPLETED" });
      expect(sink.events.filter((event) => event.type === "COMPLETION")).toHaveLength(1);
      expect(store.db.prepare("SELECT count(*) AS count FROM protocol_events WHERE task_id=? AND event_type='COMPLETION'").get(taskId)).toMatchObject({ count: 1 });
      expect(tasks.get(taskId)!.completedAt).toBeTruthy();
    } finally { store.close(); }
  });

  it("replayed continuation is idempotent and cannot duplicate Completion", async () => {
    const { store, tasks, teams, taskId } = setupTeam();
    const sink = new CompletionSink(); const projection = new TaskCompletionProjection(store, tasks, teams, new Protocol(store, sink));
    try {
      projection.reconcile(taskId); const second = projection.reconcile(taskId);
      expect(second.reason).toBe("ALREADY_COMPLETED");
      expect(store.db.prepare("SELECT count(*) AS count FROM protocol_events WHERE task_id=? AND event_type='COMPLETION'").get(taskId)).toMatchObject({ count: 1 });
    } finally { store.close(); }
  });

  it("valid TEAM_CHAIN_COMPLETE closes a stale RUNNING Task before budget can strand it", () => {
    const { store, tasks, teams, taskId } = setupTeam({ taskStatus: "RUNNING", status: "ACTIVE" });
    const sink = new CompletionSink();
    try {
      recordTeamChain(store, taskId);
      const projection = new TaskCompletionProjection(store, tasks, teams, new Protocol(store, sink));
      expect(projection.reconcile(taskId).reason).toBe("AUTHORITATIVE_COMPLETION");
      expect(tasks.get(taskId)).toMatchObject({ status: "COMPLETED", completedAt: expect.any(String) });
      expect(store.db.prepare("SELECT count(*) AS count FROM protocol_events WHERE task_id=? AND event_type='COMPLETION'").get(taskId)).toMatchObject({ count: 1 });
    } finally { store.close(); }
  });

  it("does not complete an all-PASS team without an exact chain-complete verdict", () => {
    const { store, tasks, teams, taskId } = setupTeam({ status: "ACTIVE" });
    const sink = new CompletionSink();
    try {
      recordTeamChain(store, taskId, { status: "PASS", result: "TEAM_CHAIN_COMPLETE", role: "QA", chain_complete: false });
      const result = new TaskCompletionProjection(store, tasks, teams, new Protocol(store, sink)).reconcile(taskId);
      expect(result.reason).toBe("TEAM_NOT_COMPLETE:PLANNED");
      expect(tasks.get(taskId)!.status).toBe("DISPATCHED");
      expect(sink.events.filter((event) => event.type === "COMPLETION")).toHaveLength(0);
    } finally { store.close(); }
  });

  it("does not complete when QA evidence is invalid even if the role row says PASS", () => {
    const { store, tasks, teams, taskId } = setupTeam({ status: "ACTIVE" });
    const sink = new CompletionSink();
    try {
      teams.finish(taskId, 3, "PASS", "QA FAIL: validation rejected", ["QA_FAIL"]);
      recordTeamChain(store, taskId);
      const result = new TaskCompletionProjection(store, tasks, teams, new Protocol(store, sink)).reconcile(taskId);
      expect(result.reason).toBe("GATE_NOT_SATISFIED");
      expect(tasks.get(taskId)!.status).toBe("DISPATCHED");
      expect(store.db.prepare("SELECT count(*) AS count FROM protocol_events WHERE task_id=? AND event_type='COMPLETION'").get(taskId)).toMatchObject({ count: 0 });
    } finally { store.close(); }
  });

  it("completion remains recoverable after an exhausted no-progress run", () => {
    const { store, tasks, teams, taskId } = setupTeam({ status: "ACTIVE" });
    let now = Date.now();
    const budget = new RunBudgetController(store, () => now);
    const sink = new CompletionSink();
    try {
      budget.start(taskId, "p", 1_000, 1);
      now += 10;
      expect(budget.canContinue(taskId)).toBe(false);
      recordTeamChain(store, taskId);
      const result = new TaskCompletionProjection(store, tasks, teams, new Protocol(store, sink)).reconcile(taskId);
      expect(result.reason).toBe("AUTHORITATIVE_COMPLETION");
      expect(tasks.get(taskId)!.status).toBe("COMPLETED");
      expect(store.db.prepare("SELECT count(*) AS count FROM protocol_events WHERE task_id=? AND event_type='COMPLETION'").get(taskId)).toMatchObject({ count: 1 });
    } finally { store.close(); }
  });

  it("restart after durable Completion event but before transition converges lawfully", async () => {
    const first = setupTeam(); const sink = new CompletionSink();
    try {
      await new Protocol(first.store, sink).emit("COMPLETION", first.tasks.get(first.taskId)!, "ORCHESTRATOR", "MAIN", { status: "COMPLETED", chain_complete: true, completion_authority: "TASK_COMPLETION_PROJECTION" });
    } finally { first.store.close(); }
    const reopened = new Store(path.join(first.dir, "test.db"));
    try {
      const tasks = new TaskRepository(reopened); const teams = new TeamRepository(reopened);
      expect(tasks.get(first.taskId)!.status).toBe("DISPATCHED");
      const projection = new TaskCompletionProjection(reopened, tasks, teams, new Protocol(reopened, sink));
      expect(projection.reconcile(first.taskId).reason).toBe("AUTHORITATIVE_COMPLETION");
      expect(tasks.get(first.taskId)!.status).toBe("COMPLETED");
      expect(reopened.db.prepare("SELECT count(*) AS count FROM protocol_events WHERE task_id=? AND event_type='COMPLETION'").get(first.taskId)).toMatchObject({ count: 1 });
    } finally { reopened.close(); const i = dirs.indexOf(first.dir); if (i >= 0) dirs.splice(i, 1); rmSync(first.dir, { recursive: true, force: true }); }
  });
});
