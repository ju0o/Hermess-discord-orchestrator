import type { Store } from "../storage/database.js";
import { redact } from "../security/redaction.js";
import type { ReportPreferences } from "./reportPreferences.js";

export interface SprintReportInput {
  doneToday: string[];
  inProgress: string[];
  failuresAndRecovery: string[];
  companySelfImprovement: string[];
  workerFriction: string[];
  learningCandidates: string[];
  ownerDecisionsRequired: string[];
  nextAutomaticProgress: string[];
}

function bullet(items: string[], empty = "없음", max = Infinity): string {
  if (!items.length) return empty;
  const shown = items.slice(0, max);
  const lines = shown.map((item) => `- ${redact(item).trim()}`);
  if (items.length > shown.length) lines.push(`- ...외 ${items.length - shown.length}건`);
  return lines.join("\n");
}

/**
 * Fixed Owner-readable format for #coding-reports. Deterministic rendering -- no LLM call.
 * `preferences` is the visible half of the Owner-feedback-changes-behavior loop (Sprint 01
 * V09, see reportPreferences.ts): when shortForm was derived from real Owner feedback, this
 * exact report is rendered differently *because of* that feedback, and says so.
 */
export function renderSprintReport(input: SprintReportInput, preferences?: ReportPreferences): string {
  const max = preferences?.shortForm ? 3 : Infinity;
  const lines = [
    "🏢 Coding Company Report",
    ...(preferences?.shortForm ? ["(간단 보기 — Owner 피드백에 따라 적용됨)"] : []),
    "",
    "**오늘 한 일**", bullet(input.doneToday, "없음", max),
    "",
    "**현재 진행 중**", bullet(input.inProgress, "없음", max),
    "",
    "**실패/복구**", bullet(input.failuresAndRecovery, "없음", max),
    "",
    "**회사 자체 개선**", bullet(input.companySelfImprovement, "없음", max),
    "",
    "**Worker 불편**", bullet(input.workerFriction, "없음", max),
    "",
    "**학습 후보**", bullet(input.learningCandidates, "없음", max),
    "",
    "**Owner 결정 필요**", bullet(input.ownerDecisionsRequired, "없음", max),
    "",
    "**다음 자동 진행**", bullet(input.nextAutomaticProgress, "없음", max),
  ];
  return lines.join("\n");
}

/** Gathers report inputs from durable state for the given lookback window. Read-only. */
export function gatherSprintReport(store: Store, sinceIso: string): SprintReportInput {
  const tasks = store.db.prepare(
    "SELECT task_id,title,status FROM tasks WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 100",
  ).all(sinceIso) as Array<{ task_id: string; title: string; status: string }>;
  const doneToday = tasks.filter((task) => task.status === "PASS").map((task) => `${task.title} (${task.task_id})`);
  const inProgress = tasks.filter((task) => ["CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING"].includes(task.status)).map((task) => `${task.title} (${task.task_id})`);
  const failed = tasks.filter((task) => ["FAIL", "WAITING_MAIN", "HUMAN_GATE"].includes(task.status)).map((task) => `${task.title} — ${task.status} (${task.task_id})`);

  const friction = (store.db.prepare(
    "SELECT problem,severity FROM worker_friction WHERE has_friction=1 AND created_at >= ? ORDER BY created_at DESC LIMIT 20",
  ).all(sinceIso) as Array<{ problem: string; severity: string }>).map((row) => `[${row.severity}] ${row.problem}`);

  const learning = (store.db.prepare(
    "SELECT raw_text FROM human_feedback WHERE type='LEARNING_CANDIDATE' AND created_at >= ? ORDER BY created_at DESC LIMIT 20",
  ).all(sinceIso) as Array<{ raw_text: string }>).map((row) => row.raw_text);

  const ownerRequired = (store.db.prepare(
    "SELECT question FROM owner_decisions WHERE status='OPEN' ORDER BY created_at DESC LIMIT 20",
  ).all() as Array<{ question: string }>).map((row) => row.question);

  const backlog = (store.db.prepare(
    "SELECT title FROM improvement_backlog WHERE status='OPEN' ORDER BY rank_score DESC LIMIT 5",
  ).all() as Array<{ title: string }>).map((row) => `Improvement Backlog 검토: ${row.title}`);

  return {
    doneToday, inProgress, failuresAndRecovery: failed, companySelfImprovement: backlog,
    workerFriction: friction, learningCandidates: learning, ownerDecisionsRequired: ownerRequired,
    nextAutomaticProgress: inProgress.length ? ["진행 중인 작업을 계속 진행합니다."] : ["새 Task 배정을 기다립니다."],
  };
}
