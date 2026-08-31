import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Store } from "../storage/database.js";
import type { TaskRepository } from "../tasks/repository.js";
import { captureExecutionBinding, type ExecutionBinding } from "./correction.js";

export interface BindingReconciliationResult { reconciliationId: string; taskId: string; oldBaseSha: string; newBaseSha: string; status: "SUCCEEDED"; }

export class ExecutionBindingReconciler {
  constructor(private readonly store: Store, private readonly tasks: TaskRepository) {}

  reconcile(taskId: string, reconciliationId: string, expectedOldBaseSha: string, approvedNewSha: string, reason: string): BindingReconciliationResult {
    if (!/^[0-9a-f]{40}$/i.test(expectedOldBaseSha) || !/^[0-9a-f]{40}$/i.test(approvedNewSha)) throw classified("BINDING_RECONCILIATION_SHA_INVALID");
    const task = this.tasks.get(taskId); if (!task) throw classified("BINDING_RECONCILIATION_TASK_NOT_FOUND");
    const duplicate = this.store.db.prepare("SELECT 1 FROM execution_binding_reconciliations WHERE task_id=? AND json_extract(old_binding_json,'$.base_sha')=? AND json_extract(new_binding_json,'$.base_sha')=? LIMIT 1").get(taskId, expectedOldBaseSha, approvedNewSha);
    if (duplicate) throw classified("BINDING_RECONCILIATION_DUPLICATE");
    if (["PASS", "COMPLETED", "FAIL", "CANCELLED"].includes(task.status)) throw classified("BINDING_RECONCILIATION_TERMINAL_TASK");
    if (task.executionHold) throw classified("BINDING_RECONCILIATION_EXECUTION_HOLD");
    if (this.store.db.prepare("SELECT 1 FROM worker_processes WHERE task_id=? AND status IN ('RUNNING','STARTED','BUSY') LIMIT 1").get(taskId)) throw classified("BINDING_RECONCILIATION_ACTIVE_WORKER");
    const key = `task:execution_binding:${taskId}`;
    const row = this.store.db.prepare("SELECT value_json FROM runtime_state WHERE key=?").get(key) as { value_json: string } | undefined;
    if (!row) throw classified("BINDING_RECONCILIATION_BINDING_MISSING");
    const oldBinding = JSON.parse(row.value_json) as ExecutionBinding;
    if (oldBinding.task_id !== taskId || oldBinding.base_sha !== expectedOldBaseSha) throw classified("BINDING_RECONCILIATION_EXPECTED_OLD_MISMATCH");
    if (path.resolve(oldBinding.worktree) !== path.resolve(task.workspace)) throw classified("BINDING_RECONCILIATION_WORKSPACE_MISMATCH");
    const actual = captureExecutionBinding(task);
    if (actual.task_id !== taskId || actual.branch !== oldBinding.branch || path.resolve(actual.worktree) !== path.resolve(oldBinding.worktree)) throw classified("BINDING_RECONCILIATION_REPOSITORY_MISMATCH");
    if (actual.base_sha !== approvedNewSha) throw classified("BINDING_RECONCILIATION_APPROVED_HEAD_MISMATCH");
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", expectedOldBaseSha, approvedNewSha], { cwd: task.workspace, windowsHide: true, encoding: "utf8", timeout: 15_000 });
    if (ancestry.status !== 0) throw classified("BINDING_RECONCILIATION_NOT_DESCENDANT");
    const dirty = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: task.workspace, windowsHide: true, encoding: "utf8", timeout: 15_000 });
    if (dirty.status !== 0 || dirty.stdout.trim()) throw classified("BINDING_RECONCILIATION_DIRTY_WORKTREE");
    const newBinding: ExecutionBinding = { ...oldBinding, base_sha: approvedNewSha };
    const now = this.store.now();
    try {
      this.store.transaction(() => {
        this.store.db.prepare("INSERT INTO execution_binding_reconciliations(reconciliation_id,task_id,old_binding_json,new_binding_json,reason,status,result,created_at,completed_at) VALUES(?,?,?,?,?,'SUCCEEDED','BINDING_RECONCILED',?,?)")
          .run(reconciliationId, taskId, JSON.stringify(oldBinding), JSON.stringify(newBinding), reason, now, now);
        this.store.upsertRuntimeState(key, newBinding);
      });
    } catch { throw classified("BINDING_RECONCILIATION_DUPLICATE"); }
    return { reconciliationId, taskId, oldBaseSha: expectedOldBaseSha, newBaseSha: approvedNewSha, status: "SUCCEEDED" };
  }
}

function classified(classification: string): Error & { classification: string } { return Object.assign(new Error(classification), { classification }); }
