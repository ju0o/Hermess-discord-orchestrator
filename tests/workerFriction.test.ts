import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { WorkerFriction, renderFriction } from "../src/office/workerFriction.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("WorkerFriction", () => {
  it("treats 'no friction' as a valid, durable record", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-friction-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const friction = new WorkerFriction(store);
    const record = friction.record("t-1", "CODEX", { hasFriction: false });
    expect(record.hasFriction).toBe(false);
    expect(record.problem).toBeUndefined();
    expect(friction.forTask("t-1")).toHaveLength(1);
    store.close();
  });

  it("persists structured friction with type/severity/problem/impact/suggestion", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-friction-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const friction = new WorkerFriction(store);
    const record = friction.record("t-2", "OPENCODE", {
      hasFriction: true, type: "DISCORD_UX_FRICTION", severity: "HIGH",
      problem: "메시지가 너무 길어서 잘림", impact: "Owner가 결과를 이해하기 어려움", suggestion: "핵심 요약을 먼저 보여주기",
    });
    expect(record.hasFriction).toBe(true);
    expect(record.severity).toBe("HIGH");
    expect(record.suggestion).toContain("핵심 요약");
    store.close();
  });

  it("renders 없음 when a Task has no friction, and a bulleted list otherwise", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-friction-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const friction = new WorkerFriction(store);
    friction.record("t-3", "CODEX", { hasFriction: false });
    expect(renderFriction(friction.forTask("t-3"))).toBe("없음");
    friction.record("t-4", "CODEX", { hasFriction: true, type: "REVIEW_FRICTION", severity: "MEDIUM", problem: "리뷰가 느림", impact: "지연", suggestion: "병렬화" });
    expect(renderFriction(friction.forTask("t-4"))).toContain("리뷰가 느림");
    store.close();
  });
});
