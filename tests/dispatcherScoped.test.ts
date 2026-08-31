import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents/adapter.js";
import type { AgentId, TaskRecord } from "../src/domain/types.js";
import { Store } from "../src/storage/database.js";
import { AgentRegistry } from "../src/registry/agentRegistry.js";
import { RoleRegistry } from "../src/registry/roleRegistry.js";
import { WorkspaceLocks } from "../src/tasks/locks.js";
import { TaskRepository } from "../src/tasks/repository.js";
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

const dirs: string[] = []; afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

class FakeWorkroomPort implements DiscordWorkroomPort {
  threads = new Map<string, DiscordThreadSnapshot>(); creates = 0;
  async getThread(id: string) { return this.threads.get(id); }
  async createPublicThread(parentId: string, name: string) { this.creates++; const value = { id: `thread-${this.creates}`, parentId, name, archived: false, canView: true, canSend: true }; this.threads.set(value.id, value); return value; }
  async setThreadArchived(id: string, archived: boolean) { const value = { ...this.threads.get(id)!, archived }; this.threads.set(id, value); return value; }
  async sendBootstrap() { return `brief-${++this.creates}`; } async sendControlMessage() { return `msg-${++this.creates}`; } async pinMessage() {}
}
class CapturingSink implements ProtocolSink {
  events: ProtocolEvent[] = [];
  async publish(event: ProtocolEvent) { this.events.push(event); return `event-${this.events.length}`; }
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dispatcher-scoped-")); dirs.push(dir); const store = new Store(path.join(dir, "test.db"));
  const tasks = new TaskRepository(store), agents = new AgentRegistry(store), roles = new RoleRegistry(store), locks = new WorkspaceLocks(store); roles.seed();
  const port = new FakeWorkroomPort(); const workrooms = new WorkroomManager(store, tasks, port); const teams = new TeamRepository(store);
  const connected = new Set<AgentId>(["CODEX"]); const router = new AgentRouter(agents, roles, locks, (id) => connected.has(id)); const planner = new TeamPlanner(tasks, teams, router);
  const sink = new CapturingSink(); const protocol = new Protocol(store, sink); const context = new ContextResolver(tasks, new NullDiscordContextSource(), new MemoryRouter(store));
  const scheduler = new SequentialTeamScheduler(tasks, teams, planner, agents, new Map<AgentId, AgentAdapter>(), locks, context, protocol, workrooms);
  tasks.upsertProject({ projectId: "p-scoped", name: "Scoped Project", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  agents.upsert({ agentId: "CODEX", displayName: "CODEX", backendType: "TEST", status: "AVAILABLE", capabilities: ["coding"], health: "ONLINE" });
  const dispatcher = new Dispatcher(tasks, agents, new Map<AgentId, AgentAdapter>(), locks, context, protocol, workrooms, scheduler, undefined as never);
  return { dir, store, tasks, agents, locks, sink, dispatcher };
}

function makeTask(x: ReturnType<typeof setup>, taskId: string, patch: Partial<TaskRecord> = {}) {
  return x.tasks.create({ taskId, projectId: "p-scoped", title: `Task ${taskId}`, goal: "Do the scoped thing", role: "DEVELOPER",
    requiredCapabilities: ["coding"], status: "QUEUED", workspace: x.dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN", ...patch });
}

describe("Dispatcher.dispatchTask() -- project/task-scoped dispatch (no global sweep)", () => {
  it("dispatches exactly the named Task and returns true", async () => {
    const x = setup();
    makeTask(x, "T-scoped-1");
    const dispatched = await x.dispatcher.dispatchTask("T-scoped-1");
    expect(dispatched).toBe(true);
    expect(x.tasks.get("T-scoped-1")?.status).toBe("DISPATCHED");
    x.store.close();
  });

  it("never touches any other QUEUED Task, unlike tick()", async () => {
    const x = setup();
    makeTask(x, "T-scoped-1");
    makeTask(x, "T-unrelated-1"); makeTask(x, "T-unrelated-2"); makeTask(x, "T-unrelated-3");
    const dispatched = await x.dispatcher.dispatchTask("T-scoped-1");
    expect(dispatched).toBe(true);
    expect(x.tasks.get("T-scoped-1")?.status).toBe("DISPATCHED");
    // The whole point: three other real, runnable, QUEUED Tasks exist and dispatchTask() must
    // leave every one of them exactly as it found them.
    expect(x.tasks.get("T-unrelated-1")?.status).toBe("QUEUED");
    expect(x.tasks.get("T-unrelated-2")?.status).toBe("QUEUED");
    expect(x.tasks.get("T-unrelated-3")?.status).toBe("QUEUED");
    x.store.close();
  });

  it("is a safe no-op for a missing Task id", async () => {
    const x = setup();
    expect(await x.dispatcher.dispatchTask("does-not-exist")).toBe(false);
    x.store.close();
  });

  it("is a safe no-op for a Task that is not QUEUED", async () => {
    const x = setup();
    makeTask(x, "T-scoped-1");
    await x.dispatcher.dispatchTask("T-scoped-1"); // -> DISPATCHED
    const secondCall = await x.dispatcher.dispatchTask("T-scoped-1");
    expect(secondCall).toBe(false); // already DISPATCHED, not QUEUED -- not re-dispatched
    x.store.close();
  });

  it("is a safe no-op for an execution-held Task", async () => {
    const x = setup();
    makeTask(x, "T-scoped-1", { executionHold: true });
    expect(await x.dispatcher.dispatchTask("T-scoped-1")).toBe(false);
    expect(x.tasks.get("T-scoped-1")?.status).toBe("QUEUED");
    x.store.close();
  });

  it("respects Owner PAUSE the same way tick() does", async () => {
    const x = setup();
    makeTask(x, "T-scoped-1");
    const paused = new Dispatcher(x.tasks, x.agents, new Map(), x.locks, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never, () => true);
    expect(await paused.dispatchTask("T-scoped-1")).toBe(false);
    expect(x.tasks.get("T-scoped-1")?.status).toBe("QUEUED");
    x.store.close();
  });
});
