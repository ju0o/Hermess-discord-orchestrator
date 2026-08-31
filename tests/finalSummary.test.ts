import { describe, expect, it } from "vitest";
import { renderFinalSummary } from "../src/office/finalSummary.js";
import type { TaskRecord } from "../src/domain/types.js";

const task: TaskRecord = {
  taskId: "t-1", projectId: "p", title: "Fix login bug", goal: "Fix and test the login flow", role: "DEVELOPER",
  requiredCapabilities: ["coding"], status: "REVIEWING", workspace: "C:\\ws", readContext: {}, fileScope: [],
  doNot: [], validation: [], owner: "MAIN", attempt: 1, createdAt: new Date().toISOString(), evidence: [],
};

describe("renderFinalSummary", () => {
  it("always includes all six required Korean sections, with 없음 when Owner action is none", () => {
    const summary = renderFinalSummary({ task, outcome: { ok: true, output: "Fixed the auth token refresh bug." }, friction: [] });
    for (const heading of ["무엇을 했나", "왜 했나", "결과", "문제/주의점", "Worker가 불편했던 점", "주엉쓰가 할 일"]) {
      expect(summary).toContain(heading);
    }
    expect(summary).toContain("**주엉쓰가 할 일**\n없음");
  });

  it("surfaces an explicit Owner action when one is required", () => {
    const summary = renderFinalSummary({ task, outcome: { ok: true, output: "Done." }, friction: [], ownerActionRequired: "새 API 키를 발급해 주세요." });
    expect(summary).toContain("새 API 키를 발급해 주세요.");
  });

  it("marks a failed outcome distinctly and surfaces the failure as the 문제/주의점 section", () => {
    const summary = renderFinalSummary({ task, outcome: { ok: false, output: "Build failed: TS2322" }, friction: [] });
    expect(summary).toContain("⚠️ 문제 발생");
    expect(summary).toContain("Build failed: TS2322");
  });
});
