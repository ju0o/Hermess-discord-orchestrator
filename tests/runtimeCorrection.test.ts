import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { normalizeReviewResult } from "../src/review/verdict.js";
import { boundedRedispatchAllowed, convergeDurableFailure, deterministicGitPreflight, recordHeartbeat, recordJuTellReceipt, renderHeartbeat, reuseValidationEvidence, verifyExecutionBinding, type ValidationEvidence } from "../src/runtime/correction.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function evidence(type: ValidationEvidence["type"], command: string): ValidationEvidence { return { type, command, exit_code: 0, status: "PASS", timestamp: "2026-08-23T00:00:00.000Z", worktree: "C:\\worktree", branch: "feature/bookmarks", base_sha: "base-1" }; }
function db(): Store { const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-correction-")); dirs.push(dir); return new Store(path.join(dir, "runtime.db")); }

describe("bounded runtime correction", () => {
  it("rejects wrong task/worktree/branch/base binding before launch", () => {
    const result = verifyExecutionBinding({ task_id: "T1", worktree: "C:\\worktree", branch: "feature/bookmarks", base_sha: "base-1" }, { task_id: "T2", worktree: "C:\\other", branch: "main", base_sha: "base-2" });
    expect(result).toEqual({ ok: false, reason: "EXECUTION_BINDING_MISMATCH:task_id,worktree,branch,base_sha" });
  });

  it("reuses canonical evidence and preserves it through review normalization", () => {
    const validationEvidence = [evidence("TYPECHECK", "npm run typecheck"), evidence("TEST", "npm test"), evidence("BUILD", "npm run build")];
    const reused = reuseValidationEvidence(validationEvidence, ["TYPECHECK", "TEST", "BUILD"], "C:\\worktree", "feature/bookmarks", "base-1");
    expect(reused.every((item) => item.source === "REUSED")).toBe(true);
    const normalized = normalizeReviewResult({ ok: true, output: "VERDICT: REVIEW_PASS", evidence: ["canonical evidence"], validationEvidence: reused, exitCode: 0 }, ["npm run typecheck", "npm test", "npm run build"]);
    expect(normalized.verdict).toBe("REVIEW_PASS");
    expect(normalized.validationsRun).toEqual(["npm run typecheck", "npm test", "npm run build"]);
  });

  it("does not replace a full actionable finding with truncated reasoning", () => {
    const finding = `REVISION_REQUIRED: ${"actionable detail ".repeat(80)}`;
    const normalized = normalizeReviewResult({ ok: false, output: finding, evidence: [], exitCode: 1 }, []);
    expect(normalized.findings[0]).toBe(finding.trim());
    expect(normalized.findings[0]!.length).toBeGreaterThan(500);
  });

  it("converges QA failure durably and bounds process-less retries", () => {
    const store = db(); const tasks = new TaskRepository(store); tasks.upsertProject({ projectId: "P", name: "P", workspace: "C:\\worktree", ssotPaths: [], status: "ACTIVE" });
    tasks.create({ taskId: "QA-FAIL", projectId: "P", title: "qa", goal: "qa", role: "QA", requiredCapabilities: ["testing"], status: "RUNNING", workspace: "C:\\worktree", readContext: {}, fileScope: [], doNot: [], validation: [], owner: "ASUS", requiredRoles: ["QA"], teamMode: "SEQUENTIAL", currentRoleSequence: 1 });
    store.db.prepare("INSERT INTO task_roles(task_id,role,sequence,status,revision_round,created_at,evidence_json) VALUES('QA-FAIL','QA',1,'ACTIVE',0,?, '[]')").run(store.now());
    store.db.prepare("INSERT INTO task_teams(task_id,task_type,mode,status,current_sequence,created_at,updated_at) VALUES('QA-FAIL','QA_ONLY','SEQUENTIAL','ACTIVE',1,?,?)").run(store.now(), store.now());
    convergeDurableFailure(store, "QA-FAIL", "QA_FAIL: test failure");
    expect(store.db.prepare("SELECT status,result FROM tasks WHERE task_id='QA-FAIL'").get()).toMatchObject({ status: "FAIL", result: "QA_FAIL: test failure" });
    expect(store.db.prepare("SELECT status FROM task_roles WHERE task_id='QA-FAIL'").get()).toEqual({ status: "BLOCKED" });
    expect(boundedRedispatchAllowed(2, 3)).toBe(true); expect(boundedRedispatchAllowed(3, 3)).toBe(false); store.close();
  });

  it("reports owner-visible heartbeat fields and auditable JuTell mode", () => {
    const store = db(); const input = { runStartedAt: "2026-08-23T00:00:00.000Z", wallLimitSeconds: 3600, phase: "REVIEWING", activeWorker: "CODEX" as const, workerRole: "REVIEWER" as const, latestProgress: "canonical evidence reused", blocker: "none", ownerActionRequired: false, nextTransition: "REVIEW_PASS", nextTimeoutSeconds: 300, productDiff: "Bookmarks Part 2", jutellMode: "MANUAL_OBSERVER" as const };
    const text = renderHeartbeat(input, new Date("2026-08-23T00:01:00.000Z")); expect(text).toContain("OWNER_ACTION_REQUIRED=no"); expect(text).toContain("JUTELL_MODE=MANUAL_OBSERVER"); expect(text).toContain("ACTIVE_WORKER=CODEX");
    recordHeartbeat(store, input); recordJuTellReceipt(store, { invocation_id: "j-1", timestamp: store.now(), input_ref: "artifact://input", output_ref: "artifact://output", mode: "MCP" });
    expect(JSON.parse((store.db.prepare("SELECT value_json FROM runtime_state WHERE key='jutell:invocation:j-1'").get() as { value_json: string }).value_json)).toMatchObject({ mode: "MCP", invocation_id: "j-1" }); store.close();
  });

  it("emits deterministic Git hygiene evidence without modifying the worktree", () => {
    const before = verifyExecutionBinding({ task_id: "T", worktree: "C:\\worktree", branch: "b", base_sha: "h" }, { task_id: "T", worktree: "C:\\worktree", branch: "b", base_sha: "h" });
    expect(before.ok).toBe(true);
    const preflight = deterministicGitPreflight(process.cwd());
    expect(Object.keys(preflight)).toEqual(["status", "diff_stat", "diff_numstat", "eol", "ignored_untracked"]);
    expect(preflight.eol).toContain("i/");
  });
});
