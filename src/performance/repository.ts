import type { Store } from "../storage/database.js";
import type { SQLInputValue } from "node:sqlite";
import type { PerformanceFilter, PerformanceSummary } from "./types.js";

export class PerformanceRepository {
  constructor(private readonly store: Store, private readonly earlySignalMin = 5, private readonly observedMin = 20) {}

  upsertTask(record: Record<string, unknown>): void {
    this.store.db.prepare(`INSERT INTO performance_task_records(task_id,project_id,data_class,task_type,complexity,final_status,
      required_roles_json,team_size,started_at,completed_at,duration_ms,attempt_count,revision_count,discussion_rounds,
      expert_invite_count,human_gate_count,model_escalation_count,final_verdict,failure_category,evidence_sources_json,created_at,updated_at)
      VALUES(@task_id,@project_id,@data_class,@task_type,@complexity,@final_status,@required_roles_json,@team_size,@started_at,
      @completed_at,@duration_ms,@attempt_count,@revision_count,@discussion_rounds,@expert_invite_count,@human_gate_count,
      @model_escalation_count,@final_verdict,@failure_category,@evidence_sources_json,@created_at,@updated_at)
      ON CONFLICT(task_id) DO UPDATE SET project_id=excluded.project_id,data_class=excluded.data_class,task_type=excluded.task_type,
      complexity=excluded.complexity,final_status=excluded.final_status,required_roles_json=excluded.required_roles_json,
      team_size=excluded.team_size,started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,
      attempt_count=excluded.attempt_count,revision_count=excluded.revision_count,discussion_rounds=excluded.discussion_rounds,
      expert_invite_count=excluded.expert_invite_count,human_gate_count=excluded.human_gate_count,
      model_escalation_count=excluded.model_escalation_count,final_verdict=excluded.final_verdict,
      failure_category=excluded.failure_category,evidence_sources_json=excluded.evidence_sources_json,updated_at=excluded.updated_at`).run(record as Record<string, SQLInputValue>);
  }

  upsertRole(record: Record<string, unknown>): void {
    this.store.db.prepare(`INSERT INTO performance_role_records(task_id,role,sequence,agent_id,provider,requested_model,effective_model,
      model_tier,status,started_at,completed_at,duration_ms,attempts,revisions,result_type,failure_category,context_failure,
      workspace_conflict,human_intervention,selected_reason,input_tokens,output_tokens,cache_tokens,reported_cost,usage_source,
      cost_known,subscription_based,provider_based,evidence_sources_json,updated_at)
      VALUES(@task_id,@role,@sequence,@agent_id,@provider,@requested_model,@effective_model,@model_tier,@status,@started_at,
      @completed_at,@duration_ms,@attempts,@revisions,@result_type,@failure_category,@context_failure,@workspace_conflict,
      @human_intervention,@selected_reason,@input_tokens,@output_tokens,@cache_tokens,@reported_cost,@usage_source,@cost_known,
      @subscription_based,@provider_based,@evidence_sources_json,@updated_at)
      ON CONFLICT(task_id,role,sequence) DO UPDATE SET agent_id=excluded.agent_id,provider=excluded.provider,
      requested_model=excluded.requested_model,effective_model=excluded.effective_model,model_tier=excluded.model_tier,status=excluded.status,
      started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,attempts=excluded.attempts,
      revisions=excluded.revisions,result_type=excluded.result_type,failure_category=excluded.failure_category,
      context_failure=excluded.context_failure,workspace_conflict=excluded.workspace_conflict,human_intervention=excluded.human_intervention,
      selected_reason=excluded.selected_reason,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
      cache_tokens=excluded.cache_tokens,reported_cost=excluded.reported_cost,usage_source=excluded.usage_source,
      cost_known=excluded.cost_known,subscription_based=excluded.subscription_based,provider_based=excluded.provider_based,
      evidence_sources_json=excluded.evidence_sources_json,updated_at=excluded.updated_at`).run(record as Record<string, SQLInputValue>);
  }

  upsertEvent(record: Record<string, unknown>): void {
    this.store.db.prepare(`INSERT INTO performance_events(logical_key,task_id,metric_type,role,agent_id,provider,model,status,
      metrics_json,evidence_source,evidence_ref,occurred_at,created_at) VALUES(@logical_key,@task_id,@metric_type,@role,@agent_id,
      @provider,@model,@status,@metrics_json,@evidence_source,@evidence_ref,@occurred_at,@created_at)
      ON CONFLICT(logical_key) DO UPDATE SET role=excluded.role,agent_id=excluded.agent_id,provider=excluded.provider,
      model=excluded.model,status=excluded.status,metrics_json=excluded.metrics_json,evidence_source=excluded.evidence_source,
      evidence_ref=excluded.evidence_ref,occurred_at=excluded.occurred_at`).run(record as Record<string, SQLInputValue>);
  }

  summary(subject: string, where: string, params: SQLInputValue[], filter: PerformanceFilter = {}): PerformanceSummary {
    const dataClass = filter.dataClass || "REAL_PROJECT"; const clauses = [where]; const values = [...params];
    if (dataClass !== "ALL") { clauses.push("t.data_class=?"); values.push(dataClass); }
    if (filter.projectId) { clauses.push("t.project_id=?"); values.push(filter.projectId); }
    const row = this.store.db.prepare(`SELECT count(*) executions,
      sum(CASE WHEN r.status='PASS' THEN 1 ELSE 0 END) pass,
      sum(CASE WHEN r.status='FAIL' THEN 1 ELSE 0 END) fail,
      sum(CASE WHEN r.status='BLOCKED' THEN 1 ELSE 0 END) blocked,
      sum(r.revisions) revisions,avg(r.duration_ms) mean_duration,max(COALESCE(r.completed_at,r.started_at)) last_active
      FROM performance_role_records r JOIN performance_task_records t ON t.task_id=r.task_id WHERE ${clauses.join(" AND ")}`)
      .get(...values) as Record<string, unknown>;
    const executions = Number(row.executions || 0); const confidence = executions === 0 ? "NO_DATA" : executions < this.earlySignalMin
      ? "INSUFFICIENT_DATA" : executions < this.observedMin ? "EARLY_SIGNAL" : "OBSERVED";
    return { subject, dataClass, executions, pass: Number(row.pass || 0), fail: Number(row.fail || 0), blocked: Number(row.blocked || 0),
      revisions: Number(row.revisions || 0), meanDurationMs: row.mean_duration === null ? null : Math.round(Number(row.mean_duration)),
      confidence, ...(row.last_active ? { lastActiveAt: String(row.last_active) } : {}) };
  }

  counts(taskId?: string): { tasks: number; roles: number; events: number } {
    const condition = taskId ? " WHERE task_id=?" : ""; const args: SQLInputValue[] = taskId ? [taskId] : [];
    const count = (table: string) => Number((this.store.db.prepare(`SELECT count(*) n FROM ${table}${condition}`).get(...args) as { n: number }).n);
    return { tasks: count("performance_task_records"), roles: count("performance_role_records"), events: count("performance_events") };
  }
}
