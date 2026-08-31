/**
 * REVIEWER_UNIFIED_EXEC_PIPE_IN_FAILURE regression coverage.
 *
 * A prior bounded certification:
 * lawful Developer validation evidence reached the independent Reviewer, but
 * two separate Reviewer rounds each failed to complete a real read-only
 * Product inspection -- both at the same boundary:
 *
 *   "Failed to create unified exec process: timed out after 15000ms
 *    connecting runner pipe-in"
 *
 * ProcessRunner already treats that stderr shape as a bounded, observable
 * pipe-wedge condition (see spawnAndCollect's isPipeTimeout/pipeRetries):
 * up to 2 respawns, 3s apart, of the exact same RunSpec, before giving up
 * and marking the RunOutput `transportWedgeExhausted`. What the live
 * evidence actually exposed was a downstream gap: normalizeReviewResult
 * (src/review/verdict.ts) never consulted `result.blockedReason`, so a
 * Reviewer that never got to execute at all was folded into the same
 * generic "Required validation evidence is missing" wording used for a
 * Reviewer that ran but left required evidence incomplete -- hiding the
 * real execution-boundary failure from the Owner.
 *
 * These tests exercise the real spawn boundary (not a mocked runner, per
 * the existing tests/processRunner.test.ts convention) for the pipe
 * lifecycle, plus the verdict-normalization fix directly.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessRunner } from "../src/runtime/processRunner.js";
import { Store } from "../src/storage/database.js";
import { normalizeReviewResult } from "../src/review/verdict.js";
import type { AdapterTaskResult } from "../src/domain/types.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRunner(): { runner: ProcessRunner; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reviewer-pipe-"));
  dirs.push(dir);
  const store = new Store(path.join(dir, "test.db"));
  stores.push(store);
  return { runner: new ProcessRunner(store), dir };
}

/**
 * A deterministic stand-in for a unified-exec-backed Reviewer worker: on
 * each invocation it increments a durable counter file, and until the
 * invocation count exceeds `failUntilAttempt` it reproduces the exact live
 * pipe-in-timeout stderr shape and exits non-zero. From `failUntilAttempt`
 * onward it succeeds. `failUntilAttempt: Infinity` never recovers.
 */
function makePipeWedgeFixture(dir: string, failUntilAttempt: number): { script: string; counter: string } {
  const counter = path.join(dir, "attempts.txt");
  writeFileSync(counter, "0");
  const script = path.join(dir, "reviewer-worker.mjs");
  writeFileSync(script, `
    import { readFileSync, writeFileSync } from "node:fs";
    const counterPath = ${JSON.stringify(counter)};
    const failUntil = ${failUntilAttempt === Infinity ? "Infinity" : JSON.stringify(failUntilAttempt)};
    const attempt = Number(readFileSync(counterPath, "utf8")) + 1;
    writeFileSync(counterPath, String(attempt));
    if (attempt <= failUntil) {
      process.stderr.write("Failed to create unified exec process: timed out after 15000ms connecting runner pipe-in\\n");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ type: "message", text: "REVIEW_PASS: inspected Product, no findings" }) + "\\n");
    process.exit(0);
  `);
  return { script, counter };
}

describe("REVIEWER_PIPE_INPUT_SUCCESS", () => {
  it("a Reviewer worker whose pipe connects on the first attempt executes and captures a result with no retry", async () => {
    const { runner, dir } = makeRunner();
    const { script, counter } = makePipeWedgeFixture(dir, 0);
    const output = await runner.run({ agentId: "CODEX", taskId: "t-pipe-success", executable: process.execPath, args: [script], cwd: dir });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("REVIEW_PASS");
    expect(output.transportWedgeExhausted).toBeUndefined();
    expect(readFileSync(counter, "utf8")).toBe("1");
  });
});

describe("REVIEWER_PIPE_STARTUP_RACE_RECOVERED", () => {
  it("a transient pipe-in wedge on the first attempt is recovered by the bounded retry and the Reviewer still executes", async () => {
    const { runner, dir } = makeRunner();
    const { script, counter } = makePipeWedgeFixture(dir, 1); // fails attempt 1, succeeds attempt 2
    const output = await runner.run({ agentId: "CODEX", taskId: "t-pipe-race", executable: process.execPath, args: [script], cwd: dir });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("REVIEW_PASS");
    expect(output.transportWedgeExhausted).toBeUndefined();
    // Recovery is bounded: exactly the attempts actually needed, never more.
    expect(readFileSync(counter, "utf8")).toBe("2");
  }, 15_000);
});

describe("REVIEWER_PIPE_PERMANENT_FAILURE_FAILS_CLOSED", () => {
  it("a pipe that never becomes available exhausts the bounded retry and fails closed, without infinite retry", async () => {
    const { runner, dir } = makeRunner();
    const { script, counter } = makePipeWedgeFixture(dir, Infinity);
    const output = await runner.run({ agentId: "CODEX", taskId: "t-pipe-permanent", executable: process.execPath, args: [script], cwd: dir });
    expect(output.transportWedgeExhausted).toBe(true);
    // Exactly the original attempt plus the 2 bounded retries -- 3 total, never more.
    expect(readFileSync(counter, "utf8")).toBe("3");
  }, 20_000);
});

describe("REVIEWER_PIPE_FAILURE_REASON_PRESERVED (normalizeReviewResult)", () => {
  const base: AdapterTaskResult = { ok: true, output: "", evidence: ["EVIDENCE_1"], exitCode: 0 };

  it("preserves the actual pipe-timeout failure reason instead of the generic missing-evidence wording, even though lawful evidence is attached", () => {
    const result: AdapterTaskResult = {
      ...base, ok: false, exitCode: 1,
      output: "Codex unified-exec runner failed repeatedly (pipe timeout); no Product change or validation was executed.",
      blockedReason: "CODEX_UNIFIED_EXEC_PIPE_TIMEOUT_EXHAUSTED",
      validationEvidence: [{ type: "TEST", command: "npm test", worktree: "C:/ws", branch: "main", timestamp: new Date().toISOString(), summary: "59/59 PASS" } as never],
    };
    const review = normalizeReviewResult(result, ["npm run typecheck", "npm test", "npm run build"]);
    expect(review.verdict).toBe("REVIEW_INDETERMINATE");
    expect(review.findings[0]).toMatch(/CODEX_UNIFIED_EXEC_PIPE_TIMEOUT_EXHAUSTED/);
    expect(review.findings.join(" ")).not.toMatch(/Required validation evidence is missing/);
  });
});

describe("REVIEWER_EVIDENCE_REMAINS_AVAILABLE / REAL_INSPECTION_REQUIRED (normalizeReviewResult, no regression)", () => {
  const base: AdapterTaskResult = { ok: true, output: "", evidence: [], exitCode: 0 };

  it("still reports the generic missing-evidence finding when the Reviewer actually ran but evidence is genuinely absent (no blockedReason)", () => {
    const review = normalizeReviewResult({ ...base, ok: true, output: "Looked around a bit." }, ["npm test"]);
    expect(review.verdict).toBe("REVIEW_INDETERMINATE");
    expect(review.findings[0]).toMatch(/Required validation evidence is missing/);
  });

  it("REVIEW_PASS still works: a real Reviewer execution with a valid PASS verdict and satisfied validation is accepted", () => {
    const review = normalizeReviewResult({ ...base, ok: true, output: "VERDICT: REVIEW_PASS -- npm test passed, no findings." }, ["npm test"]);
    expect(review.verdict).toBe("REVIEW_PASS");
  });

  it("REVISION_REQUIRED still works: a real Product finding still routes to REVIEW_FAIL", () => {
    const review = normalizeReviewResult({ ...base, ok: true, output: "VERDICT: REVISION_REQUIRED -- off-by-one in pagination." }, ["npm test"]);
    expect(review.verdict).toBe("REVIEW_FAIL");
  });
});
