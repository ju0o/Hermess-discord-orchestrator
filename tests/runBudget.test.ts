import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { WorkspaceLocks } from "../src/tasks/locks.js";
import { RunBudgetController } from "../src/runtime/runBudget.js";
import type { AuthorityDecision } from "../src/authority/delegatedAuthority.js";

const dirs: string[] = []; afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "run-budget-")); dirs.push(dir); const store = new Store(path.join(dir, "test.db"));
  const tasks = new TaskRepository(store); tasks.upsertProject({ projectId: "p", name: "p", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  tasks.create({ taskId: "t", projectId: "p", title: "t", goal: "bounded", role: "DEVELOPER", requiredCapabilities: ["coding"], status: "QUEUED", workspace: dir, readContext: {}, fileScope: ["product.txt"], doNot: [], validation: [], owner: "MAIN", evidence: ["product-diff"] });
  let now = Date.parse("2026-08-23T00:00:00.000Z"); const terminated: number[] = [];
  const budget = new RunBudgetController(store, () => now, (pid) => (terminated.push(pid), true));
  return { dir, store, tasks, budget, terminated, setNow: (ms: number) => { now = Date.parse("2026-08-23T00:00:00.000Z") + ms; } };
}
function event(x: ReturnType<typeof setup>, id: string, type: string, payload: unknown, at: string) {
  x.store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").run(id, "t", type, "CODEX", "ASUS", JSON.stringify(payload), at);
}
function process_(x: ReturnType<typeof setup>, id: string, status: string, startedAt: string, lastSeen: string) {
  x.store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,started_at,last_seen,status,log_path)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, "CODEX", "t", 1, 99, x.dir, startedAt, lastSeen, status, path.join(x.dir, `${id}.log`));
}
function setLastSeen(x: ReturnType<typeof setup>, id: string, lastSeen: string) {
  x.store.db.prepare("UPDATE worker_processes SET last_seen=? WHERE process_id=?").run(lastSeen, id);
}
/** Turns the shared scratch workspace into a real git worktree with one committed
 * baseline file, so the Product-diff progress signal observes real, deterministic
 * `git status --short` / `git diff --numstat` output. */
function initRepo(x: ReturnType<typeof setup>): void {
  execFileSync("git", ["init", "-q"], { cwd: x.dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: x.dir });
  execFileSync("git", ["config", "user.name", "Run Budget Test"], { cwd: x.dir });
  writeFileSync(path.join(x.dir, "product.txt"), "baseline\n");
  execFileSync("git", ["add", "."], { cwd: x.dir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: x.dir });
}
function writeProduct(x: ReturnType<typeof setup>, content: string): void {
  writeFileSync(path.join(x.dir, "product.txt"), content);
}
/** Writes a distinct new (untracked) file per step, so `git status --short` picks up
 * a genuinely new entry each time -- unlike repeatedly overwriting one line of an
 * already-modified file, whose `status`/`--numstat` shape does not change further. */
function writeStep(x: ReturnType<typeof setup>, label: string): void {
  writeFileSync(path.join(x.dir, `step-${label}.txt`), `${label}\n`);
}
const ownerAuthority = (approvedBy = "owner-1"): AuthorityDecision => ({ authorityClass: "HUMAN_REQUIRED", approvedBy,
  decisionReason: "Owner authorized a separate bounded continuation run", riskCategory: "BOUNDED_RUN_REARM", decisionTimestamp: "2026-08-23T00:00:01.000Z" });
function rearmRequest(previousRunId: string, requestId = "rearm-1") { return { requestId, taskId: "t", projectId: "p", previousRunId,
  budgetDurationMs: 2000, noProgressBudgetMs: 1000, authority: ownerAuthority(), actor: "OWNER" as const, reason: "Owner requested a new bounded run" }; }

describe("hard run execution budgets", () => {
  it("wall deadline expires", () => { const x = setup(); x.budget.start("t", "p", 1000, 5000); x.setNow(1000); expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "WALL_CLOCK_BUDGET" }); x.store.close(); });
  it("no-progress deadline expires", () => { const x = setup(); x.budget.start("t", "p", 5000, 1000); x.setNow(1000); expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" }); x.store.close(); });
  it("heartbeat alone does not count as progress", () => { const x = setup(); x.budget.start("t", "p", 5000, 1000); x.store.upsertRuntimeState("runtime:heartbeat", { at: "2026-08-23T00:00:00.900Z" }); x.setNow(1000); expect(x.budget.evaluate("t")?.status).toBe("EXHAUSTED"); x.store.close(); });
  it("polling does not count as progress", () => { const x = setup(); x.budget.start("t", "p", 5000, 1000); x.budget.evaluate("t"); x.setNow(1000); expect(x.budget.evaluate("t")?.status).toBe("EXHAUSTED"); x.store.close(); });
  it("identical retry does not reset no-progress", () => { const x = setup(); x.budget.start("t", "p", 5000, 1000); event(x, "r1", "TASK", { retry: 1 }, "2026-08-23T00:00:00.900Z"); x.setNow(1000); expect(x.budget.evaluate("t")?.status).toBe("EXHAUSTED"); x.store.close(); });
  it.each(["worker reassignment", "Review retry"])("%s does not reset wall deadline", () => { const x = setup(); const first = x.budget.start("t", "p", 1000, 5000); x.setNow(500); expect(x.budget.start("t", "p", 1000, 5000).deadlineAt).toBe(first.deadlineAt); x.setNow(1000); expect(x.budget.evaluate("t")?.expiredBy).toBe("WALL_CLOCK_BUDGET"); x.store.close(); });
  it("controller restart recovers original deadline", () => { const x = setup(); const first = x.budget.start("t", "p", 1000, 5000); const restarted = new RunBudgetController(x.store, () => Date.parse("2026-08-23T00:00:00.500Z")); expect(restarted.start("t", "p", 1000, 5000).deadlineAt).toBe(first.deadlineAt); x.store.close(); });
  it("assigns a stable identity to a pre-run-id exhausted record without changing its history", () => { const x = setup(); const old = x.budget.start("t", "p", 1000, 5000); x.setNow(1000); const exhausted = x.budget.evaluate("t")!;
    const { runId: _removed, ...legacy } = exhausted; x.store.upsertRuntimeState("run_budget:t", legacy); const restarted = new RunBudgetController(x.store, () => Date.parse("2026-08-23T00:00:01.100Z")); const migrated = restarted.get("t")!;
    expect(migrated.runId).toMatch(/^legacy-/); expect(migrated).toMatchObject({ startedAt: old.startedAt, deadlineAt: old.deadlineAt, status: "EXHAUSTED", expiredAt: exhausted.expiredAt, expiredBy: exhausted.expiredBy });
    expect(new RunBudgetController(x.store).get("t")?.runId).toBe(migrated.runId); x.store.close(); });
  it.each(["workroom reacquisition", "recovery reopen"])("%s cannot reset deadline", () => { const x = setup(); const first = x.budget.start("t", "p", 1000, 5000); expect(x.budget.start("t", "p", 1000, 5000).startedAt).toBe(first.startedAt); x.store.close(); });
  it("ordinary continuation cannot extend deadline", () => { const x = setup(); x.budget.start("t", "p", 1000, 5000); expect(() => x.budget.start("t", "p", 9000, 5000)).toThrow("RUN_BUDGET_EXTENSION_REQUIRES_HIGHER_AUTHORITY"); x.store.close(); });
  it("preserves Product evidence and history on expiration", () => { const x = setup(); event(x, "old", "RESULT", { evidence: "kept" }, "2026-08-22T23:59:59.000Z"); x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t"); expect(x.tasks.get("t")?.evidence).toEqual(["product-diff"]); expect(x.store.db.prepare("SELECT count(*) n FROM protocol_events WHERE task_id='t'").get()).toMatchObject({ n: 2 }); x.store.close(); });
  it("expiration blocks continuation and records attributable outcome", () => { const x = setup(); x.budget.start("t", "p", 1000, 5000); x.setNow(1000); expect(x.budget.canContinue("t")).toBe(false); expect(x.store.db.prepare("SELECT event_type FROM protocol_events WHERE task_id='t'").get()).toMatchObject({ event_type: "RUN_BUDGET_EXHAUSTED" }); x.store.close(); });
  it("expiration prevents another Review or QA round", () => { const x = setup(); x.budget.start("t", "p", 1000, 5000); x.setNow(1000); expect(x.budget.canContinue("t")).toBe(false); expect(x.budget.canContinue("t")).toBe(false); x.store.close(); });
  it("duplicate expiration is idempotent", () => { const x = setup(); x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t"); x.budget.evaluate("t"); expect(x.store.db.prepare("SELECT count(*) n FROM protocol_events WHERE event_type='RUN_BUDGET_EXHAUSTED'").get()).toMatchObject({ n: 1 }); x.store.close(); });
  it("unrelated Tasks are unaffected", () => { const x = setup(); x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t"); expect(x.budget.canContinue("other")).toBe(true); x.store.close(); });
  it("terminates owned process and releases its lock", () => { const x = setup(); const locks = new WorkspaceLocks(x.store); locks.acquire("t", x.dir, ["product.txt"]); x.store.db.prepare("INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,started_at,last_seen,status,log_path) VALUES(?,?,?,?,?,?,?,?,?,?)").run("p", "CODEX", "t", 1, 42, x.dir, "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z", "RUNNING", path.join(x.dir, "p.log")); x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t"); expect(x.terminated).toEqual([42]); expect(x.store.db.prepare("SELECT count(*) n FROM workspace_locks WHERE task_id='t'").get()).toMatchObject({ n: 0 }); x.store.close(); });

  it("authoritatively creates Run N+1 while preserving exhausted Run N and Product state", () => { const x = setup(); const beforeTask = x.tasks.get("t");
    const old = x.budget.start("t", "p", 1000, 5000); x.setNow(1000); const exhausted = x.budget.evaluate("t")!; x.setNow(1500);
    const next = x.budget.rearm(rearmRequest(old.runId)); expect(next.runId).not.toBe(old.runId); expect(next.startedAt).toBe("2026-08-23T00:00:01.500Z");
    expect(next.deadlineAt).toBe("2026-08-23T00:00:03.500Z"); expect(x.budget.getRun("t", old.runId)).toEqual(exhausted);
    expect(x.budget.getRun("t", old.runId)?.deadlineAt).toBe(old.deadlineAt); expect(x.tasks.get("t")).toEqual(beforeTask);
    expect(x.store.db.prepare("SELECT count(*) n FROM worker_processes WHERE task_id='t'").get()).toMatchObject({ n: 0 });
    expect(x.store.db.prepare("SELECT count(*) n FROM protocol_events WHERE event_type IN ('COMPLETE','VERDICT')").get()).toMatchObject({ n: 0 }); x.store.close(); });

  it.each([
    ["ordinary caller", { ...ownerAuthority(), authorityClass: "AUTO_DELEGATED" }],
    ["retry logic", { ...ownerAuthority(), authorityClass: "MAIN_DECISION" }],
  ] as const)("rejects %s authority", (_label, authority) => { const x = setup(); const old = x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t");
    expect(() => x.budget.rearm({ ...rearmRequest(old.runId), authority })).toThrow("RUN_BUDGET_REARM_REQUIRES_AUTHORITY"); x.store.close(); });

  it("rejects a Worker actor even when it presents an approval object", () => { const x = setup(); const old = x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t");
    expect(() => x.budget.rearm({ ...rearmRequest(old.runId), actor: "CODEX" as never })).toThrow("RUN_BUDGET_REARM_REQUIRES_AUTHORITY"); x.store.close(); });

  it("makes a duplicate request idempotent and fences competing re-arms", () => { const x = setup(); const old = x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t"); x.setNow(1100);
    const first = x.budget.rearm(rearmRequest(old.runId)); expect(x.budget.rearm(rearmRequest(old.runId)).runId).toBe(first.runId);
    expect(() => new RunBudgetController(x.store, () => Date.parse("2026-08-23T00:00:01.100Z")).rearm(rearmRequest(old.runId, "competing"))).toThrow("RUN_BUDGET_REARM_REQUIRES_EXHAUSTED_RUN");
    expect(x.store.db.prepare("SELECT count(*) n FROM protocol_events WHERE event_type='RUN_BUDGET_REARMED'").get()).toMatchObject({ n: 1 }); x.store.close(); });

  it("does not allow an active run to be re-armed", () => { const x = setup(); const active = x.budget.start("t", "p", 1000, 5000);
    expect(() => x.budget.rearm(rearmRequest(active.runId))).toThrow("RUN_BUDGET_REARM_REQUIRES_EXHAUSTED_RUN"); x.store.close(); });

  it("restart recovers N+1, which expires normally, and separately authorized N+2 preserves both ancestors", () => { const x = setup(); const n = x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t"); x.setNow(1100);
    const n1 = x.budget.rearm(rearmRequest(n.runId)); const restarted = new RunBudgetController(x.store, () => Date.parse("2026-08-23T00:00:03.100Z"));
    expect(restarted.get("t")?.runId).toBe(n1.runId); const n1Expired = restarted.evaluate("t")!; expect(n1Expired).toMatchObject({ status: "EXHAUSTED", expiredBy: "WALL_CLOCK_BUDGET" });
    const n2 = restarted.rearm({ ...rearmRequest(n1.runId, "rearm-2"), authority: ownerAuthority("owner-2") }); expect(n2.runId).not.toBe(n1.runId);
    expect(restarted.getRun("t", n.runId)?.status).toBe("EXHAUSTED"); expect(restarted.getRun("t", n1.runId)).toEqual(n1Expired);
    expect(x.store.db.prepare("SELECT count(*) n FROM protocol_events WHERE event_type='RUN_BUDGET_EXHAUSTED'").get()).toMatchObject({ n: 2 }); x.store.close(); });

  it("records complete immutable re-arm provenance", () => { const x = setup(); const old = x.budget.start("t", "p", 1000, 5000); x.setNow(1000); x.budget.evaluate("t"); x.setNow(1200); const next = x.budget.rearm(rearmRequest(old.runId));
    const row = x.store.db.prepare("SELECT sender,payload_json FROM protocol_events WHERE event_type='RUN_BUDGET_REARMED'").get() as { sender: string; payload_json: string }; const payload = JSON.parse(row.payload_json);
    expect(row.sender).toBe("OWNER"); expect(payload).toMatchObject({ task_id: "t", previous_run_id: old.runId, new_run_id: next.runId, actor: "OWNER", reason: "Owner requested a new bounded run",
      requested_wall_budget_ms: 2000, requested_no_progress_budget_ms: 1000, previous_status: "EXHAUSTED", new_started_at: next.startedAt, new_deadline_at: next.deadlineAt, timestamp: next.startedAt,
      authority: { authorityClass: "HUMAN_REQUIRED", approvedBy: "owner-1" } }); x.store.close(); });
});

// V1 DUAL DOGFOOD 02 -- Blocker A: a Worker's own live process is progress
// too, not only durable protocol chatter. Without this, a single long-running
// CLI call between ACK and its terminal Result (any real npm test/build can
// easily exceed a bounded no-progress budget) is fingerprinted as stale from
// the moment it started, so the Task's own eventual completion can lose a
// race against expiry by mere milliseconds even though the Worker never
// stopped making progress.
describe("Run 02 Blocker A -- no-progress budget vs. an actively running Worker", () => {
  it("a live heartbeat resets the no-progress clock even once the process has run longer than the budget", () => {
    const x = setup();
    x.budget.start("t", "p", 10 * 60_000, 180_000);
    process_(x, "proc-1", "RUNNING", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    setLastSeen(x, "proc-1", "2026-08-23T00:02:59.000Z"); // fresh stdout 1s before the naive 180s mark
    x.setNow(200_000); // 20s past the naive PROCESS_START-only deadline
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    x.store.close();
  });

  it("a RUNNING process that has gone genuinely silent still expires no-progress deterministically", () => {
    const x = setup();
    x.budget.start("t", "p", 10 * 60_000, 180_000);
    process_(x, "proc-1", "RUNNING", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:10.000Z"); // one heartbeat, then silence
    x.setNow(200_000); // 190s since the last real heartbeat -- genuinely stalled
    expect(x.budget.evaluate("t")?.status).toBe("EXHAUSTED");
    expect(x.budget.evaluate("t")?.expiredBy).toBe("NO_PROGRESS_BUDGET");
    x.store.close();
  });

  it("only a currently RUNNING process's heartbeat counts -- an EXITED process's stale last_seen cannot itself block expiry", () => {
    const x = setup();
    x.budget.start("t", "p", 10 * 60_000, 180_000);
    process_(x, "proc-1", "EXITED", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:05.000Z");
    x.setNow(200_000);
    expect(x.budget.evaluate("t")?.status).toBe("EXHAUSTED");
    x.store.close();
  });

  it("reproduces the observed Run 02 timing: a Worker heartbeating throughout its run never races the budget, and its terminal Result on exit is recognized as progress", () => {
    const x = setup();
    x.budget.start("t", "p", 35 * 60_000, 180_000);
    process_(x, "proc-1", "RUNNING", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    // The Worker streams output continuously for just over three minutes --
    // exactly the shape that used to trip NO_PROGRESS while genuinely busy.
    setLastSeen(x, "proc-1", "2026-08-23T00:03:08.900Z");
    x.setNow(189_000); // matches the ~189s gap observed between ACK/process start and expiry in Run 02
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    // The process now exits and hands off its terminal Result -- captured as
    // durable evidence exactly as Run 02 showed, ~0.4s after this instant.
    x.store.db.prepare("UPDATE worker_processes SET status='EXITED',exit_code=1,last_seen=? WHERE process_id='proc-1'").run("2026-08-23T00:03:09.300Z");
    event(x, "r1", "RESULT", { ok: false, result: "This command requires approval" }, "2026-08-23T00:03:09.339Z");
    x.setNow(189_400);
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    x.store.close();
  });
});

// Prior bounded retry: Lane B -- see
// run02-dual-dogfood-retry2-status.json) showed a real Developer CLI whose
// stdout/stderr went completely silent for the entire ~10 minute turn (its
// `worker_processes.last_seen` never advanced past the very first byte),
// while it was actively editing real Product files the whole time. A
// stdout/stderr-only heartbeat cannot see that: this section proves the
// Product worktree's own diff is now recognized as Task-bound progress,
// stays deterministically bounded (a static/unchanging diff is not
// progress), and never moves the hard wall-clock deadline.
describe("DDF02 Retry 2 correction -- Product worktree diff progress (Task-bound file changes count even when stdout is silent)", () => {
  it("ACTIVE_PRODUCT_PROGRESS: a real Product file change mid-run refreshes the no-progress window even though stdout/heartbeat never advances", () => {
    const x = setup(); initRepo(x);
    x.budget.start("t", "p", 10 * 60_000, 180_000);
    process_(x, "proc-1", "RUNNING", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z"); // last_seen never updates again -- fully silent stdout
    x.setNow(0);
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); // establishes the diff baseline; must not itself count as progress
    x.setNow(170_000); // 10s before the naive 180s no-progress mark, still no stdout
    writeProduct(x, "the Worker just wrote a real Product change\n"); // genuine, silent-to-stdout file edit
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    x.setNow(170_000 + 179_000); // 179s after the diff was observed -- would have expired long ago without it
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    x.store.close();
  });

  it("MEANINGLESS_HEARTBEAT: a Product diff that already existed and never changes does not manufacture progress on its own", () => {
    const x = setup(); initRepo(x);
    writeProduct(x, "uncommitted change present before the process even starts\n");
    x.budget.start("t", "p", 10 * 60_000, 180_000);
    process_(x, "proc-1", "RUNNING", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z"); // alive, but stdout is silent and the diff never changes again
    x.setNow(0);
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); // baseline capture of the pre-existing diff -- not itself progress
    x.setNow(179_000);
    expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); // still within the window, diff unchanged
    x.setNow(180_000);
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "NO_PROGRESS_BUDGET" }); // process is alive but genuinely made no further progress
    x.store.close();
  });

  it("MULTIPLE_PROGRESS_STEPS: each distinct Product diff change refreshes the window, tracking the latest one", () => {
    const x = setup(); initRepo(x);
    x.budget.start("t", "p", 30 * 60_000, 180_000);
    process_(x, "proc-1", "RUNNING", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    x.setNow(0); x.budget.evaluate("t"); // baseline
    x.setNow(170_000); writeStep(x, "1"); expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    x.setNow(340_000); writeStep(x, "2"); expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); // 170s after change 1 -- only survives because change 1 refreshed the window
    x.setNow(510_000); writeStep(x, "3"); expect(x.budget.evaluate("t")?.status).toBe("ACTIVE");
    x.setNow(510_000 + 179_000); expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); // following the latest (3rd) step
    x.store.close();
  });

  it("HARD_WALL_CLOCK: continuous Product-diff progress cannot extend the run beyond the existing hard wall-clock budget", () => {
    const x = setup(); initRepo(x);
    const started = x.budget.start("t", "p", 300_000, 60_000); // 5min wall clock, 1min no-progress
    process_(x, "proc-1", "RUNNING", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    x.setNow(0); x.budget.evaluate("t");
    for (const [seconds, label] of [[50, "a"], [100, "b"], [150, "c"], [200, "d"], [250, "e"]] as const) {
      x.setNow(seconds * 1000); writeStep(x, label);
      expect(x.budget.evaluate("t")?.status).toBe("ACTIVE"); // never more than 60s since the previous change -- no-progress alone would never fire
    }
    expect(x.budget.get("t")?.deadlineAt).toBe(started.deadlineAt); // the hard deadline itself never moved
    x.setNow(300_000); // the wall-clock mark -- last progress was only 50s ago
    expect(x.budget.evaluate("t")).toMatchObject({ status: "EXHAUSTED", expiredBy: "WALL_CLOCK_BUDGET" });
    x.store.close();
  });
});
