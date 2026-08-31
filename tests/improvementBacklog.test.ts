import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { WorkerFriction } from "../src/office/workerFriction.js";
import { ImprovementBacklog, renderBacklog } from "../src/office/improvementBacklog.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("ImprovementBacklog", () => {
  it("does not immediately implement anything -- recompute() only ranks and persists candidates", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-backlog-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db"));
    const friction = new WorkerFriction(store); const backlog = new ImprovementBacklog(store);
    friction.record("t-1", "CODEX", { hasFriction: true, type: "DISCORD_UX_FRICTION", severity: "HIGH", problem: "보고서가 너무 김", impact: "가독성 저하", suggestion: "요약 우선" });
    friction.record("t-2", "OPENCODE", { hasFriction: true, type: "DISCORD_UX_FRICTION", severity: "HIGH", problem: "보고서가 너무 김", impact: "가독성 저하", suggestion: "요약 우선" });
    friction.record("t-3", "CLAUDE_CODE", { hasFriction: true, type: "REVIEW_FRICTION", severity: "LOW", problem: "가끔 리뷰 지연", impact: "약간 지연", suggestion: "없음" });
    const entries = backlog.recompute(friction.recent({ hasFrictionOnly: true }));
    // Repeated identical friction ("보고서가 너무 김" x2) must be counted, not deduplicated away.
    const repeated = entries.find((entry) => entry.title === "보고서가 너무 김");
    expect(repeated?.frequency).toBe(2);
    expect(entries.every((entry) => entry.status === "OPEN")).toBe(true); // never auto-marks DONE/IN_PROGRESS
    expect(entries[0]!.rankScore).toBeGreaterThanOrEqual(entries[entries.length - 1]!.rankScore); // sorted descending
    store.close();
  });

  it("recompute() is idempotent per fingerprint (upsert, not duplicate rows)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-backlog-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db"));
    const friction = new WorkerFriction(store); const backlog = new ImprovementBacklog(store);
    friction.record("t-1", "CODEX", { hasFriction: true, type: "RUNTIME_FRICTION", severity: "MEDIUM", problem: "재시작이 느림", impact: "복구 지연", suggestion: "캐시 개선" });
    backlog.recompute(friction.recent({ hasFrictionOnly: true }));
    backlog.recompute(friction.recent({ hasFrictionOnly: true }));
    expect(store.db.prepare("SELECT COUNT(*) AS c FROM improvement_backlog").get()).toEqual({ c: 1 });
    store.close();
  });

  it("renderBacklog() lists top() entries in a human-readable format", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-backlog-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db"));
    const friction = new WorkerFriction(store); const backlog = new ImprovementBacklog(store);
    friction.record("t-1", "CODEX", { hasFriction: true, type: "CONTEXT_FRICTION", severity: "CRITICAL", problem: "컨텍스트 유실", impact: "재작업 필요", suggestion: "체크포인트 강화" });
    backlog.recompute(friction.recent({ hasFrictionOnly: true }));
    const rendered = renderBacklog(backlog.top());
    expect(rendered).toContain("컨텍스트 유실");
    expect(renderBacklog([])).toBe("현재 등록된 Improvement Backlog 항목이 없습니다.");
    store.close();
  });
});
