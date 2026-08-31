import type { TaskRecord } from "../domain/types.js";
import { redact } from "../security/redaction.js";
import { renderFriction, type WorkerFrictionRecord } from "./workerFriction.js";

export interface FinalSummaryInput {
  task: TaskRecord;
  outcome: { ok: boolean; output: string; evidence?: string[] };
  friction: WorkerFrictionRecord[];
  /** Explicit Owner action, or undefined/"" to render the required "없음" line. */
  ownerActionRequired?: string;
}

function clean(value: string, max = 1_200): string {
  return redact(String(value || "")).trim().replace(/\r\n?/g, "\n").slice(0, max) || "(내용 없음)";
}

/**
 * Every completed Task gets exactly this six-part structure once, regardless of how many
 * running-commentary messages (renderOfficeMessage) already appeared in the Task thread.
 * This is the artifact the Owner reads if they read nothing else about the Task.
 */
export function renderFinalSummary(input: FinalSummaryInput): string {
  const { task, outcome, friction, ownerActionRequired } = input;
  const status = outcome.ok ? "✅ 완료" : "⚠️ 문제 발생";
  const lines = [
    `${status} — ${clean(task.title, 200)}`,
    "",
    "**무엇을 했나**",
    clean(task.title, 300),
    "",
    "**왜 했나**",
    clean(task.goal, 500),
    "",
    "**결과**",
    clean(outcome.output, 1_500),
    "",
    "**문제/주의점**",
    outcome.ok ? "없음" : clean(outcome.output, 800),
    "",
    "**Worker가 불편했던 점**",
    renderFriction(friction),
    "",
    "**주엉쓰가 할 일**",
    ownerActionRequired ? clean(ownerActionRequired, 500) : "없음",
  ];
  return lines.join("\n");
}
