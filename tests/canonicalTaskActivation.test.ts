import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter } from "../src/agents/adapter.js";
import type { AgentId } from "../src/domain/types.js";
import { Store } from "../src/storage/database.js";
import { AgentRegistry } from "../src/registry/agentRegistry.js";
import { RoleRegistry } from "../src/registry/roleRegistry.js";
import { WorkspaceLocks } from "../src/tasks/locks.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { TaskAdmission } from "../src/tasks/taskAdmission.js";
import { AgentRouter } from "../src/routing/agentRouter.js";
import { TeamRepository } from "../src/teams/repository.js";
import { TeamPlanner } from "../src/teams/planner.js";
import { SequentialTeamScheduler } from "../src/teams/scheduler.js";
import { Dispatcher } from "../src/tasks/dispatcher.js";
import { Protocol, type ProtocolEvent, type ProtocolSink } from "../src/tasks/protocol.js";
import { WorkroomManager } from "../src/discord/workrooms/manager.js";
import type { DiscordThreadSnapshot, DiscordWorkroomPort } from "../src/discord/workrooms/types.js";
import { MemoryRouter } from "../src/context/memoryRouter.js";
import { ContextResolver } from "../src/context/resolver.js";
import { NullDiscordContextSource } from "../src/context/discord.js";
import { LocalTaskControl } from "../src/control/localTaskControl.js";
import { submitTask } from "../src/control/certClient.js";

const roots: string[] = []; const controls: LocalTaskControl[] = []; const stores: Store[] = [];
afterEach(async () => { await Promise.all(controls.splice(0).map((control) => control.close())); stores.splice(0).forEach((store) => store.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

class Port implements DiscordWorkroomPort {
  async getThread(): Promise<DiscordThreadSnapshot | undefined> { return undefined; }
  async createPublicThread(parentId: string, name: string): Promise<DiscordThreadSnapshot> { return { id: "thread", parentId, name, archived: false, canView: true, canSend: true }; }
  async setThreadArchived(_id: string, archived: boolean): Promise<DiscordThreadSnapshot> { return { id: "thread", parentId: "parent", name: "thread", archived, canView: true, canSend: true }; }
  async sendBootstrap(): Promise<string> { return "bootstrap"; } async sendControlMessage(): Promise<string> { return "control"; } async pinMessage(): Promise<void> {}
}
class Sink implements ProtocolSink { events: ProtocolEvent[] = []; async publish(event: ProtocolEvent): Promise<string> { this.events.push(event); return `event-${this.events.length}`; } }

function fixture(withDeveloper = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), "canonical-activation-")); roots.push(root); const store = new Store(path.join(root, "runtime.db")); stores.push(store);
  const tasks = new TaskRepository(store), agents = new AgentRegistry(store), roles = new RoleRegistry(store), locks = new WorkspaceLocks(store); roles.seed();
  if (withDeveloper) agents.upsert({ agentId: "CODEX", displayName: "CODEX", backendType: "TEST", status: "AVAILABLE", capabilities: ["coding"], health: "ONLINE" });
  const teams = new TeamRepository(store); const router = new AgentRouter(agents, roles, locks, (id) => withDeveloper && id === "CODEX"); const planner = new TeamPlanner(tasks, teams, router);
  const sink = new Sink(); const protocol = new Protocol(store, sink); const context = new ContextResolver(tasks, new NullDiscordContextSource(), new MemoryRouter(store)); const workrooms = new WorkroomManager(store, tasks, new Port());
  const scheduler = new SequentialTeamScheduler(tasks, teams, planner, agents, new Map<AgentId, AgentAdapter>(), locks, context, protocol, workrooms);
  const dispatcher = new Dispatcher(tasks, agents, new Map(), locks, context, protocol, workrooms, scheduler, undefined as never);
  const admission = new TaskAdmission(tasks); const activations: Array<{ taskId: string; initialState: string | undefined }> = [];
  admission.attachActivation(async (taskId) => { activations.push({ taskId, initialState: tasks.get(taskId)?.status }); return dispatcher.dispatchTask(taskId); });
  return { root, store, tasks, sink, admission, activations };
}

describe("canonical post-admission activation", () => {
  it("CONTROL_ADMITTED_TASK_AUTO_ASSIGNMENT_STARTS without control assignment authority", async () => {
    const x = fixture(); const control = new LocalTaskControl(x.admission, { host: "127.0.0.1", port: 0, token: "fixture-token" }); controls.push(control); await control.start();
    const result = await submitTask({ endpoint: `http://127.0.0.1:${control.address()!.port}`, token: "fixture-token", task: { taskId: "CONTROL-A", projectId: "p", workspace: x.root, title: "harmless" } });
    expect(result).toMatchObject({ accepted: true, task_id: "CONTROL-A" }); expect(x.activations).toEqual([{ taskId: "CONTROL-A", initialState: "QUEUED" }]);
    expect(x.tasks.get("CONTROL-A")).toMatchObject({ status: "DISPATCHED", assignedAgent: "CODEX" }); expect(x.sink.events.filter((event) => event.type === "TASK")).toHaveLength(1);
    const source = readFileSync(path.resolve(import.meta.dirname, "../src/control/localTaskControl.ts"), "utf8"); expect(source).not.toMatch(/Dispatcher|assignedAgent|transition\(|dispatchTask|\.dispatch\(/);
  });

  it("DISCORD_ADMITTED_TASK_AUTO_ASSIGNMENT_STILL_STARTS and both paths share one boundary", async () => {
    const x = fixture(); await x.admission.submit({ taskId: "DISCORD-A", projectId: "p", workspace: x.root, title: "Discord" }, { owner: "discord-owner", defaultGoal: "wire" });
    expect(x.activations).toEqual([{ taskId: "DISCORD-A", initialState: "QUEUED" }]); expect(x.tasks.get("DISCORD-A")).toMatchObject({ status: "DISPATCHED", assignedAgent: "CODEX" });
  });

  it("ONE_ACCEPTED_TASK_TRIGGERS_ONE_ACTIVATION and rejected admission triggers none", async () => {
    const x = fixture(); await x.admission.submit({ taskId: "ONCE", projectId: "p", workspace: x.root }, { owner: "owner", defaultGoal: "wire" });
    await expect(x.admission.submit({ taskId: "REJECTED", projectId: "p" }, { owner: "owner", defaultGoal: "wire" })).rejects.toThrow("workspace is required"); expect(x.activations.map((item) => item.taskId)).toEqual(["ONCE"]); expect(x.sink.events.filter((event) => event.type === "TASK")).toHaveLength(1);
  });

  it("AUTO_ASSIGNMENT_FAILURE_FAILS_CLOSED when no Developer is eligible", async () => {
    const x = fixture(false); await x.admission.submit({ taskId: "NO-DEVELOPER", projectId: "p", workspace: x.root }, { owner: "owner", defaultGoal: "wire" });
    expect(x.activations).toEqual([{ taskId: "NO-DEVELOPER", initialState: "QUEUED" }]); expect(x.tasks.get("NO-DEVELOPER")?.status).toBe("QUEUED"); expect(x.tasks.get("NO-DEVELOPER")?.assignedAgent).toBeFalsy(); expect(x.sink.events).toHaveLength(0);
  });

  it("activation exceptions leave the admitted Task QUEUED without fabricated progress", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "activation-failure-")); roots.push(root); const store = new Store(path.join(root, "runtime.db")); stores.push(store); const tasks = new TaskRepository(store); const admission = new TaskAdmission(tasks);
    admission.attachActivation(async () => { throw new Error("activation unavailable"); }); const task = await admission.submit({ taskId: "FAIL-CLOSED", projectId: "p", workspace: root }, { owner: "owner", defaultGoal: "wire" }); expect(task.status).toBe("QUEUED"); expect(tasks.get(task.taskId)?.status).toBe("QUEUED");
  });

  it("CONTINUE_TASK reuses the existing Dispatcher path for a watchdog WAITING_MAIN task", async () => {
    const x = fixture(); x.tasks.upsertProject({ projectId: "p", name: "p", workspace: x.root, ssotPaths: [], status: "ACTIVE" });
    x.tasks.create({ taskId: "CONTINUE-DISPATCH", projectId: "p", title: "continue", goal: "observe", role: "DEVELOPER", requiredCapabilities: ["coding"], status: "WAITING_MAIN", workspace: x.root,
      readContext: {}, fileScope: [], doNot: [], validation: [], owner: "owner", result: "Watchdog detected no worker heartbeat for 1800000ms." });
    const result = await x.admission.continueTask("CONTINUE-DISPATCH");
    expect(result).toMatchObject({ continued: true, task: { taskId: "CONTINUE-DISPATCH", status: "DISPATCHED", assignedAgent: "CODEX" } });
    expect(x.activations).toEqual([{ taskId: "CONTINUE-DISPATCH", initialState: "QUEUED" }]); expect(x.sink.events.filter((event) => event.type === "TASK")).toHaveLength(1);
  });
});
