import { describe, expect, it } from "vitest";
import { IMPLEMENT_AND_VALIDATE, READ_ONLY_DISCOVERY, assertExecutionContract, assertProjectionConsistency, effectiveExecutionContract, projectProtectedInvariants } from "../src/contracts/executionContract.js";
import { normalizeReviewResult } from "../src/review/verdict.js";

const result = (output: string, ok = true) => ({ ok, output, evidence: [], exitCode: 0 });

describe("execution contract and review semantics", () => {
  it("preserves explicit IMPLEMENT_AND_VALIDATE", () => {
    expect(effectiveExecutionContract({ goal: "fix build", validation: ["typecheck", "test", "build"], executionContract: IMPLEMENT_AND_VALIDATE } as never)).toEqual(IMPLEMENT_AND_VALIDATE);
    expect(assertExecutionContract(IMPLEMENT_AND_VALIDATE, { goal: "fix build", validation: ["typecheck", "test", "build"] })).toEqual(IMPLEMENT_AND_VALIDATE);
  });
  it("rejects the historical global source block for an editable contract", () => {
    expect(() => assertProjectionConsistency(IMPLEMENT_AND_VALIDATE, ["source modification"])).toThrow("CONTRACT_CONTRADICTION");
  });
  it("projects scoped edit permission with concrete protections", () => {
    const projected = projectProtectedInvariants(IMPLEMENT_AND_VALIDATE, ["source modification", "reset"]);
    expect(projected).not.toContain("source modification");
    expect(projected).toContain("unrelated modification");
    expect(projected).toContain("Auth preservation");
    expect(projected).toContain("Firebase preservation");
    expect(projected).toContain("reset");
  });
  it("fails closed when a mutation-required task has no contract", () => {
    expect(() => assertExecutionContract(undefined, { goal: "implement the fix", validation: ["typecheck", "test", "build"] })).toThrow("EXECUTION_CONTRACT_MISSING");
    expect(() => assertExecutionContract(READ_ONLY_DISCOVERY, { goal: "implement the fix", validation: ["typecheck", "test", "build"] })).toThrow("EXECUTION_CONTRACT_INCOMPATIBLE");
  });
  it("keeps genuine discovery-only fallback", () => {
    expect(assertExecutionContract(undefined, { goal: "inspect and report only", validation: ["read-only discovery"] })).toEqual(READ_ONLY_DISCOVERY);
  });
  it("keeps an explicit read-only contract despite directly negated mutation wording", () => {
    const task = { goal: "Read package.json. Do not modify any file.", validation: ["package facts"], executionContract: READ_ONLY_DISCOVERY } as never;
    expect(assertExecutionContract(READ_ONLY_DISCOVERY, task)).toEqual(READ_ONLY_DISCOVERY);
    expect(effectiveExecutionContract(task)).toEqual(READ_ONLY_DISCOVERY);
  });
  it("defaults a DEVELOPER-role task to IMPLEMENT_AND_VALIDATE even when the goal has no English mutation keyword", () => {
    // A prior bounded run: goal
    // text was entirely Korean ("src/app/community/[id]/page.tsx 신규 생성...") and
    // task.executionContract was unset, so the old keyword-only mutationRequired() regex matched
    // nothing and silently defaulted a real DEVELOPER implementation Task to READ_ONLY_DISCOVERY
    // -- Command Code then refused every write for the whole task with no error surfaced anywhere.
    expect(effectiveExecutionContract({ goal: "src/app/community/[id]/page.tsx 신규 생성", validation: ["npm run typecheck"], role: "DEVELOPER" } as never)).toEqual(IMPLEMENT_AND_VALIDATE);
  });
  it("still defaults a non-DEVELOPER role with no English mutation keyword to READ_ONLY_DISCOVERY", () => {
    expect(effectiveExecutionContract({ goal: "커뮤니티 상세 조사", validation: [], role: "REVIEWER" } as never)).toEqual(READ_ONLY_DISCOVERY);
  });
  it("maps reviewer PASS only with required validation evidence", () => {
    expect(normalizeReviewResult(result("VERDICT: PASS\ntypecheck PASS\ntest PASS\nbuild PASS"), ["typecheck", "test", "build"]).verdict).toBe("REVIEW_PASS");
    const blocked = normalizeReviewResult(result("Status: BLOCKED\nImplementation: not performed\nTypecheck: NOT RUN\nTest: NOT RUN\nBuild: NOT RUN"), ["typecheck", "test", "build"]);
    expect(blocked.verdict).toBe("REVIEW_BLOCKED");
    expect(blocked.validationsRun).toEqual([]);
    expect(normalizeReviewResult(result("CHANGES_REQUIRED: fix this"), ["typecheck"]).verdict).toBe("REVIEW_FAIL");
    expect(normalizeReviewResult(result("VERDICT: PASS\nBLOCKED by missing build"), ["build"]).verdict).toBe("REVIEW_INDETERMINATE");
    expect(normalizeReviewResult(result("VERDICT: PASS"), ["typecheck"]).verdict).toBe("REVIEW_INDETERMINATE");
  });
});
