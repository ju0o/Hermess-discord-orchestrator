import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/database.js";
import type { TaskRecord } from "../src/domain/types.js";
import type { ValidationEvidence } from "../src/runtime/correction.js";
import { bindReusedEvidence, contextFromResult, handoffContextForDispatch, recordHandoffContext } from "../src/runtime/handoffContext.js";

const dirs: string[] = [];
const storePaths = new WeakMap<Store, string>();
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function setup() { const dir = mkdtempSync(path.join(os.tmpdir(), "handoff-context-")); dirs.push(dir); const dbPath = path.join(dir, "db.sqlite"); const store = new Store(dbPath); storePaths.set(store, dbPath); return store; }
const task = (taskId = "T1") => ({ taskId, goal: "implement feature X" } as TaskRecord);
const executed = (taskId = "T1"): ValidationEvidence => ({ task_id: taskId, type: "TEST", command: "npm test", exit_code: 0,
  status: "PASS", timestamp: "2026-08-23T00:00:00.000Z", worktree: "C:\\fixture", branch: "task/x", base_sha: "abc", source: "EXECUTED" });
function source(store: Store, taskId = "T1") {
  const id = `source-${taskId}`; const at = store.now(); const evidence = executed(taskId);
  store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, taskId, "RESULT", "CODEX", "ASUS", JSON.stringify({ validation_evidence: [evidence], worker_execution_id: `exec-${taskId}` }), at);
  return { eventId: id, taskId, type: "RESULT", sender: "CODEX", recipient: "ASUS", payload: {}, createdAt: at } as const;
}

describe("durable downstream handoff context and evidence binding", () => {
  it("binds accepted REUSED evidence to an existing same-Task execution and rejects unresolved or cross-Task provenance", () => {
    const store = setup(); try { const event = source(store); const reference = { ...executed(), source: "REUSED" as const };
      expect(bindReusedEvidence(store, "T1", [reference])).toEqual([expect.objectContaining({ source: "REUSED", source_event_id: event.eventId, source_execution_id: "exec-T1" })]);
      expect(() => bindReusedEvidence(store, "T1", [{ ...reference, command: "fabricated" }])).toThrow("REUSED_EVIDENCE_PROVENANCE_UNRESOLVED");
      expect(() => bindReusedEvidence(store, "OTHER", [reference])).toThrow("REUSED_EVIDENCE_TASK_PROVENANCE_INVALID");
    } finally { store.close(); }
  });

  it("preserves Developer evidence/result/action durably across restart and reassignment without mutable provenance", () => {
    const store = setup(); const event = source(store); const bound = bindReusedEvidence(store, "T1", [{ ...executed(), source: "REUSED" }]);
    const review = contextFromResult(task(), event as never, "DEVELOPER", "REVIEWER", 4, "DEVELOPER_PASS", bound);
    recordHandoffContext(store, review); const dbPath = storePaths.get(store)!; store.close();
    const restarted = new Store(dbPath); try { const found = handoffContextForDispatch(restarted, "T1", "REVIEWER", 4)!;
      expect(found.previousResult).toBe("DEVELOPER_PASS"); expect(found.validationEvidence).toEqual(bound);
      expect(found.currentAction).toMatch(/^Review the Developer result/); expect(found.originalGoal).toBe("implement feature X");
      expect(handoffContextForDispatch(restarted, "T1", "REVIEWER", 3)).toBeUndefined();
      expect(handoffContextForDispatch(restarted, "OTHER", "REVIEWER", 4)).toBeUndefined();
      expect(recordHandoffContext(restarted, found)).toEqual(found);
      expect(() => recordHandoffContext(restarted, { ...found, validationEvidence: [{ ...found.validationEvidence[0]!, source_event_id: "rewritten" }] }))
        .toThrow("HANDOFF_CONTEXT_IMMUTABLE_CONFLICT");
    } finally { restarted.close(); }
  });

  it("projects Reviewer PASS to QA and exact REVISION_REQUIRED findings back to Developer", () => {
    const store = setup(); try { const devEvent = source(store); const bound = bindReusedEvidence(store, "T1", [{ ...executed(), source: "REUSED" }]);
      const reviewEvent = { ...devEvent, eventId: "review", type: "REVIEW", sender: "CLAUDE_CODE", createdAt: store.now() };
      store.db.prepare("INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)")
        .run("review", "T1", "REVIEW", "CLAUDE_CODE", "ASUS", JSON.stringify({ verdict: "REVIEW_PASS", validation_evidence: bound }), reviewEvent.createdAt);
      const qa = contextFromResult(task(), reviewEvent as never, "REVIEWER", "QA", 0, "REVIEW_PASS", bound);
      recordHandoffContext(store, qa); expect(handoffContextForDispatch(store, "T1", "QA", 0)).toMatchObject({ previousRole: "REVIEWER", validationEvidence: bound });
      expect(qa.currentAction).toMatch(/^Perform the QA contract/); expect(qa.originalGoal).toBe("implement feature X");
      const revision = contextFromResult(task(), reviewEvent as never, "REVIEWER", "DEVELOPER", 5, "REVISION_REQUIRED", bound, ["fix null guard"], true);
      recordHandoffContext(store, revision); expect(handoffContextForDispatch(store, "T1", "DEVELOPER", 5)).toMatchObject({ findings: ["fix null guard"], validationEvidence: bound });
      expect(revision.currentAction).not.toBe(revision.originalGoal);
    } finally { store.close(); }
  });
});
