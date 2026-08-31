import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagerInferenceObservability } from "../src/observability/managerInference.js";
import { Store } from "../src/storage/database.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() { const dir = mkdtempSync(path.join(os.tmpdir(), "manager-inference-")); dirs.push(dir); const store = new Store(path.join(dir, "test.db"));
  store.db.prepare("INSERT INTO projects(project_id,name,workspace,ssot_paths_json,status,updated_at) VALUES(?,?,?,?,?,?)").run("p", "P", dir, "[]", "ACTIVE", store.now());
  store.db.prepare(`INSERT INTO tasks(task_id,project_id,title,goal,role,required_capabilities_json,status,workspace,read_context_json,file_scope_json,do_not_json,validation_json,owner,evidence_json,updated_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("task-1", "p", "T", "G", "DEVELOPER", "[]", "RUNNING", dir, "{}", "[]", "[]", "[]", "ASUS", "[]", store.now(), store.now());
  return { store, observer: new ManagerInferenceObservability(store) }; }

describe("Manager inference observability", () => {
  it("records one durable attributed observation with provider usage and context metrics", () => {
    const { store, observer } = setup();
    observer.record({ taskId: "task-1", runId: "run-1", projectId: "p", caller: "ASUS", managerRole: "LOCAL_ENGINEERING_SITE_MANAGER", triggerType: "TASK_EVENT", triggerId: "event-1", provider: "provider-x", model: "model-y", providerUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 }, contextChars: 1234, messageCount: 4, resultStatus: "SUCCEEDED", latencyMs: 42, nextOwner: "MAIN", nextState: "WAITING_MAIN" });
    const row = store.db.prepare("SELECT metric_type,metrics_json FROM performance_events WHERE metric_type='MANAGER_INFERENCE'").get() as { metric_type: string; metrics_json: string };
    expect(row.metric_type).toBe("MANAGER_INFERENCE"); expect(JSON.parse(row.metrics_json)).toMatchObject({ task_id: "task-1", caller: "ASUS", manager_role: "LOCAL_ENGINEERING_SITE_MANAGER", provider: "provider-x", model: "model-y", input_tokens: 11, output_tokens: 7, total_tokens: 18, context_chars: 1234, correlation_key: "task-1|run-1|LOCAL_ENGINEERING_SITE_MANAGER|TASK_EVENT|event-1" });
    store.close();
  });

  it("keeps missing provider usage null and exposes duplicate and handoff attribution", () => {
    const { store, observer } = setup();
    const base = { taskId: "task-1", runId: "run-1", caller: "MAIN", managerRole: "MAIN", triggerType: "HANDOFF", triggerId: "h-1", contextBytes: 10, resultStatus: "FAILED" as const, latencyMs: 1, correlationKey: "same-trigger" };
    observer.record(base); observer.record({ ...base, caller: "ASUS", managerRole: "ASUS", retryOf: "persisted-observation" });
    const summary = observer.recent(10); store.close(); expect(summary.total).toBe(2); expect(summary.observations.find((item) => item.retryOf)).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, tokenUsageSource: "UNKNOWN", retryOf: "persisted-observation" }); expect(summary.suspiciousSignals).toContain("REPEATED_TRIGGER"); expect(summary.byRole).toEqual({ ASUS: 1, MAIN: 1 });
    const raw = JSON.stringify(summary); expect(raw).not.toContain("prompt"); expect(raw).not.toContain("token=");
  });

  it("keeps deterministic Manager-disabled activity at zero when recorder is unused", () => {
    const { store, observer } = setup(); expect(observer.recent().total).toBe(0); store.close();
  });
});
