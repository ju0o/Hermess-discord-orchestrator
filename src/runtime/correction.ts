import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentId, Role, TaskRecord } from "../domain/types.js";
import type { Store } from "../storage/database.js";

export const VALIDATION_TYPES = ["TYPECHECK", "TEST", "BUILD"] as const;
export type ValidationType = (typeof VALIDATION_TYPES)[number];
export type ValidationStatus = "PASS" | "FAIL" | "SKIPPED" | "UNKNOWN";

export interface ValidationEvidence {
  task_id?: string;
  type: ValidationType;
  command: string;
  exit_code: number | null;
  status: ValidationStatus;
  timestamp: string;
  worktree: string;
  branch: string;
  head_sha?: string;
  base_sha?: string;
  source?: "EXECUTED" | "REUSED";
  /** Durable event that proves this observation. Required when source=REUSED. */
  source_event_id?: string;
  source_execution_id?: string;
  source_process?: string;
  source_log?: string;
  attempt?: number;
  worker_id?: AgentId;
  role?: Role;
  product_digest?: string;
}

export interface ExecutionBinding { task_id: string; worktree: string; branch: string; base_sha: string; }

export function gitValue(worktree: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function captureExecutionBinding(task: Pick<TaskRecord, "taskId" | "workspace">): ExecutionBinding {
  return { task_id: task.taskId, worktree: path.resolve(task.workspace), branch: gitValue(task.workspace, "branch", "--show-current"), base_sha: gitValue(task.workspace, "rev-parse", "HEAD") };
}

export function verifyExecutionBinding(expected: ExecutionBinding, actual: ExecutionBinding): { ok: true } | { ok: false; reason: string } {
  const mismatches = (["task_id", "worktree", "branch", "base_sha"] as const).filter((key) => {
    const left = key === "worktree" ? path.resolve(expected[key]) : expected[key];
    const right = key === "worktree" ? path.resolve(actual[key]) : actual[key];
    return left !== right;
  });
  return mismatches.length ? { ok: false, reason: `EXECUTION_BINDING_MISMATCH:${mismatches.join(",")}` } : { ok: true };
}

export function canonicalValidationEvidence(input: ValidationEvidence): ValidationEvidence {
  if (!VALIDATION_TYPES.includes(input.type)) throw new Error("VALIDATION_TYPE_INVALID");
  return { ...input, command: input.command.trim(), worktree: path.resolve(input.worktree), timestamp: new Date(input.timestamp).toISOString(), source: input.source ?? "EXECUTED" };
}

export function captureProductDigest(worktree: string): string {
  const parts = [gitValue(worktree, "rev-parse", "HEAD"), gitValue(worktree, "status", "--porcelain=v1"), gitValue(worktree, "diff", "--binary", "HEAD")];
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export interface ValidationEvidenceBinding { taskId: string; attempt: number; workerId: AgentId; role: Role; worktree: string; }
export function evidenceMatchesExecution(item: ValidationEvidence, expected: ValidationEvidenceBinding): boolean {
  return item.task_id === expected.taskId && item.attempt === expected.attempt && item.worker_id === expected.workerId && item.role === expected.role
    && path.resolve(item.worktree) === path.resolve(expected.worktree) && item.status === "PASS"
    && Boolean(item.source_execution_id && item.source_process && item.source_log)
    && Boolean(item.product_digest) && item.product_digest === captureProductDigest(expected.worktree);
}

export function reuseValidationEvidence(evidence: readonly ValidationEvidence[], required: readonly ValidationType[], worktree: string, branch: string, baseSha?: string): ValidationEvidence[] {
  return evidence.filter((item) => required.includes(item.type) && item.status === "PASS" && path.resolve(item.worktree) === path.resolve(worktree) && item.branch === branch && (!baseSha || !item.base_sha || item.base_sha === baseSha))
    .map((item) => ({ ...item, source: "REUSED" as const }));
}

export function actionableFindings(findings: readonly string[], fallback = "Review finding was not provided"): string[] {
  const kept = findings.map(String).map((value) => value.trim()).filter(Boolean);
  return kept.length ? kept : [fallback];
}

export interface HeartbeatInput { runStartedAt: string; wallLimitSeconds: number; task?: Pick<TaskRecord, "taskId" | "status" | "workspace" | "assignedAgent" | "role">; phase: string; activeWorker?: AgentId; workerRole?: Role; processStartedAt?: string; processLastSeen?: string; latestProgress?: string; blocker?: string; ownerActionRequired: boolean; ownerActionReason?: string; nextTransition: string; nextTimeoutSeconds: number; productDiff?: string; jutellMode: JuTellMode; }
export type JuTellMode = "MCP" | "SKILL" | "MANUAL_OBSERVER" | "NOT_RUNNING";

export function renderHeartbeat(input: HeartbeatInput, now = new Date()): string {
  const elapsed = Math.max(0, Math.floor((now.getTime() - Date.parse(input.runStartedAt)) / 1000));
  return [`RUN elapsed=${elapsed}s / wall_limit=${input.wallLimitSeconds}s`, `ACTIVE_TASK=${input.task?.taskId ?? "NONE"}`, `PHASE=${input.phase}`, `ACTIVE_WORKER=${input.activeWorker ?? "NONE"}`, `ROLE=${input.workerRole ?? input.task?.role ?? "NONE"}`, `PROCESS started_at=${input.processStartedAt ?? "NONE"} last_seen=${input.processLastSeen ?? "NONE"}`, `LATEST_MEANINGFUL_PROGRESS=${input.latestProgress ?? "NONE"}`, `CURRENT_BLOCKER=${input.blocker ?? "NONE"}`, `OWNER_ACTION_REQUIRED=${input.ownerActionRequired ? "yes" : "no"}${input.ownerActionReason ? ` reason=${input.ownerActionReason}` : ""}`, `NEXT_EXPECTED_TRANSITION=${input.nextTransition} timeout=${input.nextTimeoutSeconds}s`, `PRODUCT_DIFF=${input.productDiff ?? "UNKNOWN"}`, `JUTELL_MODE=${input.jutellMode}`].join(" | ");
}

export function recordHeartbeat(store: Store, input: HeartbeatInput, meaningful = true): string {
  const rendered = renderHeartbeat(input);
  store.upsertRuntimeState("runtime:heartbeat", { rendered, meaningful, at: store.now(), ...input });
  return rendered;
}

export interface JuTellReceipt { invocation_id: string; timestamp: string; input_ref: string; output_ref: string; mode: JuTellMode; }
export function recordJuTellReceipt(store: Store, receipt: JuTellReceipt): void {
  if (receipt.mode === "NOT_RUNNING") throw new Error("JUTELL_RECEIPT_NOT_RUNNING");
  store.upsertRuntimeState(`jutell:invocation:${receipt.invocation_id}`, receipt);
}

export function convergeDurableFailure(store: Store, taskId: string, reason: string): void {
  const now = store.now();
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db.prepare("UPDATE task_roles SET status='BLOCKED',result=?,completed_at=? WHERE task_id=? AND status IN ('ACTIVE','ASSIGNED','PENDING')").run(reason, now, taskId);
    store.db.prepare("UPDATE task_teams SET status='BLOCKED',updated_at=? WHERE task_id=?").run(now, taskId);
    store.db.prepare("UPDATE tasks SET status='FAIL',result=?,completed_at=?,updated_at=? WHERE task_id=? AND status NOT IN ('PASS','FAIL','CANCELLED')").run(reason, now, now, taskId);
    store.db.prepare("UPDATE worker_processes SET status='LOST',last_seen=? WHERE task_id=? AND status IN ('RUNNING','STARTED','BUSY')").run(now, taskId);
    store.db.exec("COMMIT");
  } catch (error) { try { store.db.exec("ROLLBACK"); } catch {} throw error; }
}

export function boundedRedispatchAllowed(retryCount: number, maxRetries: number): boolean { return retryCount < maxRetries; }

export function deterministicGitPreflight(worktree: string): Record<string, string> {
  const run = (...args: string[]) => { const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8", windowsHide: true, timeout: 15_000 }); return (result.stdout || result.stderr || "").trim(); };
  return { status: run("status", "--short"), diff_stat: run("diff", "--stat"), diff_numstat: run("diff", "--numstat"), eol: run("ls-files", "--eol"), ignored_untracked: run("status", "--short", "--ignored") };
}
