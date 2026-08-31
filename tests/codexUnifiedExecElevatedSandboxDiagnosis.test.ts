/**
 * CODEX_UNIFIED_EXEC_ELEVATED_SANDBOX_PROVISIONING regression coverage.
 *
 * A prior bounded certification:
 * both the initial Review and the re-review reached
 * CODEX_UNIFIED_EXEC_PIPE_TIMEOUT_EXHAUSTED after exhausting ProcessRunner's
 * bounded pipe-wedge retry (see reviewerPipeExecution.test.ts, which already
 * covers that retry boundary and the a2ec7dc double-close-race fix).
 *
 * Tracing one failed live execution past that boundary this time -- against
 * the real Codex binary in an isolated workspace, not a mocked fixture --
 * showed ProcessRunner's own spawn/pipe lifecycle was never the problem: the
 * outer runner process and its stdio pipes started and connected correctly
 * on every attempt, with `--sandbox read-only` and `--sandbox workspace-write`
 * failing identically. The wedge is inside Codex's own closed-source Windows
 * unified-exec runner, provisioning its own restricted/elevated sandbox
 * helper over its own internal named pipe, which consistently exceeded
 * Codex's hardcoded 15000ms budget in this environment -- `codex doctor`
 * names the cause as missing Microsoft Defender exclusions for Codex's
 * helper binaries, compounded by this host's `~/.codex/config.toml`
 * selecting the elevated Windows sandbox backend. Respawning the whole
 * outer process (what the existing bounded retry does) cannot recover this,
 * because a fresh process reproduces the identical internal timeout.
 *
 * That means the previous pipe correction (a2ec7dc) is a real, still-correct
 * fix for a *different* failure -- a double-handler-attach race in
 * ProcessRunner's own respawn wiring -- and does not, and structurally
 * cannot, cover this one. There is no ProcessRunner/adapter code change that
 * restores real execution here without either weakening the Reviewer's OS
 * sandbox boundary (an operator security decision, deliberately not made by
 * this change) or a host-level fix (Defender exclusions / `windows.sandbox`
 * policy) outside this repository. What these tests lock in is the fully
 * safe half of that: fail-closed classification is unchanged, and the
 * surfaced diagnosis is actionable instead of a bare technical string.
 */
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../src/agents/codex/CodexAdapter.js";
import type { RunOutput } from "../src/runtime/processRunner.js";
import { normalizeReviewResult } from "../src/review/verdict.js";
import { normalizeDeveloperResult } from "../src/review/verdict.js";

describe("CODEX_UNIFIED_EXEC_ELEVATED_SANDBOX_PROVISIONING diagnosis", () => {
  const adapter = new CodexAdapter();
  const wedgedOutput: RunOutput = { stdout: "", stderr: "", exitCode: 0, processId: "p1", logPath: "log.txt", transportWedgeExhausted: true };

  it("still fails closed with the exact prior blockedReason (no classification change)", () => {
    const result = adapter.parseResult(wedgedOutput);
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("CODEX_UNIFIED_EXEC_PIPE_TIMEOUT_EXHAUSTED");
  });

  it("now names the actual cause and the remediation path instead of a bare technical string", () => {
    const result = adapter.parseResult(wedgedOutput);
    expect(result.output).toMatch(/codex doctor/i);
    expect(result.output).toMatch(/Defender/i);
    expect(result.output).not.toMatch(/^Codex unified-exec runner failed repeatedly \(pipe timeout\); no Product change or validation was executed\.$/);
  });

  it("REVIEW_INDETERMINATE still preserves the enriched reason instead of generic missing-evidence wording", () => {
    const result = adapter.parseResult(wedgedOutput);
    const review = normalizeReviewResult({ ...result, evidence: result.evidence ?? [] }, ["npm test"]);
    expect(review.verdict).toBe("REVIEW_INDETERMINATE");
    expect(review.findings[0]).toMatch(/CODEX_UNIFIED_EXEC_PIPE_TIMEOUT_EXHAUSTED/);
    expect(review.findings.join(" ")).not.toMatch(/Required validation evidence is missing/);
  });

  it("DEVELOPER_BLOCKED still preserves the enriched reason when Codex is the assigned Developer", () => {
    const result = adapter.parseResult(wedgedOutput);
    const developer = normalizeDeveloperResult(result);
    expect(developer.verdict).toBe("DEVELOPER_BLOCKED");
    expect(developer.ok).toBe(false);
  });

  it("a genuine transport success is unaffected: no diagnosis text, no blockedReason", () => {
    const healthy: RunOutput = { stdout: JSON.stringify({ type: "message", text: "REVIEW_PASS: inspected Product, no findings" }), stderr: "", exitCode: 0, processId: "p2", logPath: "log.txt" };
    const result = adapter.parseResult(healthy);
    expect(result.ok).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(result.output).not.toMatch(/codex doctor/i);
  });
});
