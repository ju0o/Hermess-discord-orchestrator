import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AuthorityDecision } from "../authority/delegatedAuthority.js";
import type { Store } from "../storage/database.js";
import { recordContinuationIntent, type ContinuationIntentInput } from "./continuationIntent.js";
import { continuationIntentForDispatch } from "./continuationIntent.js";
import type { Role } from "../domain/types.js";

export type RunBudgetExpiry = "WALL_CLOCK_BUDGET" | "NO_PROGRESS_BUDGET";
export interface RunBudgetState {
  runId: string; taskId: string; projectId: string; startedAt: string; deadlineAt: string; budgetDurationMs: number;
  noProgressBudgetMs: number; lastProgressAt: string; lastProgressFingerprint: string; status: "ACTIVE" | "EXHAUSTED";
  expiredAt?: string; expiredBy?: RunBudgetExpiry;
  /**
   * Baseline/last-observed digest of the currently RUNNING process's own
   * Product worktree (see the DDF02 Retry 2 progress-observation correction
   * in `evaluate()` below). Undefined until the run's first observation of a
   * RUNNING process; never itself treated as progress -- only a later CHANGE
   * from this value is.
   */
  lastProductDiffFingerprint?: string;
  /**
   * Timestamp of the last OBSERVED change to `lastProductDiffFingerprint`.
   * Persisted (not merely computed fresh each call) so it stays a stable,
   * comparable candidate on every subsequent `evaluate()` -- otherwise, once
   * a later poll finds the worktree unchanged since the last one, this
   * signal would silently vanish from the candidate race and a real, already
   * -credited refresh could regress back to an older, stale one (e.g. the
   * process's own start time).
   */
  lastProductDiffAt?: string;
  /** Semantic tool activities already credited for the current bounded run. */
  readOnlyActivityFingerprints?: string[];
  /** Last durable Reviewer/QA tool activity observed in the owning process log. */
  lastReadOnlyActivityAt?: string;
  lastReadOnlyActivityFingerprint?: string;
}

export interface RunBudgetRearmRequest {
  requestId: string; taskId: string; projectId: string; previousRunId: string; budgetDurationMs: number;
  noProgressBudgetMs: number; authority: AuthorityDecision; actor: "OWNER" | "OPERATOR"; reason: string;
  continuationIntent?: ContinuationIntentInput;
}

const key = (taskId: string) => `run_budget:${taskId}`;
const runKey = (taskId: string, runId: string) => `run_budget_run:${taskId}:${runId}`;
const MEANINGFUL = ["ACK", "RESULT", "REVIEW", "QA_RESULT", "VERDICT", "COMPLETE", "REVISION_REQUEST"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * A deterministic, Task-bound fingerprint of a worktree's uncommitted state,
 * used only to detect a genuine CHANGE (see the Product-diff progress signal
 * in `evaluate()`). Deliberately narrower than `deterministicGitPreflight`
 * (correction.ts): this reads stdout only and never falls back to stderr --
 * an incidental, non-deterministic warning on stderr (e.g. Windows git's
 * "LF will be replaced by CRLF" notice, which does not reliably repeat
 * across identical calls) must never itself look like a Product change.
 */
function productDiffSignature(worktree: string): string {
  const run = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: worktree, encoding: "utf8", windowsHide: true, timeout: 15_000 });
    return result.status === 0 ? result.stdout : "";
  };
  return digest(`STATUS|${run("status", "--short")}|NUMSTAT|${run("diff", "--numstat")}`);
}

/**
 * True when `observed` (the command a logged tool call actually ran) is, or
 * chains, the exact Task-declared validation command `declared` -- e.g.
 * `"cd app && npm run build"` matches `"npm run build"`. Deliberately exact
 * per segment (trimmed) rather than a substring/fuzzy match, so an unrelated
 * command that merely mentions a validation command's name cannot borrow
 * its "still executing" credibility.
 */
function commandMatchesValidation(observed: string, declared: string): boolean {
  const target = declared.trim();
  if (!target) return false;
  const normalized = observed.trim();
  return normalized === target || normalized.split(/&&|;/).some((segment) => segment.trim() === target);
}

const VOLATILE_ACTIVITY_KEYS = new Set([
  "id", "callid", "call_id", "messageid", "message_id", "sessionid", "session_id", "thread_id",
  "timestamp", "created_at", "started_at", "completed_at", "duration", "duration_ms", "output", "result", "status",
]);

function stableActivityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableActivityValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([name]) => !VOLATILE_ACTIVITY_KEYS.has(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => [name, stableActivityValue(child)]));
}

function activityPayloads(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) { for (const child of value) activityPayloads(child, found); return found; }
  if (!value || typeof value !== "object") return found;
  const object = value as Record<string, unknown>;
  const type = String(object.type ?? "").toLowerCase().replace(/[.-]/g, "_");
  const item = object.item && typeof object.item === "object" ? object.item as Record<string, unknown> : undefined;
  const itemType = String(item?.type ?? "").toLowerCase();
  if (["tool_use", "tool_call", "tool_start", "tool_result"].includes(type)) found.push(object.part ?? object);
  else if (["item_started", "item_completed"].includes(type) && /(?:command_execution|mcp_tool_call|file_read|tool)/.test(itemType)) found.push(item);
  const event = object.event && typeof object.event === "object" ? object.event as Record<string, unknown> : undefined;
  const eventType = String(event?.type ?? "").toLowerCase().replace(/[.-]/g, "_");
  if (["tool_use", "tool_call", "tool_start", "tool_result"].includes(eventType)) found.push(event);
  for (const child of Object.values(object)) activityPayloads(child, found);
  return found;
}

/**
 * Extracts the shell command text a tool-call payload asks to run, when it
 * plausibly represents one (e.g. an OpenCode `{tool:"bash",state:{input:
 * {command}}}` part, or a Codex-shaped `{command}`/`{input:{command}}`
 * item). Used only to recognize a Task's own declared `validation` commands
 * (see `validationInFlight` in `evaluate()`) -- never to classify arbitrary
 * prose, so this stays a plain structural field lookup.
 */
function extractCommand(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const object = payload as Record<string, unknown>;
  const state = object.state && typeof object.state === "object" ? object.state as Record<string, unknown> : undefined;
  const input = [state?.input, object.input].find((candidate) => candidate && typeof candidate === "object") as Record<string, unknown> | undefined;
  const raw = input?.command ?? object.command;
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/**
 * Reads the existing per-process durable stream log. Only structured tool or
 * command boundaries qualify; prose, heartbeat timestamps, model-thinking,
 * and generic step events do not. Identity excludes provider call IDs and
 * timestamps, so replaying the same action cannot earn another refresh.
 */
function readOnlyActivities(logPath: string, processId: string): Array<{ at: string; fp: string; command: string | undefined }> {
  if (!logPath || !existsSync(logPath)) return [];
  let text: string;
  try { text = readFileSync(logPath, "utf8"); } catch { return []; }
  const chunks = [...text.matchAll(/^\[([^\]]+)] (stdout|stderr): ([\s\S]*?)(?=^\[[^\]]+] (?:stdout|stderr): |(?![\s\S]))/gm)];
  const activities: Array<{ at: string; fp: string; command: string | undefined }> = [];
  const pending = new Map<string, string>();
  const inspect = (line: string, at: string) => {
    const start = line.indexOf("{"); if (start < 0) return;
    let parsed: unknown; try { parsed = JSON.parse(line.slice(start)); } catch { return; }
    for (const payload of activityPayloads(parsed)) {
      const semantic = JSON.stringify(stableActivityValue(payload));
      if (semantic === "{}" || semantic === "[]" || semantic === "null") continue;
      activities.push({ at, fp: digest(`READ_ONLY_ACTIVITY|${processId}|${semantic}`), command: extractCommand(payload) });
    }
  };
  for (const chunk of chunks) {
    const at = chunk[1]!;
    if (!Number.isFinite(Date.parse(at))) continue;
    const stream = chunk[2]!; const pieces = `${pending.get(stream) ?? ""}${chunk[3]!}`.split(/\r?\n/);
    pending.set(stream, pieces.pop() ?? "");
    for (const line of pieces) inspect(line, at);
  }
  const finalAt = chunks.at(-1)?.[1];
  if (finalAt) for (const line of pending.values()) inspect(line, finalAt);
  return activities;
}

export class RunBudgetController {
  constructor(private readonly store: Store, private readonly nowMs: () => number = () => Date.now(),
    private readonly terminatePid: (pid: number) => boolean = (pid) => {
      try { return process.platform === "win32" ? spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).status === 0 : (process.kill(pid, "SIGTERM"), true); }
      catch { return false; }
    }) {}

  start(taskId: string, projectId: string, budgetDurationMs: number, noProgressBudgetMs: number): RunBudgetState {
    if (![budgetDurationMs, noProgressBudgetMs].every((v) => Number.isInteger(v) && v > 0)) throw new Error("RUN_BUDGET_INVALID");
    const existing = this.get(taskId);
    if (existing) {
      if (existing.projectId !== projectId || existing.budgetDurationMs !== budgetDurationMs || existing.noProgressBudgetMs !== noProgressBudgetMs)
        throw new Error("RUN_BUDGET_EXTENSION_REQUIRES_HIGHER_AUTHORITY");
      return existing;
    }
    const now = new Date(this.nowMs()).toISOString();
    const state: RunBudgetState = { runId: randomUUID(), taskId, projectId, startedAt: now, deadlineAt: new Date(this.nowMs() + budgetDurationMs).toISOString(),
      budgetDurationMs, noProgressBudgetMs, lastProgressAt: now, lastProgressFingerprint: "START", status: "ACTIVE" };
    this.store.transaction(() => { this.store.upsertRuntimeState(key(taskId), state); this.store.upsertRuntimeState(runKey(taskId, state.runId), state); }); return state;
  }

  get(taskId: string): RunBudgetState | undefined {
    const state = this.store.getRuntimeState<RunBudgetState>(key(taskId)); if (!state || state.runId) return state;
    const legacy = { ...state, runId: `legacy-${digest(`${state.taskId}|${state.projectId}|${state.startedAt}|${state.deadlineAt}`).slice(0, 24)}` };
    this.store.transaction(() => { this.store.upsertRuntimeState(key(taskId), legacy); this.store.upsertRuntimeState(runKey(taskId, legacy.runId), legacy); });
    return legacy;
  }

  getRun(taskId: string, runId: string): RunBudgetState | undefined { return this.store.getRuntimeState<RunBudgetState>(runKey(taskId, runId)); }

  continuation(taskId: string, role: Role, revisionRound: number) {
    return continuationIntentForDispatch(this.store, taskId, this.get(taskId)?.runId, role, revisionRound);
  }

  rearm(request: RunBudgetRearmRequest): RunBudgetState {
    if (![request.budgetDurationMs, request.noProgressBudgetMs].every((v) => Number.isInteger(v) && v > 0)) throw new Error("RUN_BUDGET_INVALID");
    if (!request.requestId.trim() || !request.actor.trim() || !request.reason.trim()) throw new Error("RUN_BUDGET_REARM_PROVENANCE_REQUIRED");
    if (request.authority.authorityClass !== "HUMAN_REQUIRED" || !request.authority.approvedBy?.trim() || !["OWNER", "OPERATOR"].includes(request.actor)) throw new Error("RUN_BUDGET_REARM_REQUIRES_AUTHORITY");
    const eventId = `run-budget-rearmed:${request.taskId}:${request.requestId}`;
    return this.store.transaction(() => {
      const duplicate = this.store.db.prepare("SELECT payload_json FROM protocol_events WHERE event_id=?").get(eventId) as { payload_json: string } | undefined;
      if (duplicate) {
        const newRunId = String((JSON.parse(duplicate.payload_json) as { new_run_id: string }).new_run_id);
        const priorResult = this.getRun(request.taskId, newRunId); if (!priorResult) throw new Error("RUN_BUDGET_REARM_PROVENANCE_CORRUPT"); return priorResult;
      }
      const previous = this.get(request.taskId);
      if (!previous || previous.status !== "EXHAUSTED") throw new Error("RUN_BUDGET_REARM_REQUIRES_EXHAUSTED_RUN");
      if (previous.projectId !== request.projectId || previous.runId !== request.previousRunId) throw new Error("RUN_BUDGET_REARM_BINDING_MISMATCH");
      const startedAt = new Date(this.nowMs()).toISOString();
      const next: RunBudgetState = { runId: randomUUID(), taskId: request.taskId, projectId: request.projectId, startedAt,
        deadlineAt: new Date(this.nowMs() + request.budgetDurationMs).toISOString(), budgetDurationMs: request.budgetDurationMs,
        noProgressBudgetMs: request.noProgressBudgetMs, lastProgressAt: startedAt, lastProgressFingerprint: "START", status: "ACTIVE" };
      this.store.upsertRuntimeState(runKey(previous.taskId, previous.runId), previous);
      this.store.upsertRuntimeState(runKey(next.taskId, next.runId), next);
      this.store.upsertRuntimeState(key(next.taskId), next);
      if (request.continuationIntent) {
        const role = this.store.db.prepare("SELECT role,revision_round FROM task_roles WHERE task_id=? AND role=?").get(request.taskId, request.continuationIntent.role) as { role: string; revision_round: number } | undefined;
        if (!role || role.revision_round !== request.continuationIntent.revisionRound) throw new Error("CONTINUATION_INTENT_BOUNDARY_MISMATCH");
        recordContinuationIntent(this.store, { taskId: request.taskId, runId: next.runId, intent: request.continuationIntent,
          authoritySource: request.actor, authority: request.authority, createdAt: startedAt });
      }
      this.store.db.prepare(`INSERT INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(eventId, request.taskId, "RUN_BUDGET_REARMED", request.actor, "RUNTIME", JSON.stringify({ task_id: request.taskId,
          previous_run_id: previous.runId, new_run_id: next.runId, authority: request.authority, actor: request.actor, reason: request.reason,
          requested_wall_budget_ms: request.budgetDurationMs, requested_no_progress_budget_ms: request.noProgressBudgetMs,
          previous_status: previous.status, new_started_at: next.startedAt, new_deadline_at: next.deadlineAt, timestamp: startedAt,
          continuation_intent_bound: Boolean(request.continuationIntent) }), startedAt);
      return next;
    });
  }

  evaluate(taskId: string): RunBudgetState | undefined {
    let state = this.get(taskId); if (!state || state.status === "EXHAUSTED") return state;
    const event = this.store.db.prepare(`SELECT event_type,sender,payload_json,created_at FROM protocol_events WHERE task_id=? AND event_type IN (${MEANINGFUL.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`)
      .get(taskId, ...MEANINGFUL) as { event_type: string; sender: string; payload_json: string; created_at: string } | undefined;
    const proc = this.store.db.prepare("SELECT process_id,agent_id,attempt,working_dir,started_at,last_seen,status,log_path FROM worker_processes WHERE task_id=? ORDER BY started_at DESC LIMIT 1")
      .get(taskId) as { process_id: string; agent_id: string; attempt: number; working_dir: string; started_at: string; last_seen: string; status: string; log_path: string } | undefined;
    const taskExecution = this.store.db.prepare("SELECT role,assigned_agent,attempt,validation_json FROM tasks WHERE task_id=?").get(taskId) as { role: Role; assigned_agent: string | null; attempt: number; validation_json: string } | undefined;
    const taskRole = taskExecution?.role;
    // A Worker's own process liveness is progress too, not only durable
    // protocol chatter. Without this, a single long-running CLI call (a real
    // npm test/build can easily run past noProgressBudgetMs) is silently
    // fingerprinted as stale from the moment it started, so this Task's own
    // completion -- the exact moment it finally exits and hands its terminal
    // Result to the durable protocol -- can lose a race against expiry by
    // mere milliseconds even though the Worker never stopped making progress.
    // Only a currently RUNNING process counts: once it is EXITED/CANCELLED/
    // LOST its last heartbeat is history, not ongoing progress, so a
    // genuinely stalled or silent process still expires deterministically.
    //
    // DDF02 Retry 2: some Worker CLIs do not stream stdout/stderr while deep
    // inside one long internal step -- a real `npm test`/`npm run build` can
    // legitimately go silent for minutes even while the agent keeps editing
    // real Product files, so PROCESS_HEARTBEAT alone can still starve a
    // Task that never stopped making genuine progress. A change to the
    // owning process's own Product worktree is objective, Task-bound
    // evidence a merely-alive/silent process cannot produce on its own. The
    // FIRST observation of a running process only establishes a baseline --
    // it must never itself count as progress, or a worktree that already
    // carried uncommitted changes before this process even started would
    // manufacture a free refresh -- only a later CHANGE from that baseline
    // does, and only while the owning process is still RUNNING.
    let productDiffFingerprint = state.lastProductDiffFingerprint;
    let productDiffAt = state.lastProductDiffAt;
    if (proc && proc.status === "RUNNING" && proc.working_dir) {
      const observed = productDiffSignature(proc.working_dir);
      if (state.lastProductDiffFingerprint === undefined) productDiffFingerprint = observed; // baseline only, not progress
      else if (observed !== state.lastProductDiffFingerprint) {
        productDiffFingerprint = observed;
        productDiffAt = new Date(this.nowMs()).toISOString();
      }
    }
    let readOnlyActivityAt = state.lastReadOnlyActivityAt;
    let readOnlyActivityFingerprint = state.lastReadOnlyActivityFingerprint;
    let seenReadOnlyActivities = state.readOnlyActivityFingerprints ?? [];
    // PD01 long-running-validation correction: this signal was previously
    // gated to REVIEWER/QA only, on the assumption a DEVELOPER's own edits
    // would always show up as a Product-diff instead (see the DDF02 Retry 2
    // comment above). That assumption breaks for a pure validation-only pass
    // -- e.g. a DEVELOPER re-verifying prior work with no further source
    // edits -- where `npm run build` can legitimately run silent for tens of
    // minutes: no new stdout (PROCESS_HEARTBEAT goes stale), no worktree
    // change (PRODUCT_DIFF never fires), yet the process is genuinely still
    // working. The structured tool-call log this reads is role-agnostic, so
    // any Role now gets credit for its own distinct, durable command/tool
    // activity, not only REVIEWER/QA.
    let validationInFlight = false;
    if (proc?.status === "RUNNING" && proc.agent_id === taskExecution?.assigned_agent && proc.attempt === taskExecution.attempt) {
      const runStartedAt = state.startedAt;
      const activities = readOnlyActivities(proc.log_path, proc.process_id)
        .filter((activity) => Date.parse(activity.at) >= Date.parse(runStartedAt));
      const seen = new Set(seenReadOnlyActivities);
      const fresh = activities.filter((activity) => !seen.has(activity.fp)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      if (fresh.length) {
        for (const activity of fresh) seen.add(activity.fp);
        seenReadOnlyActivities = [...seen];
        const latest = fresh.at(-1)!;
        readOnlyActivityAt = latest.at;
        readOnlyActivityFingerprint = latest.fp;
      }
      // "Still executing" grace (required semantics, §3): only when the MOST
      // RECENT recognized activity in this run's own log -- not merely any
      // activity ever seen -- is itself a dispatch of one of the Task's own
      // declared `validation` commands (an exact command match, optionally
      // one segment of a `&&`/`;`-chained line -- never free-text/LLM
      // classification). A hung/idle Worker or an unrelated tool/provider
      // retry loop never produces this activity shape, so it still expires
      // normally (cases B/C/D); a repeat of the *same* validation command
      // cannot manufacture a fresh lastProgressAt refresh either (the
      // dedup above already collapses it), it only keeps this flag true.
      // The grace itself does not touch lastProgressAt -- it solely
      // suspends the NO_PROGRESS check below, so the run remains bounded by
      // the ordinary, unconditional WALL_CLOCK_BUDGET the whole time.
      let declaredValidation: string[] = [];
      try { const parsed = JSON.parse(taskExecution!.validation_json) as unknown; if (Array.isArray(parsed)) declaredValidation = parsed.filter((v): v is string => typeof v === "string"); } catch { /* malformed -- no validation commands to match */ }
      const mostRecent = activities.at(-1);
      validationInFlight = Boolean(mostRecent?.command && declaredValidation.some((entry) => commandMatchesValidation(mostRecent.command!, entry)));
    }
    // productDiffAt is a PERSISTED timestamp (not recomputed fresh each call
    // the way the event/heartbeat candidates below are): it only advances
    // forward on an observed change and otherwise keeps whatever value it
    // already had, so it stays comparable on every later poll even once the
    // worktree goes quiet again.
    const candidate = [event ? { at: event.created_at, fp: digest(`${event.event_type}|${event.sender}|${event.payload_json}`) } : undefined,
      proc ? { at: proc.started_at, fp: digest(`PROCESS_START|${proc.process_id}`) } : undefined,
      proc && proc.status === "RUNNING" && taskRole !== "REVIEWER" && taskRole !== "QA"
        ? { at: proc.last_seen, fp: digest(`PROCESS_HEARTBEAT|${proc.process_id}|${proc.last_seen}`) } : undefined,
      productDiffAt ? { at: productDiffAt, fp: digest(`PRODUCT_DIFF|${proc?.process_id}|${productDiffFingerprint}`) } : undefined,
      readOnlyActivityAt && readOnlyActivityFingerprint ? { at: readOnlyActivityAt, fp: readOnlyActivityFingerprint } : undefined,
    ].filter(Boolean).sort((a, b) => Date.parse(b!.at) - Date.parse(a!.at))[0];
    let next = state;
    if (candidate && candidate.fp !== state.lastProgressFingerprint && Date.parse(candidate.at) >= Date.parse(state.startedAt)) {
      next = { ...next, lastProgressAt: candidate.at, lastProgressFingerprint: candidate.fp };
    }
    if (productDiffFingerprint !== undefined && productDiffFingerprint !== state.lastProductDiffFingerprint) next = { ...next, lastProductDiffFingerprint: productDiffFingerprint };
    if (productDiffAt !== undefined && productDiffAt !== state.lastProductDiffAt) next = { ...next, lastProductDiffAt: productDiffAt };
    if (seenReadOnlyActivities !== state.readOnlyActivityFingerprints) next = { ...next, readOnlyActivityFingerprints: seenReadOnlyActivities };
    if (readOnlyActivityAt !== undefined && readOnlyActivityAt !== state.lastReadOnlyActivityAt) next = { ...next, lastReadOnlyActivityAt: readOnlyActivityAt };
    if (readOnlyActivityFingerprint !== undefined && readOnlyActivityFingerprint !== state.lastReadOnlyActivityFingerprint) next = { ...next, lastReadOnlyActivityFingerprint: readOnlyActivityFingerprint };
    if (next !== state) {
      state = next; this.store.transaction(() => { this.store.upsertRuntimeState(key(taskId), state!); this.store.upsertRuntimeState(runKey(taskId, state!.runId), state!); });
    }
    const now = this.nowMs();
    if (now >= Date.parse(state.deadlineAt)) return this.expire(state, "WALL_CLOCK_BUDGET");
    if (now - Date.parse(state.lastProgressAt) >= state.noProgressBudgetMs && !validationInFlight) return this.expire(state, "NO_PROGRESS_BUDGET");
    return state;
  }

  canContinue(taskId: string): boolean { const state = this.evaluate(taskId); return !state || state.status === "ACTIVE"; }

  private expire(state: RunBudgetState, expiredBy: RunBudgetExpiry): RunBudgetState {
    const current = this.get(state.taskId)!; if (current.status === "EXHAUSTED") return current;
    const expiredAt = new Date(this.nowMs()).toISOString(); const exhausted: RunBudgetState = { ...current, status: "EXHAUSTED", expiredAt, expiredBy };
    this.store.transaction(() => {
      this.store.upsertRuntimeState(key(state.taskId), exhausted);
      this.store.upsertRuntimeState(runKey(state.taskId, state.runId), exhausted);
      this.store.db.prepare(`INSERT OR IGNORE INTO protocol_events(event_id,task_id,event_type,sender,recipient,payload_json,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(`run-budget-exhausted:${state.taskId}:${state.runId}`, state.taskId, "RUN_BUDGET_EXHAUSTED", "RUNTIME", "MAIN", JSON.stringify({ outcome: "RUN_BUDGET_EXHAUSTED", run_id: state.runId, expired_by: expiredBy, started_at: state.startedAt, deadline_at: state.deadlineAt, expired_at: expiredAt, product_failed: false }), expiredAt);
      this.store.db.prepare("UPDATE continuation_watches SET enabled=0,updated_at=? WHERE task_id=?").run(expiredAt, state.taskId);
      this.store.db.prepare("DELETE FROM workspace_locks WHERE task_id=?").run(state.taskId);
    });
    const rows = this.store.db.prepare("SELECT pid FROM worker_processes WHERE task_id=? AND status='RUNNING'").all(state.taskId) as Array<{ pid: number }>;
    for (const row of rows) { if (this.terminatePid(row.pid)) this.store.db.prepare("UPDATE worker_processes SET status='CANCELLED',last_seen=? WHERE task_id=? AND pid=? AND status='RUNNING'").run(expiredAt, state.taskId, row.pid); }
    return exhausted;
  }
}
