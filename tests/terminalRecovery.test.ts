import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureExecutionBinding, deterministicGitPreflight, type ValidationEvidence } from "../src/runtime/correction.js";
import { recoverCancelledTask, type TerminalRecoveryRequest } from "../src/runtime/terminalRecovery.js";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { TeamRepository } from "../src/teams/repository.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch {} } });

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "terminal-recovery-")); dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Recovery Test"], { cwd: dir });
  writeFileSync(path.join(dir, "product.txt"), "baseline\n");
  execFileSync("git", ["add", "."], { cwd: dir }); execFileSync("git", ["commit", "-qm", "baseline"], { cwd: dir });
  writeFileSync(path.join(dir, "product.txt"), "preserved product diff\n");
  const store = new Store(path.join(dir, "runtime.db")); const tasks = new TaskRepository(store); const teams = new TeamRepository(store);
  tasks.upsertProject({ projectId: "project", name: "Project", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  const task = tasks.create({ taskId: "recoverable", projectId: "project", title: "recovery", goal: "resume", role: "DEVELOPER", requiredCapabilities: ["coding"], assignedAgent: "CODEX", status: "CANCELLED", workspace: dir, readContext: {}, fileScope: ["product.txt"], doNot: [], validation: ["typecheck", "test", "build"], owner: "MAIN", nextOwner: "MAIN", attempt: 3, result: "SAFE_STOP:NO_PROGRESS_CONTINUATION:ROUTING_BLOCKED", requiredRoles: ["DEVELOPER", "REVIEWER", "QA"], teamMode: "SEQUENTIAL", currentRoleSequence: 1 });
  teams.create(task.taskId, "FEATURE", ["DEVELOPER", "REVIEWER", "QA"]); teams.assign(task.taskId, 1, "CODEX", "developer"); teams.assign(task.taskId, 2, "CLAUDE_CODE", "reviewer"); teams.assign(task.taskId, 3, "COMMAND_CODE", "qa");
  store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").run("review-1", task.taskId, "REVIEW", "CLAUDE_CODE", "MAIN", JSON.stringify({ verdict: "REVISION_REQUIRED", findings: ["resume revision"] }), store.now());
  const binding = captureExecutionBinding(task); const diff = deterministicGitPreflight(dir);
  const validationEvidence: ValidationEvidence[] = (["TYPECHECK", "TEST", "BUILD"] as const).map((type) => ({ task_id: task.taskId, type, command: type, exit_code: 0, status: "PASS", timestamp: store.now(), worktree: dir, branch: binding.branch, base_sha: binding.base_sha, source: "REUSED" }));
  const request = (overrides: Partial<TerminalRecoveryRequest> = {}): TerminalRecoveryRequest => ({ taskId: task.taskId, projectId: "project", expectedBinding: binding, expectedDiff: { status: diff.status, diff_numstat: diff.diff_numstat }, validationEvidence, targetRole: "DEVELOPER", requestedBy: "MAIN", reason: "resume interrupted review chain", ...overrides });
  return { dir, store, tasks, teams, task, binding, diff, request };
}

describe("terminal task recovery", () => {
  it("reopens a recoverable CANCELLED task and preserves an attributable cancellation event", () => {
    const x = setup(); try { const r = recoverCancelledTask(x.store, x.tasks, x.teams, x.request()); expect(r.alreadyRecovered).toBe(false); expect(x.tasks.get("recoverable")?.status).toBe("QUEUED"); expect(x.store.db.prepare("SELECT event_type FROM protocol_events WHERE event_id=?").get(r.recoveryEventId)).toMatchObject({ event_type: "TASK_RECOVERY" }); expect(JSON.parse(String(x.store.db.prepare("SELECT payload_json FROM protocol_events WHERE event_id=?").get(r.recoveryEventId).payload_json))).toMatchObject({ prior_status: "CANCELLED", prior_result: expect.stringContaining("SAFE_STOP") }); } finally { x.store.close(); } });
  it("is idempotent and preserves the first recovery event", () => { const x = setup(); try { const a = recoverCancelledTask(x.store, x.tasks, x.teams, x.request()); const b = recoverCancelledTask(x.store, x.tasks, x.teams, x.request()); expect(b).toMatchObject({ alreadyRecovered: true, recoveryEventId: a.recoveryEventId }); expect(x.store.db.prepare("SELECT count(*) count FROM protocol_events WHERE event_type='TASK_RECOVERY'").get()).toMatchObject({ count: 1 }); } finally { x.store.close(); } });
  it("appends a new recovery after a prior bounded safe-stop without erasing history", () => { const x = setup(); try { const a = recoverCancelledTask(x.store, x.tasks, x.teams, x.request()); x.tasks.transition("recoverable", "CANCELLED", { result: "SAFE_STOP:NO_PROGRESS_CONTINUATION:STALE_INBOUND" }); const b = recoverCancelledTask(x.store, x.tasks, x.teams, x.request()); expect(b.alreadyRecovered).toBe(false); expect(b.recoveryEventId).not.toBe(a.recoveryEventId); expect(x.store.db.prepare("SELECT count(*) count FROM protocol_events WHERE event_type='TASK_RECOVERY'").get()).toMatchObject({ count: 2 }); expect(x.tasks.get("recoverable")?.status).toBe("QUEUED"); } finally { x.store.close(); } });
  it("reopens only a safe-stop FAIL terminal, not an ordinary Product FAIL", () => { const x = setup(); try { x.store.db.prepare("UPDATE tasks SET status='FAIL',result=? WHERE task_id='recoverable'").run("SAFE_STOP:NO_PROGRESS_CONTINUATION:PROCESS_LOST"); expect(recoverCancelledTask(x.store, x.tasks, x.teams, x.request()).task.status).toBe("QUEUED"); } finally { x.store.close(); } });
  it("reopens a routing-exhaustion safe-stop so fallback pool churn cannot strand the Task", () => { const x = setup(); try { x.store.db.prepare("UPDATE tasks SET status='FAIL',result=? WHERE task_id='recoverable'").run("SAFE_STOP:ROUTING_NO_ELIGIBLE_AGENT: CLAUDE_CODE=RECOVERY_EXCLUDED_WORKER,CODEX=RECOVERY_EXCLUDED_WORKER"); expect(recoverCancelledTask(x.store, x.tasks, x.teams, x.request()).task.status).toBe("QUEUED"); } finally { x.store.close(); } });
  it.each(["worktree", "branch", "base_sha"] as const)("rejects wrong %s binding", (field) => { const x = setup(); try { const expected = { ...x.binding, [field]: field === "worktree" ? x.dir + "-wrong" : "wrong" }; expect(() => recoverCancelledTask(x.store, x.tasks, x.teams, x.request({ expectedBinding: expected }))).toThrow(/EXECUTION_BINDING_MISMATCH/); } finally { x.store.close(); } });
  it("rejects material Product diff drift", () => { const x = setup(); try { expect(() => recoverCancelledTask(x.store, x.tasks, x.teams, x.request({ expectedDiff: { status: x.diff.status, diff_numstat: "999\t999\tproduct.txt" } }))).toThrow("RECOVERY_PRODUCT_DIFF_DRIFT"); } finally { x.store.close(); } });
  it("rejects evidence attributed to another task", () => { const x = setup(); try { expect(() => recoverCancelledTask(x.store, x.tasks, x.teams, x.request({ validationEvidence: x.request().validationEvidence.map((e) => ({ ...e, task_id: "other" })) }))).toThrow(/RECOVERY_VALIDATION_EVIDENCE_MISSING/); } finally { x.store.close(); } });
  it("rejects an active conflicting Worker", () => { const x = setup(); try { x.store.db.prepare("INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,started_at,last_seen,status,log_path) VALUES(?,?,?,?,?,?,?,?,?,?)").run("p", "CODEX", "recoverable", 1, 1, x.dir, x.store.now(), x.store.now(), "RUNNING", path.join(x.dir, "p.log")); expect(() => recoverCancelledTask(x.store, x.tasks, x.teams, x.request())).toThrow("RECOVERY_ACTIVE_WORKER_CONFLICT"); } finally { x.store.close(); } });
  it("rejects non-recoverable terminal reasons", () => { const x = setup(); try { x.store.db.prepare("UPDATE tasks SET result='OWNER_CANCELLED: explicit stop' WHERE task_id='recoverable'").run(); expect(() => recoverCancelledTask(x.store, x.tasks, x.teams, x.request())).toThrow("RECOVERY_TERMINAL_REASON_NOT_RECOVERABLE"); } finally { x.store.close(); } });
  it("rejects skipping the required Review boundary", () => { const x = setup(); try { expect(() => recoverCancelledTask(x.store, x.tasks, x.teams, x.request({ targetRole: "QA" }))).toThrow("RECOVERY_QA_REQUIRES_REVIEW_PASS"); } finally { x.store.close(); } });
  it("rejects recovery of a non-CANCELLED or accepted terminal task", () => { const x = setup(); try { x.store.db.prepare("UPDATE tasks SET status='PASS' WHERE task_id='recoverable'").run(); expect(() => recoverCancelledTask(x.store, x.tasks, x.teams, x.request())).toThrow("TERMINAL_RECOVERY_REQUIRES_CANCELLED"); } finally { x.store.close(); } });
  it("converges the recovered role to the normal QUEUED boundary", () => { const x = setup(); try { recoverCancelledTask(x.store, x.tasks, x.teams, x.request()); expect(x.tasks.get("recoverable")).toMatchObject({ status: "QUEUED", role: "DEVELOPER", currentRoleSequence: 1, assignedAgent: "CODEX" }); expect(x.teams.role("recoverable", 1)).toMatchObject({ status: "ASSIGNED", assignedAgent: "CODEX" }); } finally { x.store.close(); } });
});
