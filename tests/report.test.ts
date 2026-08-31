import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { WorkerFriction } from "../src/office/workerFriction.js";
import { HumanFeedback } from "../src/office/humanFeedback.js";
import { gatherSprintReport, renderSprintReport } from "../src/office/report.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("renderSprintReport", () => {
  it("always renders the fixed 8-section Korean format, even with nothing to report", () => {
    const report = renderSprintReport({
      doneToday: [], inProgress: [], failuresAndRecovery: [], companySelfImprovement: [],
      workerFriction: [], learningCandidates: [], ownerDecisionsRequired: [], nextAutomaticProgress: [],
    });
    expect(report).toContain("🏢 Coding Company Report");
    for (const heading of ["오늘 한 일", "현재 진행 중", "실패/복구", "회사 자체 개선", "Worker 불편", "학습 후보", "Owner 결정 필요", "다음 자동 진행"]) {
      expect(report).toContain(heading);
    }
  });
});

describe("gatherSprintReport", () => {
  it("pulls done/in-progress tasks, friction, and learning candidates from durable state (read-only)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-report-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db"));
    const tasks = new TaskRepository(store); const friction = new WorkerFriction(store); const feedback = new HumanFeedback(store);
    tasks.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
    tasks.create({ taskId: "t-done", projectId: "p", title: "Recovery fix", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"], status: "QUEUED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN" });
    tasks.transition("t-done", "DISPATCHED"); tasks.transition("t-done", "CLAIMED"); tasks.transition("t-done", "RUNNING"); tasks.transition("t-done", "WAITING_RESULT"); tasks.transition("t-done", "PASS");
    tasks.create({ taskId: "t-running", projectId: "p", title: "Office wiring", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"], status: "QUEUED", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN" });
    tasks.transition("t-running", "DISPATCHED"); tasks.transition("t-running", "CLAIMED"); tasks.transition("t-running", "RUNNING");
    friction.record("t-done", "CODEX", { hasFriction: true, type: "RUNTIME_FRICTION", severity: "MEDIUM", problem: "복구가 느림", impact: "지연", suggestion: "캐시" });
    feedback.capture({ rawText: "학습해. 앞으로는 짧게 요약해줘.", sourceChannelId: "owner-inbox", sourceMessageId: "m-1", sourceAuthorId: "owner" });
    const sinceIso = new Date(Date.now() - 3_600_000).toISOString();
    const report = gatherSprintReport(store, sinceIso);
    expect(report.doneToday.some((line) => line.includes("Recovery fix"))).toBe(true);
    expect(report.inProgress.some((line) => line.includes("Office wiring"))).toBe(true);
    expect(report.workerFriction.some((line) => line.includes("복구가 느림"))).toBe(true);
    expect(report.learningCandidates.some((line) => line.includes("짧게 요약"))).toBe(true);
    store.close();
  });
});
