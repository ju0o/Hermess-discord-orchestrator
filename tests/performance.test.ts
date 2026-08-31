import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PerformanceService } from "../src/performance/service.js";
import { PerformanceScorer } from "../src/performance/scorer.js";
import { classifyContextFailure, classifyData, classifyFailure } from "../src/performance/classification.js";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";

const dirs: string[] = []; afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function setup(taskId = "SYM-PERF-TEST") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "symphony-performance-")); dirs.push(dir); const store = new Store(path.join(dir, "state.db"));
  const tasks = new TaskRepository(store); tasks.upsertProject({ projectId: "p", name: "P", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  const task = tasks.create({ taskId, projectId: "p", title: "Performance canary", goal: "Validate ledger", role: "DEVELOPER",
    requiredCapabilities: ["coding"], assignedAgent: "CODEX", status: "RUNNING", workspace: dir, readContext: {}, fileScope: [],
    doNot: [], validation: ["tests"], owner: "ASUS", nextOwner: "ASUS", attempt: 2, startedAt: "2026-01-01T00:00:00.000Z",
    taskType: "FEATURE", complexity: "T2", requiredRoles: ["DEVELOPER", "REVIEWER", "QA"], teamMode: "SEQUENTIAL", dataClass: "CANARY" });
  const now = store.now();
  store.db.prepare("INSERT INTO task_teams(task_id,task_type,mode,status,created_at,updated_at) VALUES(?,'FEATURE','SEQUENTIAL','ACTIVE',?,?)").run(taskId, now, now);
  const role = store.db.prepare(`INSERT INTO task_roles(task_id,role,sequence,assigned_agent,status,routing_reason,revision_round,created_at,started_at,completed_at,result,evidence_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  role.run(taskId, "DEVELOPER", 1, "CODEX", "PASS", "ONLINE; AVAILABLE; token=secret-value", 1, now, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:05.000Z", "implemented", "[]");
  role.run(taskId, "REVIEWER", 2, "CLAUDE_CODE", "PASS", "INDEPENDENT_REVIEW", 1, now, "2026-01-01T00:00:05.000Z", "2026-01-01T00:00:08.000Z", "REVIEW_PASS", "[]");
  role.run(taskId, "QA", 3, "COMMAND_CODE", "PASS", "TESTING_CAPABILITY", 0, now, "2026-01-01T00:00:08.000Z", "2026-01-01T00:00:10.000Z", "PASS", "[]");
  store.db.prepare(`INSERT INTO model_catalog(model_id,agent_id,provider,model_name,display_name,available,verified,verification_level,override_supported,override_value,resume_override_supported,source,last_verified_at,metadata_json)
    VALUES('m','CODEX','openai-chatgpt','gpt-test','gpt-test',1,1,'EXECUTION_VERIFIED',1,'gpt-test',1,'test',?,'{}')`).run(now);
  store.db.prepare(`INSERT INTO model_routing_decisions(decision_id,task_id,role,agent_id,complexity,requested_tier,selected_tier,model_catalog_id,requested_model,provider,effective_model,reason,fallback,status,created_at)
    VALUES('md',?,'DEVELOPER','CODEX','T2','STANDARD','STANDARD','m','gpt-test','openai-chatgpt','gpt-test','verified',0,'SELECTED',?)`).run(taskId, now);
  const event = (id: string, type: string, sender: string, recipient: string, payload: object) => store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`).run(id, taskId, type, sender, recipient, JSON.stringify(payload), now);
  event("ack", "ACK", "CODEX", "ASUS", { role: "DEVELOPER", status: "CLAIMED" });
  event("review", "REVIEW", "CLAUDE_CODE", "CODEX", { role: "REVIEWER", verdict: "REVISION_REQUIRED", findings: ["bounded issue"], evidence: ["diff"] });
  event("revision-request", "REVISION_REQUEST", "CLAUDE_CODE", "CODEX", { role: "REVIEWER", round: 1, findings: ["bounded issue"] });
  event("revision-result", "REVISION_RESULT", "CODEX", "CLAUDE_CODE", { role: "DEVELOPER", round: 1, status: "PASS" });
  event("qa", "QA_RESULT", "COMMAND_CODE", "ASUS", { role: "QA", status: "PASS", checks: ["npm test", "npm run build"], evidence: ["exit 0"] });
  store.db.prepare(`INSERT INTO discussion_topics(topic_id,task_id,topic,fingerprint,status,current_round,created_by,created_at,updated_at) VALUES('topic',?,'bounded topic','fp','CONSENSUS',2,'CODEX',?,?)`).run(taskId, now, now);
  store.db.prepare(`INSERT INTO discussion_events(event_id,task_id,topic_id,event_type,sender_agent,recipient_agent,sender_role,recipient_role,discussion_round,content,next_owner,status,fingerprint,created_at)
    VALUES('de',?,'topic','QUESTION','CODEX','CLAUDE_CODE','DEVELOPER','REVIEWER',1,'question','CLAUDE_CODE','PROCESSED','dfp',?)`).run(taskId, now);
  store.db.prepare(`INSERT INTO expert_requests(request_id,task_id,requested_role,requested_capabilities_json,reason,evidence_json,requesting_agent,urgency,scope_json,status,selected_agent,selected_tier,selected_model,provider,return_role_sequence,created_at,updated_at)
    VALUES('expert',?,'MCP_SPECIALIST','["mcp"]','MCP mismatch','[]','CODEX','NORMAL','[]','PASS','OPENCODE','STANDARD','deepseek','opencode-go',1,?,?)`).run(taskId, now, now);
  store.db.prepare(`INSERT INTO expert_memberships(task_id,role,agent_id,request_id,status,joined_at,join_reason,requested_by,scope_json,completed_at) VALUES(?,'MCP_SPECIALIST','OPENCODE','expert','PASS',?,'bounded','CODEX','[]',?)`).run(taskId, now, now);
  const performance = new PerformanceService(store); return { dir, store, tasks, task, performance };
}

describe("Phase G performance ledger", () => {
  it("adds schema 1206 and the additive ledger tables", () => { const x = setup(); expect(x.store.db.prepare("SELECT version FROM schema_migrations WHERE version=1206").get()).toBeTruthy();
    expect(x.store.db.prepare("PRAGMA table_info(tasks)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "data_class" })])); x.store.close(); });
  it("records Task, Role, Agent, Model, Review, QA, Revision, Discussion and Expert metrics", () => { const x = setup(); x.performance.refreshTask(x.task.taskId); const counts = x.performance.repository.counts(x.task.taskId);
    expect(counts).toEqual({ tasks: 1, roles: 3, events: 6 }); expect(x.store.db.prepare("SELECT data_class,revision_count,discussion_rounds,expert_invite_count FROM performance_task_records WHERE task_id=?").get(x.task.taskId)).toEqual({ data_class: "CANARY", revision_count: 1, discussion_rounds: 2, expert_invite_count: 1 }); x.store.close(); });
  it("captures structured review and QA evidence without duplicating message bodies", () => { const x = setup(); x.performance.refreshTask(x.task.taskId);
    const review = x.store.db.prepare("SELECT metrics_json,evidence_ref FROM performance_events WHERE logical_key='protocol:review'").get() as { metrics_json: string; evidence_ref: string };
    const qa = x.store.db.prepare("SELECT metrics_json FROM performance_events WHERE logical_key='protocol:qa'").get() as { metrics_json: string };
    expect(JSON.parse(review.metrics_json)).toMatchObject({ findingsCount: 1, revisionRequired: true, evidenceCount: 1 }); expect(review.evidence_ref).toBe("protocol_events:review");
    expect(JSON.parse(qa.metrics_json)).toMatchObject({ checksRun: 2, checksPassed: 2, checkTypes: ["TEST", "BUILD"] }); expect(review.metrics_json).not.toContain("bounded issue"); x.store.close(); });
  it("keeps unavailable usage and reported cost NULL with subscription semantics", () => { const x = setup(); x.performance.refreshTask(x.task.taskId);
    expect(x.store.db.prepare("SELECT input_tokens,output_tokens,reported_cost,cost_known,subscription_based,provider_based FROM performance_role_records WHERE task_id=? AND role='DEVELOPER'").get(x.task.taskId))
      .toEqual({ input_tokens: null, output_tokens: null, reported_cost: null, cost_known: 0, subscription_based: 1, provider_based: 0 }); x.store.close(); });
  it("classifies Canary/Test/Real data deterministically and honors explicit values", () => { expect(classifyData({ taskId: "SYM-TEAM-1" })).toBe("CANARY"); expect(classifyData({ taskId: "legacy", projectId: "phase-a-control-canary", projectStatus: "CANARY" })).toBe("CANARY"); expect(classifyData({ taskId: "TEST-1" })).toBe("TEST"); expect(classifyData({ taskId: "P-1" })).toBe("REAL_PROJECT"); expect(classifyData({ taskId: "P-1", dataClass: "CANARY" })).toBe("CANARY"); });
  it("uses evidence-based failure and context taxonomies", () => { expect(classifyFailure("authentication required")).toBe("AUTH"); expect(classifyFailure("workspace conflict")).toBe("WORKSPACE_CONFLICT"); expect(classifyFailure("npm test failed")).toBe("TEST"); expect(classifyContextFailure("MISSING_REQUIRED_CONTEXT")).toBe("MISSING_REQUIRED_CONTEXT"); expect(classifyContextFailure("looks incomplete")).toBeNull(); });
  it("excludes Canary data from the default REAL_PROJECT summary", () => { const x = setup(); x.performance.refreshTask(x.task.taskId); expect(x.performance.renderAgents()).toContain("NO_REAL_PROJECT_DATA"); expect(x.performance.agentSummary("CODEX", { dataClass: "CANARY" }).executions).toBe(1); x.store.close(); });
  it("returns an insufficient-data guard instead of a precision score", () => { const x = setup(); x.performance.refreshTask(x.task.taskId); expect(x.performance.agentSummary("CODEX", { dataClass: "CANARY" }).confidence).toBe("INSUFFICIENT_DATA"); x.store.close(); });
  it("backfills only evidence present and remains idempotent across restart-style repeats", () => { const x = setup(); const first = x.performance.backfill([x.task.taskId]); const second = x.performance.backfill([x.task.taskId]); expect(first.counts).toEqual(second.counts); expect(second.failed).toBe(0); x.store.close(); });
  it("deduplicates outbound and inbound protocol evidence by Discord Message ID", () => { const x = setup(); x.store.db.prepare("UPDATE protocol_events SET discord_message_id='discord-review' WHERE event_id='review'").run();
    const row = x.store.db.prepare("SELECT * FROM protocol_events WHERE event_id='review'").get() as Record<string, unknown>;
    x.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,discord_message_id,created_at) VALUES('inbound:discord-review',?,?,?,?,?,'discord-review',?)`)
      .run(row.task_id, row.event_type, row.sender, row.recipient, row.payload_json, row.created_at); x.performance.refreshTask(x.task.taskId);
    expect(x.store.db.prepare("SELECT count(*) n FROM performance_events WHERE task_id=? AND metric_type='REVIEW'").get(x.task.taskId)).toEqual({ n: 1 });
    expect(x.store.db.prepare("SELECT revision_count FROM performance_task_records WHERE task_id=?").get(x.task.taskId)).toEqual({ revision_count: 1 }); x.store.close(); });
  it("redacts routing reasons before ledger persistence", () => { const x = setup(); x.performance.refreshTask(x.task.taskId); const row = x.store.db.prepare("SELECT selected_reason FROM performance_role_records WHERE task_id=? AND role='DEVELOPER'").get(x.task.taskId) as { selected_reason: string }; expect(row.selected_reason).toContain("[REDACTED]"); expect(row.selected_reason).not.toContain("secret-value"); x.store.close(); });
  it("does not let observability failure corrupt a Task transition", () => { const x = setup("REAL-OBS-FAIL"); x.tasks.attachObserver({ observeTask: () => { throw new Error("metric failure"); } });
    expect(x.tasks.transition(x.task.taskId, "WAITING_RESULT").status).toBe("WAITING_RESULT"); x.store.close(); });
  it("keeps performance learning disabled and outside routing", () => { const scorer = new PerformanceScorer(); expect(scorer.enabled).toBe(false); expect(() => scorer.score()).toThrow("PERFORMANCE_LEARNING_DISABLED"); });
});
