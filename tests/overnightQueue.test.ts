import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { OvernightOfficeQueue } from "../src/office/overnightQueue.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("overnight office queue", () => {
  it("persists deduplicated worker observations without creating a task", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-office-queue-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const queue = new OvernightOfficeQueue(store);
    const input = {
      eventType: "CAPACITY_EVENT" as const, source: "CODEX", summary: "Codex CLI unavailable",
      evidence: ["health=CLI_NOT_FOUND"], suspectedOwner: "CODEX", severity: "MEDIUM" as const,
      recommendedNextStep: "Use another available worker for the bounded branch.", canContinueOtherWork: true,
      fingerprint: "capacity:codex:cli-not-found",
    };
    const first = queue.record(input); const second = queue.record(input);
    expect(first.eventId).toBe(second.eventId);
    expect(queue.list({ status: "OPEN" })).toHaveLength(1);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    expect(queue.updateStatus(first.eventId, "RESOLVED")?.status).toBe("RESOLVED");
    store.close();
  });
});
