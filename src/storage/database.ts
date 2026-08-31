import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "../config/env.js";

export class Store {
  readonly db: DatabaseSync;

  constructor(databasePath = config.databasePath) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, backend_type TEXT NOT NULL,
        discord_bot_id TEXT, status TEXT NOT NULL, capabilities_json TEXT NOT NULL,
        current_role TEXT, current_project TEXT, current_task TEXT, working_directory TEXT,
        session_id TEXT, last_seen TEXT, health TEXT NOT NULL, health_detail TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roles (
        role_id TEXT PRIMARY KEY, required_capabilities_json TEXT NOT NULL, description TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace TEXT NOT NULL UNIQUE,
        discord_channel_id TEXT, ssot_paths_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
        role TEXT NOT NULL, required_capabilities_json TEXT NOT NULL, assigned_agent TEXT, status TEXT NOT NULL,
        workspace TEXT NOT NULL, thread_id TEXT, parent_channel_id TEXT, read_context_json TEXT NOT NULL,
        file_scope_json TEXT NOT NULL, do_not_json TEXT NOT NULL, validation_json TEXT NOT NULL,
        owner TEXT NOT NULL, next_owner TEXT, attempt INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, result TEXT,
        evidence_json TEXT NOT NULL, lock_token TEXT, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(project_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_thread ON tasks(thread_id)
        WHERE thread_id IS NOT NULL AND status NOT IN ('PASS','FAIL','CANCELLED');
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT,
        cli_session_id TEXT, model TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_processes (
        process_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, pid INTEGER NOT NULL,
        working_dir TEXT NOT NULL, session_id TEXT, started_at TEXT NOT NULL, last_seen TEXT NOT NULL,
        exit_code INTEGER, status TEXT NOT NULL, log_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_processes_task ON worker_processes(task_id, started_at);
      CREATE TABLE IF NOT EXISTS workspace_locks (
        lock_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        file_scope_json TEXT NOT NULL, acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS discord_mappings (
        discord_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
        name TEXT NOT NULL, project_id TEXT, task_id TEXT, policy_json TEXT NOT NULL,
        discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS protocol_events (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, payload_json TEXT NOT NULL,
        discord_message_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_records (
        delivery_id TEXT PRIMARY KEY, task_id TEXT, channel_id TEXT NOT NULL, thread_id TEXT,
        content TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        discord_message_id TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trusted_bots (
        bot_type TEXT PRIMARY KEY, discord_bot_id TEXT UNIQUE, agent_id TEXT,
        source TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound_messages (
        discord_message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, role TEXT, status TEXT, next_owner TEXT,
        discussion_round INTEGER NOT NULL DEFAULT 0, thread_id TEXT, channel_id TEXT NOT NULL,
        logical_key TEXT NOT NULL, envelope_json TEXT NOT NULL, state TEXT NOT NULL,
        reason_code TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inbound_messages_task ON inbound_messages(task_id,created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_messages_logical ON inbound_messages(logical_key)
        WHERE state IN ('RECEIVED','PROCESSED');
      CREATE TABLE IF NOT EXISTS workrooms (
        task_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, parent_channel_id TEXT NOT NULL,
        thread_name TEXT NOT NULL, state TEXT NOT NULL, bootstrap_message_id TEXT,
        created_at TEXT NOT NULL, archived_at TEXT, last_synced_at TEXT NOT NULL, last_reason TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_workrooms_state ON workrooms(state,last_synced_at);
      CREATE TABLE IF NOT EXISTS task_teams (
        task_id TEXT PRIMARY KEY, task_type TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
        current_sequence INTEGER, composition_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS task_roles (
        task_id TEXT NOT NULL, role TEXT NOT NULL, sequence INTEGER NOT NULL, assigned_agent TEXT,
        status TEXT NOT NULL, routing_reason TEXT, revision_round INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, result TEXT, evidence_json TEXT NOT NULL,
        PRIMARY KEY(task_id,sequence), UNIQUE(task_id,role), FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_roles_status ON task_roles(task_id,status,sequence);
      CREATE TABLE IF NOT EXISTS routing_decisions (
        decision_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, sequence INTEGER NOT NULL,
        selected_agent TEXT, reason_code TEXT NOT NULL, selected_reasons_json TEXT NOT NULL,
        rejected_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_routing_decisions_task ON routing_decisions(task_id,sequence,created_at);
      CREATE TABLE IF NOT EXISTS memory_entries (
        memory_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, project_id TEXT, agent_id TEXT,
        role TEXT, content TEXT NOT NULL, tags_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idea_candidates (
        idea_id TEXT PRIMARY KEY, source_message_id TEXT, title TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL, project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_catalog (
        model_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, provider TEXT NOT NULL, model_name TEXT NOT NULL,
        model_alias TEXT, display_name TEXT NOT NULL, available INTEGER NOT NULL, verified INTEGER NOT NULL,
        verification_level TEXT NOT NULL, override_supported INTEGER NOT NULL, override_value TEXT NOT NULL,
        resume_override_supported INTEGER NOT NULL, observed_actual_model TEXT, source TEXT NOT NULL,
        last_verified_at TEXT NOT NULL, metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_catalog_agent ON model_catalog(agent_id,available,verification_level);
      CREATE TABLE IF NOT EXISTS free_model_pool (
        registry_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_name TEXT NOT NULL,
        route_class TEXT NOT NULL, capabilities_json TEXT NOT NULL, automatic_routing INTEGER NOT NULL,
        state TEXT NOT NULL, probe_attempts INTEGER NOT NULL DEFAULT 0, max_probe_attempts INTEGER NOT NULL DEFAULT 1,
        last_probe_at TEXT, next_probe_at TEXT, last_error_code TEXT, last_error_detail TEXT,
        source TEXT NOT NULL, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(provider_id, model_name)
      );
      CREATE INDEX IF NOT EXISTS idx_free_model_pool_state ON free_model_pool(provider_id,state,route_class);
      CREATE TABLE IF NOT EXISTS agent_model_preferences (
        agent_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, selected_model TEXT NOT NULL, provider TEXT NOT NULL,
        selected_at TEXT NOT NULL, source TEXT NOT NULL, verification_state TEXT NOT NULL,
        FOREIGN KEY(model_id) REFERENCES model_catalog(model_id)
      );
      CREATE TABLE IF NOT EXISTS model_tier_mappings (
        agent_id TEXT NOT NULL, role_scope TEXT NOT NULL DEFAULT '*', model_tier TEXT NOT NULL, model_catalog_id TEXT NOT NULL,
        provider TEXT NOT NULL, verification_level TEXT NOT NULL, enabled INTEGER NOT NULL, source TEXT NOT NULL,
        reason TEXT NOT NULL, last_verified_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,role_scope,model_tier), FOREIGN KEY(model_catalog_id) REFERENCES model_catalog(model_id)
      );
      CREATE TABLE IF NOT EXISTS model_routing_decisions (
        decision_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT NOT NULL,
        complexity TEXT NOT NULL, requested_tier TEXT NOT NULL, selected_tier TEXT, model_catalog_id TEXT,
        requested_model TEXT, provider TEXT, effective_model TEXT, reason TEXT NOT NULL, fallback INTEGER NOT NULL,
        status TEXT NOT NULL, mismatch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id), FOREIGN KEY(model_catalog_id) REFERENCES model_catalog(model_id)
      );
      CREATE INDEX IF NOT EXISTS idx_model_routing_task ON model_routing_decisions(task_id,role,created_at);
      CREATE TABLE IF NOT EXISTS model_failure_events (
        failure_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT NOT NULL,
        model_tier TEXT NOT NULL, model_catalog_id TEXT NOT NULL, failure_category TEXT NOT NULL,
        reason TEXT NOT NULL, evidence_json TEXT NOT NULL, occurrence INTEGER NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id), FOREIGN KEY(model_catalog_id) REFERENCES model_catalog(model_id)
      );
      CREATE TABLE IF NOT EXISTS model_escalations (
        escalation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT NOT NULL,
        from_tier TEXT NOT NULL, to_tier TEXT, from_model TEXT NOT NULL, to_model TEXT,
        failure_category TEXT NOT NULL, reason TEXT NOT NULL, attempt INTEGER NOT NULL,
        evidence_json TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_model_escalations_task ON model_escalations(task_id,role,created_at);
      CREATE TABLE IF NOT EXISTS model_availability_health (
        agent_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        availability_state TEXT NOT NULL, last_failure_class TEXT, last_failure_at TEXT,
        cooldown_until TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,provider,model)
      );
      CREATE TABLE IF NOT EXISTS model_fallback_attempts (
        fallback_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT NOT NULL,
        original_model TEXT NOT NULL, original_provider TEXT NOT NULL, failure_class TEXT NOT NULL,
        fallback_model TEXT, fallback_provider TEXT, fallback_attempted INTEGER NOT NULL,
        fallback_result TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_fallback_attempts_task ON model_fallback_attempts(task_id,role,agent_id,created_at);
      CREATE TABLE IF NOT EXISTS discussion_topics (
        topic_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, topic TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL, current_round INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL,
        consensus TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(task_id,fingerprint), FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_discussion_topics_task ON discussion_topics(task_id,status,updated_at);
      CREATE TABLE IF NOT EXISTS discussion_events (
        event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, topic_id TEXT NOT NULL, event_type TEXT NOT NULL,
        sender_agent TEXT NOT NULL, recipient_agent TEXT NOT NULL, sender_role TEXT NOT NULL, recipient_role TEXT NOT NULL,
        discussion_round INTEGER NOT NULL, parent_event_id TEXT, content TEXT NOT NULL, next_owner TEXT NOT NULL,
        status TEXT NOT NULL, fingerprint TEXT NOT NULL, discord_message_id TEXT, created_at TEXT NOT NULL,
        UNIQUE(task_id,topic_id,event_type,sender_agent,recipient_agent,discussion_round,fingerprint),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id), FOREIGN KEY(topic_id) REFERENCES discussion_topics(topic_id)
      );
      CREATE INDEX IF NOT EXISTS idx_discussion_events_topic ON discussion_events(topic_id,discussion_round,created_at);
      CREATE TABLE IF NOT EXISTS meeting_sessions (
        session_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
        status TEXT NOT NULL, decision_type TEXT, decision_body TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS meeting_memberships (
        session_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT, state TEXT NOT NULL,
        capability_json TEXT NOT NULL, joined_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id,agent_id), FOREIGN KEY(session_id) REFERENCES meeting_sessions(session_id)
      );
      CREATE TABLE IF NOT EXISTS meeting_events (
        event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
        sender TEXT NOT NULL, recipient TEXT NOT NULL, body TEXT NOT NULL, metadata_json TEXT NOT NULL,
        discord_message_id TEXT, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES meeting_sessions(session_id), FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_meeting_events_session ON meeting_events(session_id,created_at);
      CREATE TABLE IF NOT EXISTS expert_requests (
        request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, requested_role TEXT NOT NULL, requested_capabilities_json TEXT NOT NULL,
        reason TEXT NOT NULL, evidence_json TEXT NOT NULL, requesting_agent TEXT NOT NULL, urgency TEXT NOT NULL,
        scope_json TEXT NOT NULL, status TEXT NOT NULL, selected_agent TEXT, selected_tier TEXT, selected_model TEXT,
        provider TEXT, return_role_sequence INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_expert_requests_task ON expert_requests(task_id,status,created_at);
      CREATE TABLE IF NOT EXISTS expert_memberships (
        task_id TEXT NOT NULL, role TEXT NOT NULL, agent_id TEXT NOT NULL, request_id TEXT NOT NULL,
        status TEXT NOT NULL, joined_at TEXT NOT NULL, join_reason TEXT NOT NULL, requested_by TEXT NOT NULL,
        scope_json TEXT NOT NULL, completed_at TEXT,
        PRIMARY KEY(task_id,role), FOREIGN KEY(task_id) REFERENCES tasks(task_id), FOREIGN KEY(request_id) REFERENCES expert_requests(request_id)
      );
      CREATE TABLE IF NOT EXISTS performance_task_records (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data_class TEXT NOT NULL, task_type TEXT,
        complexity TEXT, final_status TEXT NOT NULL, required_roles_json TEXT NOT NULL, team_size INTEGER NOT NULL,
        started_at TEXT, completed_at TEXT, duration_ms INTEGER, attempt_count INTEGER NOT NULL,
        revision_count INTEGER NOT NULL, discussion_rounds INTEGER NOT NULL, expert_invite_count INTEGER NOT NULL,
        human_gate_count INTEGER NOT NULL, model_escalation_count INTEGER NOT NULL, final_verdict TEXT,
        failure_category TEXT, evidence_sources_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_perf_task_class ON performance_task_records(data_class,final_status,completed_at);
      CREATE TABLE IF NOT EXISTS performance_role_records (
        task_id TEXT NOT NULL, role TEXT NOT NULL, sequence INTEGER NOT NULL, agent_id TEXT, provider TEXT,
        requested_model TEXT, effective_model TEXT, model_tier TEXT, status TEXT NOT NULL,
        started_at TEXT, completed_at TEXT, duration_ms INTEGER, attempts INTEGER NOT NULL, revisions INTEGER NOT NULL,
        result_type TEXT, failure_category TEXT, context_failure TEXT, workspace_conflict INTEGER NOT NULL,
        human_intervention INTEGER NOT NULL, selected_reason TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_tokens INTEGER, reported_cost REAL, usage_source TEXT, cost_known INTEGER NOT NULL,
        subscription_based INTEGER, provider_based INTEGER, evidence_sources_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(task_id,role,sequence), FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_perf_role_agent ON performance_role_records(agent_id,role,status,completed_at);
      CREATE TABLE IF NOT EXISTS performance_events (
        logical_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, metric_type TEXT NOT NULL, role TEXT,
        agent_id TEXT, provider TEXT, model TEXT, status TEXT, metrics_json TEXT NOT NULL,
        evidence_source TEXT NOT NULL, evidence_ref TEXT NOT NULL, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_perf_events_task ON performance_events(task_id,metric_type,occurred_at);
      CREATE TABLE IF NOT EXISTS manager_inference_attempts (
        correlation_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, trigger_id TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS manager_proposal_consumptions (
        observation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, acceptance_id TEXT NOT NULL,
        consumer TEXT NOT NULL, status TEXT NOT NULL, claimed_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_dispatch_recoveries (
        recovery_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE,
        prior_assignment TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS execution_binding_reconciliations (
        reconciliation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
        old_binding_json TEXT NOT NULL, new_binding_json TEXT NOT NULL,
        reason TEXT NOT NULL, status TEXT NOT NULL, result TEXT,
        created_at TEXT NOT NULL, completed_at TEXT,
        UNIQUE(task_id,old_binding_json,new_binding_json),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS external_task_inbox (
        source_message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, source_channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL, recipient_id TEXT NOT NULL, state TEXT NOT NULL,
        ack_message_id TEXT, registered_at TEXT NOT NULL, workroom_at TEXT, agent_ack_at TEXT,
        completed_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_external_task_inbox_state ON external_task_inbox(state,updated_at);
      CREATE TABLE IF NOT EXISTS office_events (
        event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL, task_id TEXT, project_id TEXT, session_id TEXT,
        summary TEXT NOT NULL, evidence_json TEXT NOT NULL, suspected_owner TEXT,
        severity TEXT NOT NULL, recommended_next_step TEXT NOT NULL,
        can_continue_other_work INTEGER NOT NULL, question TEXT,
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_office_events_open_fingerprint
        ON office_events(fingerprint) WHERE status IN ('OPEN','WAITING');
      CREATE INDEX IF NOT EXISTS idx_office_events_status
        ON office_events(status,created_at);
      CREATE TABLE IF NOT EXISTS owner_decisions (
        decision_id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
        source_agent TEXT NOT NULL, task_id TEXT, incident_id TEXT,
        question TEXT NOT NULL, context TEXT NOT NULL, evidence_json TEXT NOT NULL,
        recommendation TEXT NOT NULL, alternatives_json TEXT NOT NULL,
        default_safe_action TEXT NOT NULL, blocks_json TEXT NOT NULL, continues_json TEXT NOT NULL,
        urgency TEXT NOT NULL, answer TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_owner_decisions_status
        ON owner_decisions(status,urgency,created_at);
      CREATE TABLE IF NOT EXISTS human_feedback (
        feedback_id TEXT PRIMARY KEY, type TEXT NOT NULL, raw_text TEXT NOT NULL,
        classification_source TEXT NOT NULL, task_id TEXT, source_channel_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL UNIQUE, source_author_id TEXT NOT NULL,
        related_inbox_item_id TEXT, applied INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_human_feedback_type ON human_feedback(type,created_at);
      CREATE TABLE IF NOT EXISTS worker_friction (
        friction_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        has_friction INTEGER NOT NULL, type TEXT, severity TEXT, problem TEXT, impact TEXT, suggestion TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_friction_task ON worker_friction(task_id,created_at);
      CREATE TABLE IF NOT EXISTS improvement_backlog (
        backlog_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
        source TEXT NOT NULL, frequency INTEGER NOT NULL, severity_score INTEGER NOT NULL,
        owner_impact INTEGER NOT NULL, worker_impact INTEGER NOT NULL, automation_impact INTEGER NOT NULL,
        estimated_fix_cost TEXT NOT NULL, rank_score REAL NOT NULL, status TEXT NOT NULL,
        evidence_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_protocol_one_completion
        ON protocol_events(task_id,event_type) WHERE event_type='COMPLETION';
      CREATE INDEX IF NOT EXISTS idx_improvement_backlog_rank ON improvement_backlog(status,rank_score DESC);
      CREATE TABLE IF NOT EXISTS continuation_watches (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        start_deadline_ms INTEGER NOT NULL, progress_deadline_ms INTEGER NOT NULL,
        result_deadline_ms INTEGER NOT NULL, max_recoveries INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_continuation_watches_project ON continuation_watches(project_id,enabled,task_id);
      CREATE TABLE IF NOT EXISTS continuation_recovery_state (
        task_id TEXT NOT NULL, role_sequence INTEGER NOT NULL, revision_round INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0, wake_in_progress INTEGER NOT NULL DEFAULT 0,
        classification TEXT NOT NULL, last_reason TEXT NOT NULL, last_action TEXT NOT NULL,
        last_worker TEXT, last_process_id TEXT, task_version TEXT NOT NULL,
        last_wake_at TEXT, capacity_wait_started_at TEXT, cancel_requested_at TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(task_id,role_sequence,revision_round),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_continuation_recovery_action ON continuation_recovery_state(last_action,updated_at);
      CREATE TABLE IF NOT EXISTS continuation_intents (
        intent_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT,
        role TEXT NOT NULL, revision_round INTEGER NOT NULL,
        instruction TEXT NOT NULL, evidence_references_json TEXT NOT NULL,
        authority_source TEXT NOT NULL, authority_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id,run_id,role,revision_round),
        FOREIGN KEY(task_id) REFERENCES tasks(task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_continuation_intents_boundary
        ON continuation_intents(task_id,role,revision_round,created_at);
    `);
    this.ensureColumn("delivery_records", "event_type", "TEXT");
    this.ensureColumn("delivery_records", "sender", "TEXT");
    this.ensureColumn("delivery_records", "recipient", "TEXT");
    this.ensureColumn("delivery_records", "reported_by", "TEXT");
    this.ensureColumn("delivery_records", "original_agent", "TEXT");
    this.ensureColumn("delivery_records", "fallback_reason", "TEXT");
    this.ensureColumn("delivery_records", "inbound_message_id", "TEXT");
    this.ensureColumn("delivery_records", "received_at", "TEXT");
    this.ensureColumn("delivery_records", "processed_at", "TEXT");
    this.ensureColumn("tasks", "task_type", "TEXT");
    this.ensureColumn("tasks", "required_roles_json", "TEXT");
    this.ensureColumn("tasks", "agent_overrides_json", "TEXT");
    this.ensureColumn("tasks", "team_mode", "TEXT");
    this.ensureColumn("tasks", "current_role_sequence", "INTEGER");
    this.ensureColumn("tasks", "completion_candidate", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("continuation_recovery_state", "capacity_wait_started_at", "TEXT");
    this.ensureColumn("continuation_recovery_state", "cancel_requested_at", "TEXT");
    this.ensureColumn("sessions", "requested_model", "TEXT");
    this.ensureColumn("sessions", "effective_model", "TEXT");
    this.ensureColumn("sessions", "provider", "TEXT");
    this.ensureColumn("sessions", "model_verification_source", "TEXT");
    this.ensureColumn("tasks", "complexity", "TEXT");
    this.ensureColumn("tasks", "complexity_reasons_json", "TEXT");
    this.ensureColumn("tasks", "complexity_source", "TEXT");
    this.ensureColumn("tasks", "model_tier_override", "TEXT");
    this.ensureColumn("tasks", "model_override", "TEXT");
    this.ensureColumn("tasks", "data_class", "TEXT");
    this.ensureColumn("tasks", "data_class_source", "TEXT");
    this.ensureColumn("tasks", "execution_hold", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "execution_contract_json", "TEXT");
    this.ensureColumn("tasks", "authority_metadata_json", "TEXT");
    this.ensureColumn("agents", "agent_type", "TEXT");
    this.ensureColumn("agents", "discord_mention", "TEXT");
    this.ensureColumn("agents", "runtime_adapter", "TEXT");
    this.ensureColumn("agents", "available_models_json", "TEXT");
    this.ensureColumn("external_task_inbox", "execution_hold", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("human_feedback", "approval_decision", "TEXT");
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1200,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1201,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1202,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1203,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1204,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1205,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1206,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1207,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1208,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1209,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1210,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1211,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1212,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1213,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1214,?)").run(this.now());
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1215,?)").run(this.now());
    const workerSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='worker_processes'").get() as { sql: string } | undefined;
    if (workerSchema?.sql && /task_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(workerSchema.sql)) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE worker_processes RENAME TO worker_processes_legacy;
        CREATE TABLE worker_processes (
          process_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
          pid INTEGER NOT NULL, working_dir TEXT NOT NULL, session_id TEXT, started_at TEXT NOT NULL,
          last_seen TEXT NOT NULL, exit_code INTEGER, status TEXT NOT NULL, log_path TEXT NOT NULL
        );
        INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path)
          SELECT process_id,agent_id,task_id,1,pid,working_dir,session_id,started_at,last_seen,exit_code,status,log_path FROM worker_processes_legacy;
        DROP TABLE worker_processes_legacy;
        CREATE INDEX idx_worker_processes_task ON worker_processes(task_id, started_at);
        COMMIT;
      `);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  now(): string { return new Date().toISOString(); }
  close(): void { this.db.close(); }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  upsertRuntimeState(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO runtime_state(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), this.now());
  }

  getRuntimeState<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM runtime_state WHERE key=?").get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : undefined;
  }

  run(sql: string, ...params: SQLInputValue[]): void { this.db.prepare(sql).run(...params); }
}
