import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Role } from "../src/domain/types.js";
import { RunBudgetController } from "../src/runtime/runBudget.js";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const iso = (ms: number) => new Date(Date.parse("2026-08-24T00:00:00.000Z") + ms).toISOString();

function setup(role: Role = "REVIEWER", validation: string[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "read-only-progress-")); dirs.push(dir);
  const store = new Store(path.join(dir, "state.db")); const tasks = new TaskRepository(store);
  tasks.upsertProject({ projectId: "p", name: "p", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  const create = (taskId: string, taskRole: Role, taskValidation: string[] = validation) => tasks.create({ taskId, projectId: "p", title: taskId, goal: "inspect",
    role: taskRole, requiredCapabilities: ["review"], assignedAgent: "CODEX", status: "RUNNING", workspace: dir,
    readContext: {}, fileScope: ["src/**"], doNot: ["Do not modify Product files"], validation: taskValidation, owner: "MAIN" });
  create("t", role);
  let now = 0; const budget = new RunBudgetController(store, () => Date.parse("2026-08-24T00:00:00.000Z") + now, () => true);
  const process = (taskId = "t", processId = `proc-${taskId}`) => {
    const logPath = path.join(dir, `${processId}.log`);
    const attempt = tasks.get(taskId)!.attempt;
    store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,started_at,last_seen,status,log_path)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(processId, "CODEX", taskId, attempt, 99, dir, iso(0), iso(0), "RUNNING", logPath);
    return logPath;
  };
  const activity = (logPath: string, at: number, tool: string, input: Record<string, unknown>, callID = `call-${at}`) => {
    appendFileSync(logPath, `[${iso(at)}] stdout: ${JSON.stringify({ type: "tool_use", timestamp: at, part: { type: "tool", tool, callID, state: { status: "completed", input, output: "ignored" } } })}\n`);
  };
  return { store, tasks, budget, create, process, activity, setNow: (ms: number) => { now = ms; } };
}

describe("V1 read-only Role progress signal", () => {
  it("REVIEWER_REAL_ACTIVITY: distinct Task-bound read and validation actions advance no-progress", () => {
    const x = setup(); const log = x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.activity(log, 170_000, "read", { filePath: "src/a.ts" }); x.setNow(170_000); expect(x.budget.evaluate("t")?.lastProgressAt).toBe(iso(170_000));
    x.activity(log, 340_000, "bash", { command: "git diff --check" }); x.setNow(340_000); expect(x.budget.evaluate("t")?.lastProgressAt).toBe(iso(340_000));
    x.setNow(519_999); expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); x.store.close();
  });

  it("SYNTHETIC_PROOF: action B near the boundary remains lawful, then idle time expires normally", () => {
    const x = setup(); const log = x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.activity(log, 10_000, "read", { filePath: "src/a.ts" }); x.setNow(10_000); x.budget.evaluate("t");
    x.activity(log, 179_000, "bash", { command: "git diff --check" }); x.setNow(180_000);
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    x.setNow(359_000); expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" }); x.store.close();
  });

  it("REVIEWER_IDLE: process-alive and last_seen alone do not prevent expiry", () => {
    const x = setup(); x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.store.db.prepare("UPDATE worker_processes SET last_seen=? WHERE task_id='t'").run(iso(179_999));
    x.setNow(180_000); expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" }); x.store.close();
  });

  it("REVIEWER_REPEATED_NOISE: replayed semantic action with new IDs cannot refresh again", () => {
    const x = setup(); const log = x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.activity(log, 100_000, "read", { filePath: "src/a.ts" }, "first"); x.setNow(100_000); x.budget.evaluate("t");
    x.activity(log, 250_000, "read", { filePath: "src/a.ts" }, "replayed-with-new-provider-id");
    x.store.db.prepare("UPDATE worker_processes SET last_seen=? WHERE task_id='t'").run(iso(250_000));
    x.setNow(280_000); expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" }); x.store.close();
  });

  it("REVIEWER_HARD_WALL: continuous distinct activity never moves the wall deadline", () => {
    const x = setup(); const log = x.process(); const started = x.budget.start("t", "p", 300_000, 60_000);
    for (const at of [50_000, 100_000, 150_000, 200_000, 250_000]) { x.activity(log, at, "read", { filePath: `src/${at}.ts` }); x.setNow(at); expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); }
    expect(x.budget.get("t")?.deadlineAt).toBe(started.deadlineAt); x.setNow(300_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "WALL_CLOCK_BUDGET" }); x.store.close();
  });

  it("QA_REAL_ACTIVITY: distinct QA commands advance no-progress without changing PASS semantics", () => {
    const x = setup("QA"); const log = x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.activity(log, 170_000, "bash", { command: "npm test" }); x.setNow(170_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "ACTIVE", lastProgressAt: iso(170_000) });
    expect(x.tasks.get("t")?.status).toBe("RUNNING"); x.store.close();
  });

  it("QA_IDLE: idle QA still expires", () => {
    const x = setup("QA"); x.process(); x.budget.start("t", "p", 900_000, 180_000); x.setNow(180_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" }); x.store.close();
  });

  it("CROSS_TASK_ISOLATION: Task A activity cannot refresh Task B", () => {
    const x = setup(); x.create("task-b", "REVIEWER"); const logA = x.process("t", "proc-a"); x.process("task-b", "proc-b");
    x.budget.start("t", "p", 900_000, 180_000); x.budget.start("task-b", "p", 900_000, 180_000);
    x.activity(logA, 170_000, "read", { filePath: "src/a.ts" }); x.setNow(180_000);
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    expect(x.budget.evaluate("task-b")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" }); x.store.close();
  });
});

// PD01 bookmarks-saved live failure (2026-08-26): a DEVELOPER Worker was
// actively running `npm run build` (typecheck/test PASS, build PASS after
// ~51 real minutes, 415 pages) with no further Product edits (a pure
// validation-only pass) and no forwarded stdout for the whole build, so
// PROCESS_HEARTBEAT went stale and PRODUCT_DIFF never fired -- Runtime
// exhausted NO_PROGRESS_BUDGET mid-build. See runBudget.ts `validationInFlight`.
describe("PD01 long-running validation progress signal", () => {
  it("CASE_A live failure shape: a Task-declared validation command dispatched by a DEVELOPER stays eligible through a silent run far past noProgressBudgetMs, then a genuine RESULT still lands as progress", () => {
    const x = setup("DEVELOPER", ["npm run typecheck", "npm test", "npm run build"]);
    const log = x.process(); x.budget.start("t", "p", 6_000_000, 180_000);
    x.activity(log, 10_000, "bash", { command: "npm run typecheck" });
    x.activity(log, 20_000, "bash", { command: "npm test" });
    x.activity(log, 30_000, "bash", { command: "npm run build" });
    // No further stdout/stderr and no Product worktree change for well over
    // 20x the no-progress budget -- exactly the observed 51-minute silent
    // build -- yet still comfortably inside the wall-clock budget.
    const silentUntil = 30_000 + 4_000_000;
    x.setNow(silentUntil);
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    // The build finally finishes and the durable RESULT lands -- recognized
    // as fresh progress in its own right, same as any other run.
    x.store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("result-1", "t", "RESULT", "CODEX", "MAIN", JSON.stringify({ status: "IMPLEMENTATION-COMPLETE" }), iso(silentUntil + 1_000));
    x.setNow(silentUntil + 1_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "ACTIVE", lastProgressAt: iso(silentUntil + 1_000) });
    x.store.close();
  });

  it("CASE_A_BOUNDED: the grace never lifts the hard wall-clock deadline -- a validation command in flight still cannot outlive WALL_CLOCK_BUDGET", () => {
    const x = setup("DEVELOPER", ["npm run build"]);
    const log = x.process(); x.budget.start("t", "p", 300_000, 60_000);
    x.activity(log, 10_000, "bash", { command: "npm run build" });
    x.setNow(300_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "WALL_CLOCK_BUDGET" });
    x.store.close();
  });

  it("CASE_B hung worker: a RUNNING DEVELOPER process that never dispatches any declared validation command still expires on schedule", () => {
    const x = setup("DEVELOPER", ["npm run build"]);
    x.process(); x.budget.start("t", "p", 900_000, 180_000);
    // last_seen frozen at process spawn -- no stdout, no tool activity at all.
    x.setNow(180_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" });
    x.store.close();
  });

  it("CASE_B_UNRELATED_ACTIVITY: real but unrelated tool activity (not a declared validation command) does not borrow the grace", () => {
    const x = setup("DEVELOPER", ["npm run build"]);
    const log = x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.activity(log, 10_000, "read", { filePath: "src/a.ts" });
    x.setNow(10_000); x.budget.evaluate("t");
    x.setNow(10_000 + 180_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" });
    x.store.close();
  });

  it("CASE_D polling/sleep: repeated identical, undeclared commands cannot manufacture indefinite eligibility", () => {
    const x = setup("DEVELOPER", ["npm run build"]);
    const log = x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.activity(log, 10_000, "bash", { command: "git status --short" }, "poll-1"); x.setNow(10_000); x.budget.evaluate("t");
    x.activity(log, 190_000, "bash", { command: "git status --short" }, "poll-2"); x.setNow(190_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" });
    x.store.close();
  });

  it("VALIDATION_COMPLETES_AND_MOVES_ON: once a distinct, non-validation activity supersedes the last validation dispatch, the grace no longer applies on its own", () => {
    const x = setup("DEVELOPER", ["npm run build"]);
    const log = x.process(); x.budget.start("t", "p", 900_000, 180_000);
    x.activity(log, 10_000, "bash", { command: "npm run build" }); x.setNow(10_000); x.budget.evaluate("t");
    x.activity(log, 20_000, "read", { filePath: "src/a.ts" }); x.setNow(20_000); x.budget.evaluate("t");
    x.setNow(20_000 + 180_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" });
    x.store.close();
  });
});
