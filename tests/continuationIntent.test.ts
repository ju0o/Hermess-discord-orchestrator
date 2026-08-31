import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { RunBudgetController } from "../src/runtime/runBudget.js";
import { continuationDispatchPayload, continuationIntentForDispatch, recordContinuationIntent } from "../src/runtime/continuationIntent.js";
import type { AuthorityDecision } from "../src/authority/delegatedAuthority.js";
import type { ValidationEvidence } from "../src/runtime/correction.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const authority: AuthorityDecision = { authorityClass: "HUMAN_REQUIRED", approvedBy: "owner", decisionReason: "bounded evidence closure",
  riskCategory: "BOUNDED_RUN_REARM", decisionTimestamp: "2026-08-23T00:00:01.000Z" };

function setup(taskId = "T1") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "continuation-intent-")); dirs.push(dir);
  const store = new Store(path.join(dir, "state.db")); const tasks = new TaskRepository(store);
  tasks.upsertProject({ projectId: "P", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  tasks.create({ taskId, projectId: "P", title: "feature X", goal: "implement feature X", role: "DEVELOPER", requiredCapabilities: ["coding"],
    status: "RUNNING", workspace: dir, readContext: {}, fileScope: ["src"], doNot: [], validation: [], owner: "ASUS",
    requiredRoles: ["DEVELOPER", "REVIEWER", "QA"], teamMode: "SEQUENTIAL" });
  const now = store.now();
  store.db.prepare("INSERT INTO task_roles(task_id,role,sequence,assigned_agent,status,revision_round,created_at,evidence_json) VALUES(?,?,?,?,?,?,?,?)")
    .run(taskId, "DEVELOPER", 1, "CODEX", "ACTIVE", 15, now, "[]");
  return { dir, store, tasks };
}

function evidence(taskId = "T1"): ValidationEvidence[] { return [{ task_id: taskId, type: "TEST", command: "npm test", exit_code: 0,
  status: "PASS", timestamp: "2026-08-22T23:00:00.000Z", worktree: "C:\\fixture", branch: "task/x", base_sha: "abc", source: "REUSED" }]; }

function rearm(x: ReturnType<typeof setup>, requestId = "R1") {
  let now = Date.parse("2026-08-23T00:00:00.000Z"); const budget = new RunBudgetController(x.store, () => now, () => true);
  const old = budget.start("T1", "P", 1000, 5000); now += 1000; budget.evaluate("T1"); now += 100;
  const next = budget.rearm({ requestId, taskId: "T1", projectId: "P", previousRunId: old.runId, budgetDurationMs: 5000,
    noProgressBudgetMs: 2000, authority, actor: "OWNER", reason: "evidence-only closure", continuationIntent: { role: "DEVELOPER",
      revisionRound: 15, instruction: "evidence-only RESULT; do not modify Product", evidenceReferences: evidence() } });
  return { budget, old, next };
}

describe("durable current continuation intent", () => {
  it("keeps a fresh Task on its original Product goal", () => { const x = setup(); try {
    expect(continuationDispatchPayload(x.tasks.get("T1")!.goal)).toMatchObject({ goal: "implement feature X", original_goal: "implement feature X", current_action: "implement feature X" });
  } finally { x.store.close(); } });

  it("binds authoritative current action, original background, round, and existing evidence to the re-armed run", () => { const x = setup(); try {
    const { budget, next } = rearm(x); const intent = budget.continuation("T1", "DEVELOPER", 15)!; const payload = continuationDispatchPayload(x.tasks.get("T1")!.goal, intent);
    expect(intent).toMatchObject({ taskId: "T1", runId: next.runId, role: "DEVELOPER", revisionRound: 15, instruction: "evidence-only RESULT; do not modify Product", authoritySource: "OWNER" });
    expect(intent.evidenceReferences).toEqual(evidence());
    expect(payload).toMatchObject({ goal: "evidence-only RESULT; do not modify Product", original_goal: "implement feature X",
      current_action: "evidence-only RESULT; do not modify Product", current_action_authoritative: true });
    expect(payload.goal).not.toBe(payload.original_goal);
  } finally { x.store.close(); } });

  it("survives Store/controller restart, re-arm lookup, and Worker reassignment without mutation", () => { const x = setup(); const { next } = rearm(x); x.store.close();
    const restartedStore = new Store(path.join(x.dir, "state.db")); try { const restarted = new RunBudgetController(restartedStore);
      const before = restarted.continuation("T1", "DEVELOPER", 15)!; expect(before.runId).toBe(next.runId);
      restartedStore.db.prepare("UPDATE task_roles SET assigned_agent='OPENCODE' WHERE task_id='T1' AND sequence=1").run();
      expect(restarted.continuation("T1", "DEVELOPER", 15)).toEqual(before);
    } finally { restartedStore.close(); } });

  it("is task-isolated and rejects stale older role/round/run boundaries", () => { const a = setup(); const { budget, old, next } = rearm(a); try {
    expect(budget.continuation("OTHER", "DEVELOPER", 15)).toBeUndefined();
    expect(budget.continuation("T1", "DEVELOPER", 14)).toBeUndefined();
    expect(continuationIntentForDispatch(a.store, "T1", old.runId, "DEVELOPER", 15)).toBeUndefined();
    expect(continuationIntentForDispatch(a.store, "T1", next.runId, "REVIEWER", 15)).toBeUndefined();
  } finally { a.store.close(); } });

  it("is idempotent for identical authority input and immutable on conflicting replay", () => { const x = setup(); try {
    const first = recordContinuationIntent(x.store, { taskId: "T1", runId: "run", intent: { role: "DEVELOPER", revisionRound: 15,
      instruction: "evidence-only RESULT; do not modify Product", evidenceReferences: evidence() }, authoritySource: "OWNER", authority });
    const duplicate = recordContinuationIntent(x.store, { taskId: "T1", runId: "run", intent: { role: "DEVELOPER", revisionRound: 15,
      instruction: first.instruction, evidenceReferences: evidence() }, authoritySource: "OWNER", authority });
    expect(duplicate.intentId).toBe(first.intentId);
    expect(() => recordContinuationIntent(x.store, { taskId: "T1", runId: "run", intent: { role: "DEVELOPER", revisionRound: 15,
      instruction: "implement feature X" }, authoritySource: "OWNER", authority })).toThrow("CONTINUATION_INTENT_IMMUTABLE_CONFLICT");
    expect(() => recordContinuationIntent(x.store, { taskId: "T1", runId: "worker", intent: { role: "DEVELOPER", revisionRound: 15,
      instruction: "rewrite" }, authoritySource: "CODEX", authority })).toThrow("CONTINUATION_INTENT_AUTHORITY_REQUIRED");
  } finally { x.store.close(); } });

  it.each(["REVIEWER", "QA"] as const)("supports bounded %s continuation without changing role authority", (role) => { const x = setup(); try {
    const intent = recordContinuationIntent(x.store, { taskId: "T1", runId: "review-run", intent: { role, revisionRound: 2,
      instruction: `${role} inspect existing evidence`, evidenceReferences: evidence() }, authoritySource: "RUNTIME", authority: { ...authority, authorityClass: "MAIN_DECISION" } });
    expect(continuationIntentForDispatch(x.store, "T1", "review-run", role, 2)).toEqual(intent);
    expect(intent.role).toBe(role);
  } finally { x.store.close(); } });
});
