import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { OwnerInbox } from "../src/office/ownerInbox.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("owner inbox", () => {
  it("persists an owner decision while allowing unrelated work to continue", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-owner-inbox-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const inbox = new OwnerInbox(store);
    const item = inbox.create({
      type: "OWNER_DECISION_REQUIRED", sourceAgent: "ASUS", taskId: "office-task-1", question: "허용 범위를 결정해 주세요.",
      context: "한 branch만 추가 권한이 필요합니다.", evidence: ["incident:1"], recommendation: "현재 workspace만 허용",
      alternatives: ["전체 repository 허용"], defaultSafeAction: "현재 branch를 WAITING_OWNER로 유지", blocks: ["permission branch"],
      continues: ["worker review", "health monitoring"], urgency: "HIGH",
    });
    expect(item.status).toBe("OPEN");
    expect(item.continues).toContain("worker review");
    expect(inbox.update(item.decisionId, "NEEDS_CLARIFICATION", "범위를 더 구체화해 주세요.")?.status).toBe("NEEDS_CLARIFICATION");
    expect(inbox.update(item.decisionId, "RESOLVED", "현재 workspace만 허용")?.answer).toBe("현재 workspace만 허용");
    expect(inbox.list({ status: "RESOLVED" })).toHaveLength(1);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    store.close();
  });
});
