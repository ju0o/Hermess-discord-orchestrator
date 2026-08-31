import type { AgentId, DataClass, Role, TaskRecord } from "../domain/types.js";
import { AGENT_IDS } from "../domain/types.js";
import { redact, safeError } from "../security/redaction.js";
import type { Store } from "../storage/database.js";
import type { SQLInputValue } from "node:sqlite";
import { classifyContextFailure, classifyData, classifyFailure } from "./classification.js";
import { PerformanceRepository } from "./repository.js";
import type { PerformanceFilter, PerformanceObserver, PerformanceSummary } from "./types.js";

const TERMINAL_FAILURE = new Set(["FAIL", "BLOCKED", "WAITING_MAIN", "HUMAN_GATE"]);
const safeJson = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value)) as T; } catch { return fallback; } };
const duration = (start: unknown, end: unknown): number | null => start && end ? Math.max(0, Date.parse(String(end)) - Date.parse(String(start))) : null;
const compactReason = (value: unknown): string | null => value ? redact(String(value)).slice(0, 500) : null;

export class PerformanceService implements PerformanceObserver {
  readonly repository: PerformanceRepository;
  readonly learningEnabled = false;

  constructor(private readonly store: Store, thresholds: { earlySignalMin?: number; observedMin?: number } = {}) {
    this.repository = new PerformanceRepository(store, thresholds.earlySignalMin || 5, thresholds.observedMin || 20);
  }

  observeTask(taskId: string): void { this.safeRefresh(taskId); }

  safeRefresh(taskId: string): boolean {
    try { this.refreshTask(taskId); return true; }
    catch (error) {
      this.store.upsertRuntimeState("observability:last_error", { code: "OBSERVABILITY_WRITE_FAILED", taskId, error: safeError(error), at: this.store.now() });
      return false;
    }
  }

  refreshTask(taskId: string): void {
    const task = this.store.db.prepare("SELECT * FROM tasks WHERE task_id=?").get(taskId) as Record<string, unknown> | undefined;
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const project = this.store.db.prepare("SELECT status FROM projects WHERE project_id=?").get(String(task.project_id)) as { status: string } | undefined;
    const manualClass = task.data_class_source === "MANUAL" && task.data_class ? task.data_class as DataClass : undefined;
    const dataClass = classifyData({ taskId, projectId: String(task.project_id), ...(project?.status ? { projectStatus: project.status } : {}), ...(manualClass ? { dataClass: manualClass } : {}) });
    if (task.data_class !== dataClass || !task.data_class_source) this.store.db.prepare("UPDATE tasks SET data_class=?,data_class_source=? WHERE task_id=?").run(dataClass, manualClass ? "MANUAL" : "INFERRED", taskId);
    const roles = this.store.db.prepare("SELECT * FROM task_roles WHERE task_id=? ORDER BY sequence").all(taskId) as Record<string, unknown>[];
    const protocolRows = this.store.db.prepare("SELECT * FROM protocol_events WHERE task_id=? ORDER BY created_at,event_id").all(taskId) as Record<string, unknown>[];
    const protocol = canonicalProtocol(protocolRows);
    const topics = this.store.db.prepare("SELECT * FROM discussion_topics WHERE task_id=? ORDER BY created_at").all(taskId) as Record<string, unknown>[];
    const experts = this.store.db.prepare("SELECT * FROM expert_requests WHERE task_id=? ORDER BY created_at").all(taskId) as Record<string, unknown>[];
    const escalations = this.store.db.prepare("SELECT * FROM model_escalations WHERE task_id=? ORDER BY created_at").all(taskId) as Record<string, unknown>[];
    const requiredRoles = task.required_roles_json ? safeJson<string[]>(task.required_roles_json, []) : roles.map((item) => String(item.role));
    const revisionCount = protocol.filter((event) => event.event_type === "REVISION_REQUEST").length;
    const discussionRounds = topics.reduce((sum, topic) => sum + Number(topic.current_round || 0), 0);
    const humanGateCount = Math.max(protocol.filter((event) => {
      const p = safeJson<Record<string, unknown>>(event.payload_json, {}); return p.status === "HUMAN_GATE" || p.status === "WAITING_MAIN";
    }).length, ["HUMAN_GATE", "WAITING_MAIN"].includes(String(task.status)) ? 1 : 0);
    const verdict = [...protocol].reverse().find((event) => event.event_type === "VERDICT");
    const verdictPayload = verdict ? safeJson<Record<string, unknown>>(verdict.payload_json, {}) : {};
    const failureText = TERMINAL_FAILURE.has(String(task.status)) ? String(task.result || verdictPayload.reason || task.status) : "";
    const now = this.store.now();
    this.store.transaction(() => {
      this.repository.upsertTask({ task_id: taskId, project_id: String(task.project_id), data_class: dataClass,
        task_type: task.task_type || null, complexity: task.complexity || null, final_status: String(task.status),
        required_roles_json: JSON.stringify(requiredRoles), team_size: roles.length || (task.assigned_agent ? 1 : 0),
        started_at: task.started_at || null, completed_at: task.completed_at || null,
        duration_ms: duration(task.started_at, task.completed_at), attempt_count: Number(task.attempt || 0), revision_count: revisionCount,
        discussion_rounds: discussionRounds, expert_invite_count: experts.filter((item) => item.status !== "NOT_NEEDED").length,
        human_gate_count: humanGateCount, model_escalation_count: escalations.filter((item) => item.action === "ESCALATED").length,
        final_verdict: verdictPayload.status || (String(task.status) === "PASS" ? "PASS" : null),
        failure_category: classifyFailure(failureText), evidence_sources_json: JSON.stringify(["TASK_STATE", "DISCORD_PROTOCOL"]),
        created_at: String(task.created_at), updated_at: now });
      if (roles.length) for (const role of roles) this.refreshRole(task, role, protocol, humanGateCount, now);
      else this.refreshLegacyRole(task, protocol, humanGateCount, now);
      this.removeSupersededProtocolMetrics(taskId);
      for (const event of protocol) this.refreshProtocolEvent(event, roles);
      for (const topic of topics) this.refreshDiscussion(topic, experts);
      for (const expert of experts) this.refreshExpert(expert);
      for (const escalation of escalations) this.refreshEscalation(escalation);
    });
  }

  backfill(taskIds?: string[]): { processed: number; failed: number; counts: { tasks: number; roles: number; events: number } } {
    const ids = taskIds || (this.store.db.prepare("SELECT task_id FROM tasks ORDER BY created_at").all() as Array<{ task_id: string }>).map((item) => item.task_id);
    let processed = 0; let failed = 0; for (const id of ids) this.safeRefresh(id) ? processed++ : failed++;
    return { processed, failed, counts: this.repository.counts() };
  }

  agentSummary(agentId: AgentId, filter: PerformanceFilter = {}): PerformanceSummary {
    return this.repository.summary(agentId, "r.agent_id=?", [agentId], filter);
  }
  roleSummary(role: Role, filter: PerformanceFilter = {}): PerformanceSummary {
    return this.repository.summary(role, "r.role=?", [role], filter);
  }
  modelSummary(agentId: AgentId, filter: PerformanceFilter = {}): PerformanceSummary[] {
    const dataClass = filter.dataClass || "REAL_PROJECT"; const params: SQLInputValue[] = [agentId]; const clauses = ["r.agent_id=?", "r.requested_model IS NOT NULL"];
    if (dataClass !== "ALL") { clauses.push("t.data_class=?"); params.push(dataClass); }
    const models = this.store.db.prepare(`SELECT DISTINCT r.requested_model model FROM performance_role_records r
      JOIN performance_task_records t ON t.task_id=r.task_id WHERE ${clauses.join(" AND ")} ORDER BY model`).all(...params) as Array<{ model: string }>;
    return models.map((item) => this.repository.summary(`${agentId}/${item.model}`, "r.agent_id=? AND r.requested_model=?", [agentId, item.model], filter));
  }
  agentsSummary(filter: PerformanceFilter = {}): PerformanceSummary[] { return AGENT_IDS.map((id) => this.agentSummary(id, filter)); }
  projectSummary(projectId: string, filter: PerformanceFilter = {}): PerformanceSummary {
    return this.repository.summary(projectId, "1=1", [], { ...filter, projectId });
  }

  renderAgents(filter: PerformanceFilter = {}): string {
    const rows = this.agentsSummary(filter); if (rows.every((row) => row.executions === 0) && (filter.dataClass || "REAL_PROJECT") === "REAL_PROJECT") return "NO_REAL_PROJECT_DATA\nPerformance learning: DISABLED";
    return ["SYMPHONY PERFORMANCE / AGENTS", ...rows.map(renderSummary), "Performance learning: DISABLED"].join("\n");
  }
  renderAgent(agentId: AgentId, filter: PerformanceFilter = {}): string { const row = this.agentSummary(agentId, filter);
    return row.executions === 0 && (filter.dataClass || "REAL_PROJECT") === "REAL_PROJECT" ? `NO_REAL_PROJECT_DATA (${agentId})\nPerformance learning: DISABLED` : `${renderSummary(row)}\nPerformance learning: DISABLED`; }
  renderRole(role: Role, filter: PerformanceFilter = {}): string { const row = this.roleSummary(role, filter);
    return row.executions === 0 && (filter.dataClass || "REAL_PROJECT") === "REAL_PROJECT" ? `NO_REAL_PROJECT_DATA (${role})\nPerformance learning: DISABLED` : `${renderSummary(row)}\nPerformance learning: DISABLED`; }
  renderModels(agentId: AgentId, filter: PerformanceFilter = {}): string { const rows = this.modelSummary(agentId, filter);
    return rows.length ? [`SYMPHONY PERFORMANCE / MODELS / ${agentId}`, ...rows.map(renderSummary), "Performance learning: DISABLED"].join("\n")
      : `NO_REAL_PROJECT_DATA (${agentId} models)\nPerformance learning: DISABLED`; }
  renderProject(projectId: string, filter: PerformanceFilter = {}): string { const row = this.projectSummary(projectId, filter);
    return row.executions === 0 && (filter.dataClass || "REAL_PROJECT") === "REAL_PROJECT" ? `NO_REAL_PROJECT_DATA (${projectId})\nPerformance learning: DISABLED` : `${renderSummary(row)}\nPerformance learning: DISABLED`; }

  private refreshRole(task: Record<string, unknown>, role: Record<string, unknown>, protocol: Record<string, unknown>[], humanGateCount: number, now: string): void {
    const agent = role.assigned_agent ? String(role.assigned_agent) : null; const roleName = String(role.role); const sequence = Number(role.sequence);
    const model = this.store.db.prepare(`SELECT * FROM model_routing_decisions WHERE task_id=? AND role=? AND (? IS NULL OR agent_id=?)
      ORDER BY created_at DESC LIMIT 1`).get(String(task.task_id), roleName, agent, agent) as Record<string, unknown> | undefined;
    const relevant = protocol.filter((event) => { const payload = safeJson<Record<string, unknown>>(event.payload_json, {});
      return String(payload.role || "").toUpperCase() === roleName || String(event.sender) === agent; });
    const outcome = [...relevant].reverse().find((event) => ["RESULT", "REVIEW", "QA_RESULT", "EXPERT_RESULT"].includes(String(event.event_type)));
    const payload = outcome ? safeJson<Record<string, unknown>>(outcome.payload_json, {}) : {};
    const resultText = String(role.result || payload.reason || payload.status || ""); const failed = ["FAIL", "BLOCKED"].includes(String(role.status));
    const provider = model?.provider ? String(model.provider) : null; const subscription = provider ? ["openai-chatgpt", "claude.ai"].includes(provider) : null;
    this.repository.upsertRole({ task_id: task.task_id, role: roleName, sequence, agent_id: agent, provider,
      requested_model: model?.requested_model || null, effective_model: model?.effective_model || null, model_tier: model?.selected_tier || null,
      status: String(role.status), started_at: role.started_at || null, completed_at: role.completed_at || null,
      duration_ms: duration(role.started_at, role.completed_at), attempts: relevant.filter((event) => event.event_type === "ACK").length,
      revisions: Number(role.revision_round || 0), result_type: outcome?.event_type || null,
      failure_category: failed ? classifyFailure(resultText || role.status) : null, context_failure: classifyContextFailure(resultText),
      workspace_conflict: /WORKSPACE_CONFLICT|FILE_CONFLICT/.test(resultText.toUpperCase()) ? 1 : 0,
      human_intervention: humanGateCount > 0 ? 1 : 0, selected_reason: compactReason(role.routing_reason),
      input_tokens: null, output_tokens: null, cache_tokens: null, reported_cost: null, usage_source: null, cost_known: 0,
      subscription_based: subscription === null ? null : subscription ? 1 : 0, provider_based: subscription === null ? null : subscription ? 0 : 1,
      evidence_sources_json: JSON.stringify(["TASK_STATE", ...(model ? ["MODEL_EVENT"] : []), ...(outcome ? ["DISCORD_PROTOCOL"] : [])]), updated_at: now });
  }

  private refreshLegacyRole(task: Record<string, unknown>, protocol: Record<string, unknown>[], humanGateCount: number, now: string): void {
    const pseudo = { role: task.role, sequence: 1, assigned_agent: task.assigned_agent, status: task.status,
      started_at: task.started_at, completed_at: task.completed_at, result: task.result, revision_round: 0, routing_reason: "LEGACY_SINGLE_AGENT" };
    this.refreshRole(task, pseudo, protocol, humanGateCount, now);
  }

  private refreshProtocolEvent(event: Record<string, unknown>, roles: Record<string, unknown>[]): void {
    const type = String(event.event_type); if (!["REVIEW", "QA_RESULT", "REVISION_REQUEST", "REVISION_RESULT"].includes(type)) return;
    const payload = safeJson<Record<string, unknown>>(event.payload_json, {}); const role = String(payload.role || (type === "QA_RESULT" ? "QA" : type === "REVIEW" ? "REVIEWER" : "")) || null;
    const evidence = Array.isArray(payload.evidence) ? payload.evidence : []; const findings = Array.isArray(payload.findings) ? payload.findings : [];
    const checks = Array.isArray(payload.checks) ? payload.checks.map(String) : [];
    const severity = findings.reduce<Record<string, number>>((counts, finding) => { if (finding && typeof finding === "object" && "severity" in finding) {
      const key = String((finding as { severity: unknown }).severity).toUpperCase(); counts[key] = (counts[key] || 0) + 1; } return counts; }, {});
    const metrics: Record<string, unknown> = type === "REVIEW" ? { findingsCount: findings.length, severity, verdict: payload.verdict || payload.status || null,
      revisionRequired: payload.verdict === "REVISION_REQUIRED", round: Number(payload.round || 0), reviewAfterRevision: Number(payload.round || 0) > 0, evidenceCount: evidence.length }
      : type === "QA_RESULT" ? { checksRun: checks.length, checksPassed: String(payload.status).toUpperCase() === "PASS" ? checks.length : null,
        checksFailed: String(payload.status).toUpperCase() === "FAIL" ? Math.max(1, checks.length) : 0,
        checkTypes: checks.map((item) => /typecheck/i.test(item) ? "TYPECHECK" : /build/i.test(item) ? "BUILD" : /lint/i.test(item) ? "LINT" : /test/i.test(item) ? "TEST" : "OTHER"), evidenceCount: evidence.length }
      : { round: Number(payload.round || 0), requestedBy: event.sender, targetAgent: event.recipient,
        reasonCategory: classifyFailure(payload.reason || payload.findings || type), resolved: type === "REVISION_RESULT",
        resolutionDurationMs: type === "REVISION_RESULT" ? this.revisionResolutionDuration(event) : null };
    const implementationAgent = roles.find((item) => Number(item.sequence) < Number(roles.find((item) => item.role === "REVIEWER")?.sequence || 0))?.assigned_agent;
    if (type === "REVIEW") metrics.implementationAgent = implementationAgent || null;
    const logicalKey = event.discord_message_id ? `discord:${event.discord_message_id}` : `protocol:${event.event_id}`;
    this.repository.upsertEvent({ logical_key: logicalKey, task_id: event.task_id, metric_type: type, role,
      agent_id: event.sender || null, provider: null, model: null, status: payload.verdict || payload.status || null,
      metrics_json: JSON.stringify(metrics), evidence_source: "DISCORD_PROTOCOL", evidence_ref: `protocol_events:${event.event_id}`,
      occurred_at: event.created_at, created_at: this.store.now() });
  }

  private refreshDiscussion(topic: Record<string, unknown>, experts: Record<string, unknown>[]): void {
    const topicId = String(topic.topic_id); const participants = (this.store.db.prepare("SELECT DISTINCT sender_agent agent FROM discussion_events WHERE topic_id=? UNION SELECT DISTINCT recipient_agent agent FROM discussion_events WHERE topic_id=?").all(topicId, topicId) as Array<{ agent: string }>).map((item) => item.agent);
    this.repository.upsertEvent({ logical_key: `discussion:${topic.topic_id}`, task_id: topic.task_id, metric_type: "DISCUSSION", role: null,
      agent_id: null, provider: null, model: null, status: topic.status, metrics_json: JSON.stringify({ participants,
        roundCount: Number(topic.current_round || 0), outcome: topic.status, durationMs: duration(topic.created_at, topic.updated_at),
        expertRequestedAfterDiscussion: experts.some((item) => Date.parse(String(item.created_at)) >= Date.parse(String(topic.created_at))) }),
      evidence_source: "DISCORD_PROTOCOL", evidence_ref: `discussion_topics:${topic.topic_id}`, occurred_at: topic.updated_at, created_at: this.store.now() });
  }

  private refreshExpert(expert: Record<string, unknown>): void {
    const membership = this.store.db.prepare("SELECT * FROM expert_memberships WHERE request_id=?").get(String(expert.request_id)) as Record<string, unknown> | undefined;
    this.repository.upsertEvent({ logical_key: `expert:${expert.request_id}`, task_id: expert.task_id, metric_type: "EXPERT", role: expert.requested_role,
      agent_id: expert.selected_agent || null, provider: expert.provider || null, model: expert.selected_model || null, status: expert.status,
      metrics_json: JSON.stringify({ requestedRole: expert.requested_role, requestedBy: expert.requesting_agent,
        reasonCategory: classifyFailure(expert.reason), durationMs: duration(expert.created_at, membership?.completed_at || expert.updated_at),
        result: expert.status, returnedToPipeline: expert.return_role_sequence !== null && ["PASS", "FAIL", "BLOCKED"].includes(String(expert.status)) }),
      evidence_source: "TASK_STATE", evidence_ref: `expert_requests:${expert.request_id}`, occurred_at: expert.updated_at, created_at: this.store.now() });
  }

  private refreshEscalation(item: Record<string, unknown>): void {
    this.repository.upsertEvent({ logical_key: `model-escalation:${item.escalation_id}`, task_id: item.task_id, metric_type: "MODEL_ESCALATION",
      role: item.role, agent_id: item.agent_id, provider: null, model: item.to_model || item.from_model, status: item.action,
      metrics_json: JSON.stringify({ fromTier: item.from_tier, toTier: item.to_tier, fromModel: item.from_model,
        toModel: item.to_model, reasonCategory: item.failure_category, attempt: Number(item.attempt) }), evidence_source: "MODEL_EVENT",
      evidence_ref: `model_escalations:${item.escalation_id}`, occurred_at: item.created_at, created_at: this.store.now() });
  }
  private removeSupersededProtocolMetrics(taskId: string): void {
    this.store.db.prepare(`DELETE FROM performance_events WHERE task_id=? AND logical_key IN (
      SELECT 'protocol:' || event_id FROM protocol_events WHERE task_id=? AND discord_message_id IS NOT NULL
    )`).run(taskId, taskId);
  }
  private revisionResolutionDuration(event: Record<string, unknown>): number | null {
    const payload = safeJson<Record<string, unknown>>(event.payload_json, {}); const round = Number(payload.round || 0);
    const requests = this.store.db.prepare("SELECT created_at,payload_json FROM protocol_events WHERE task_id=? AND event_type='REVISION_REQUEST' AND created_at<=? ORDER BY created_at DESC").all(String(event.task_id), String(event.created_at)) as Array<{ created_at: string; payload_json: string }>;
    const request = requests.find((item) => Number(safeJson<Record<string, unknown>>(item.payload_json, {}).round || 0) === round);
    return request ? duration(request.created_at, event.created_at) : null;
  }
}

function renderSummary(row: PerformanceSummary): string {
  const durationText = row.meanDurationMs === null ? "UNKNOWN" : `${Math.round(row.meanDurationMs / 1000)}s`;
  return `${row.subject}: executions=${row.executions} pass=${row.pass} fail=${row.fail} blocked=${row.blocked} revisions=${row.revisions} mean=${durationText} signal=${row.confidence}`;
}

function canonicalProtocol(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>(); const output: Record<string, unknown>[] = [];
  for (const row of rows) { const key = row.discord_message_id ? `discord:${row.discord_message_id}` : `event:${row.event_id}`;
    if (seen.has(key)) continue; seen.add(key); output.push(row); }
  return output;
}
