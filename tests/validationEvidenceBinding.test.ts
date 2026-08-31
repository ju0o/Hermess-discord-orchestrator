import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaseCliAdapter } from "../src/agents/baseCliAdapter.js";
import type { AdapterExecutionOptions } from "../src/agents/adapter.js";
import type { AdapterTaskResult, ContextPackage, HealthResult } from "../src/domain/types.js";
import { captureProductDigest, evidenceMatchesExecution, type ValidationEvidence } from "../src/runtime/correction.js";
import type { ProcessRunner, RunOutput, RunSpec } from "../src/runtime/processRunner.js";
import { canCompleteTeam, normalizeQaResult, normalizeReviewResult } from "../src/review/verdict.js";

class Runner {
  calls: RunSpec[] = [];
  async run(spec: RunSpec): Promise<RunOutput> { this.calls.push(spec); const n = this.calls.length; return { stdout: n === 1 ? "implemented" : "structured check", stderr: "", exitCode: 0, processId: `exec-${n}`, logPath: `log-${n}` }; }
  async probe(): Promise<RunOutput> { throw new Error("unused"); }
  cancelTask() { return true; }
}
class Adapter extends BaseCliAdapter {
  readonly id = "CODEX" as const; readonly name = "test"; readonly capabilities = ["coding"] as const; protected readonly executable = "worker"; protected readonly providerId = "test";
  protected versionArgs() { return []; } protected authArgs() { return []; }
  protected classifyAuth(): HealthResult { return { status: "ONLINE", detail: "ok" }; }
  protected buildStart(_c: ContextPackage, _o: AdapterExecutionOptions) { return { args: [] }; }
  protected buildResume(_c: ContextPackage, _s: string, _o: AdapterExecutionOptions) { return { args: [] }; }
  protected parseResult(o: RunOutput): AdapterTaskResult { return { ok: true, output: o.stdout, evidence: [], exitCode: o.exitCode }; }
}

describe("VALIDATION_EVIDENCE_BINDING", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  function workspace() { const d = mkdtempSync(path.join(os.tmpdir(), "validation-binding-")); dirs.push(d); execFileSync("git", ["init", "-q"], { cwd: d }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: d }); execFileSync("git", ["config", "user.name", "Test"], { cwd: d }); writeFileSync(path.join(d, "product.txt"), "v1"); execFileSync("git", ["add", "."], { cwd: d }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: d }); return d; }
  function context(d: string): ContextPackage { return { task: { taskId: "T", projectId: "P", title: "T", goal: "implement", role: "DEVELOPER", requiredCapabilities: [], status: "RUNNING", workspace: d, readContext: {}, fileScope: [], doNot: [], validation: ["npm test"], owner: "MAIN", attempt: 2, createdAt: new Date().toISOString(), evidence: [] }, projectSsot: [], discord: [], memory: [], git: {}, files: [], priority: ["FILESYSTEM_GIT", "PROJECT_SSOT", "TASK_STATE", "DISCORD", "MEMORY"] }; }

  it("REAL_VALIDATION_BOUND and REVIEWER_CONSUMES_VALID_EVIDENCE", async () => {
    const d = workspace(), runner = new Runner(); const result = await new Adapter(runner as unknown as ProcessRunner).startTask(context(d));
    expect(runner.calls.map((c) => c.executable)).toEqual(["worker", "npm"]); expect(result.validationEvidence).toHaveLength(1);
    const item = result.validationEvidence![0]!; expect(evidenceMatchesExecution(item, { taskId: "T", attempt: 2, workerId: "CODEX", role: "DEVELOPER", worktree: d })).toBe(true);
    expect(normalizeReviewResult({ ...result, output: "VERDICT: REVIEW_PASS" }, ["npm test"]).verdict).toBe("REVIEW_PASS");
  });

  it("PROSE_ONLY_REJECTED, FOREIGN_TASK_REJECTED, FOREIGN_ATTEMPT_REJECTED, and FAILED_VALIDATION_REJECTED", () => {
    const d = workspace(); const base: ValidationEvidence = { task_id: "T", attempt: 2, worker_id: "CODEX", role: "DEVELOPER", type: "TEST", command: "npm test", exit_code: 0, status: "PASS", timestamp: new Date().toISOString(), worktree: d, branch: "master", product_digest: captureProductDigest(d), source: "EXECUTED", source_execution_id: "e", source_process: "e", source_log: "l" };
    const expected = { taskId: "T", attempt: 2, workerId: "CODEX" as const, role: "DEVELOPER" as const, worktree: d };
    expect(normalizeReviewResult({ ok: true, output: "tests passed", evidence: [], exitCode: 0 }, ["npm test"]).verdict).toBe("REVIEW_INDETERMINATE");
    expect(evidenceMatchesExecution({ ...base, task_id: "FOREIGN" }, expected)).toBe(false); expect(evidenceMatchesExecution({ ...base, attempt: 1 }, expected)).toBe(false);
    expect(evidenceMatchesExecution({ ...base, status: "FAIL", exit_code: 1 }, expected)).toBe(false);
  });

  it("STALE_PRODUCT_STATE_REJECTED, REVISION_INVALIDATION, and RECOVERY_REVALIDATION", async () => {
    const d = workspace(), runner = new Runner(); const adapter = new Adapter(runner as unknown as ProcessRunner); const old = (await adapter.startTask(context(d))).validationEvidence![0]!;
    writeFileSync(path.join(d, "product.txt"), "v2"); const expected = { taskId: "T", attempt: 2, workerId: "CODEX" as const, role: "DEVELOPER" as const, worktree: d };
    expect(evidenceMatchesExecution(old, expected)).toBe(false); expect(normalizeReviewResult({ ok: true, output: "VERDICT: REVIEW_PASS", evidence: [], validationEvidence: [old], exitCode: 0 }, ["npm test"]).verdict).toBe("REVIEW_INDETERMINATE");
    const fresh = (await adapter.startTask(context(d))).validationEvidence![0]!; expect(evidenceMatchesExecution(fresh, expected)).toBe(true);
  });

  it("QA_COMPATIBILITY and COMPLETION_COMPATIBILITY", () => {
    expect(normalizeQaResult({ ok: true, output: "QA_RESULT: PASS npm test", evidence: [], exitCode: 0 }, ["npm test"]).verdict).toBe("QA_PASS");
    const task = { executionContract: { mode: "IMPLEMENT_AND_VALIDATE" }, validation: ["npm test"] } as never;
    const roles = [{ role: "DEVELOPER", status: "PASS", assignedAgent: "CODEX", result: "npm test", evidence: [] }, { role: "REVIEWER", status: "PASS", assignedAgent: "CLAUDE_CODE", result: "REVIEW_PASS", evidence: [] }, { role: "QA", status: "PASS", assignedAgent: "COMMAND_CODE", result: "QA_PASS", evidence: [] }] as never;
    expect(canCompleteTeam(task, roles)).toBe(true);
  });
});
