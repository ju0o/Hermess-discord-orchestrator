import { randomUUID } from "node:crypto";
import { redact } from "../security/redaction.js";
import type { Store } from "../storage/database.js";

/**
 * Durable capture of natural-language Owner replies from #owner-inbox. This is deliberately
 * separate from OwnerInbox (owner_decisions), which is the machine-initiated engineering
 * escalation queue (QUESTION / OWNER_DECISION_REQUIRED / ...). HumanFeedback is the other
 * direction: the Owner talking back in plain Korean/English, classified deterministically
 * (no LLM/Hermes inference -- see classify()) into one of four durable, distinct buckets.
 *
 * A LEARNING_CANDIDATE is stored as a candidate only. It never mutates Company policy by
 * itself; a human or a later governed process decides whether to act on it.
 */
export const HUMAN_FEEDBACK_TYPES = ["OWNER_FEEDBACK", "LEARNING_CANDIDATE", "APPROVAL_DECISION", "UX_FRICTION"] as const;
export type HumanFeedbackType = (typeof HUMAN_FEEDBACK_TYPES)[number];
export type ApprovalDecisionValue = "APPROVED" | "REJECTED";

export interface HumanFeedbackInput {
  rawText: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorId: string;
  taskId?: string;
  relatedInboxItemId?: string;
}

export interface HumanFeedbackRecord {
  feedbackId: string;
  type: HumanFeedbackType;
  rawText: string;
  classificationSource: "HEURISTIC";
  taskId?: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceAuthorId: string;
  relatedInboxItemId?: string;
  applied: boolean;
  createdAt: string;
  /** Only present when type === "APPROVAL_DECISION". */
  approvalDecision?: ApprovalDecisionValue;
}

// Deterministic heuristic classifier. Order matters: short, unambiguous Owner replies
// ("승인" / "거절") are checked first so a longer LEARNING/FRICTION phrase can't shadow them.
//
// APPROVE/REJECT are deliberately anchored to the *whole* trimmed message (± trailing
// punctuation), not a free substring match. A prior version matched "안 돼"/"하지 마" anywhere
// in the text, which misclassified extremely common Korean phrases that are NOT rejections --
// e.g. "무리하지 마세요" (take it easy), "걱정하지 마세요" (don't worry), "잘 안 돼요, 확인해주세요"
// (a bug report) -- as APPROVAL_DECISION/REJECTED (independent review finding, fixed here).
// A longer sentence containing an approve/reject word falls through to OWNER_FEEDBACK instead:
// a false negative (unclassified) is far safer here than a false positive (wrong decision).
const APPROVE_PATTERN = /^(승인|허락|진행해|진행|괜찮아|ok|okay|yes|네|응)[.!?~\s]*$/i;
const REJECT_PATTERN = /^(거절|반려|안\s*돼|하지\s*마|중지해|no|reject(ed)?)[.!?~\s]*$/i;
const LEARNING_PATTERN = /(학습해|기억해|다음부터|앞으로는?\s*(알아서|이렇게)|remember\s+th(is|at)|from now on|next time)/i;
const FRICTION_PATTERN = /(불편|별로|싫어|너무\s*(길|복잡|느려)|짜증|annoying|frustrat|too (long|slow|complex))/i;

// V0 is single-label: the first matching bucket wins even if a message also carries a second
// signal (e.g. "그건 괜찮아 근데 좀 불편해" only records as APPROVAL_DECISION, not also
// UX_FRICTION -- independent review finding, accepted as a documented V0 limitation rather
// than building multi-label capture under this Sprint).
export function classify(rawText: string): { type: HumanFeedbackType; approvalDecision?: ApprovalDecisionValue } {
  const text = rawText.trim();
  if (APPROVE_PATTERN.test(text)) return { type: "APPROVAL_DECISION", approvalDecision: "APPROVED" };
  if (REJECT_PATTERN.test(text)) return { type: "APPROVAL_DECISION", approvalDecision: "REJECTED" };
  if (LEARNING_PATTERN.test(text)) return { type: "LEARNING_CANDIDATE" };
  if (FRICTION_PATTERN.test(text)) return { type: "UX_FRICTION" };
  return { type: "OWNER_FEEDBACK" };
}

function bounded(value: string, max = 2_000): string { return redact(String(value || "")).trim().slice(0, max); }

function fromRow(row: Record<string, unknown>): HumanFeedbackRecord {
  const record: HumanFeedbackRecord = {
    feedbackId: String(row.feedback_id), type: row.type as HumanFeedbackType, rawText: String(row.raw_text),
    classificationSource: "HEURISTIC", sourceChannelId: String(row.source_channel_id),
    sourceMessageId: String(row.source_message_id), sourceAuthorId: String(row.source_author_id),
    applied: Boolean(row.applied), createdAt: String(row.created_at),
  };
  if (row.task_id) record.taskId = String(row.task_id);
  if (row.related_inbox_item_id) record.relatedInboxItemId = String(row.related_inbox_item_id);
  if (row.approval_decision) record.approvalDecision = row.approval_decision as ApprovalDecisionValue;
  return record;
}

export class HumanFeedback {
  constructor(private readonly store: Store) {}

  /** Idempotent per Discord message: a duplicate/replayed messageCreate never double-records the same reply. */
  capture(input: HumanFeedbackInput): HumanFeedbackRecord {
    const existing = this.get(input.sourceMessageId);
    if (existing) return existing;
    // Classify (and persist) approvalDecision from the original, untruncated rawText -- never
    // re-derive it later from the (possibly bounded()-truncated) stored raw_text column
    // (independent review finding).
    const { type, approvalDecision } = classify(input.rawText);
    const now = this.store.now();
    const feedbackId = randomUUID();
    this.store.db.prepare(`INSERT INTO human_feedback(
      feedback_id,type,raw_text,classification_source,task_id,source_channel_id,source_message_id,source_author_id,
      related_inbox_item_id,approval_decision,applied,created_at) VALUES(?,?,?,'HEURISTIC',?,?,?,?,?,?,0,?)`).run(
      feedbackId, type, bounded(input.rawText), input.taskId ?? null, input.sourceChannelId,
      input.sourceMessageId, input.sourceAuthorId, input.relatedInboxItemId ?? null, approvalDecision ?? null, now,
    );
    return this.get(input.sourceMessageId)!;
  }

  get(sourceMessageId: string): HumanFeedbackRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM human_feedback WHERE source_message_id=?").get(sourceMessageId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(options: { type?: HumanFeedbackType; limit?: number } = {}): HumanFeedbackRecord[] {
    const clauses: string[] = []; const params: Array<string | number> = [];
    if (options.type) { clauses.push("type=?"); params.push(options.type); }
    const limit = Math.max(1, Math.min(200, options.limit || 50));
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.store.db.prepare(`SELECT * FROM human_feedback${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>).map(fromRow);
  }

  markApplied(feedbackId: string): void {
    this.store.db.prepare("UPDATE human_feedback SET applied=1 WHERE feedback_id=?").run(feedbackId);
  }
}

const TYPE_LABEL: Record<HumanFeedbackType, string> = {
  APPROVAL_DECISION: "APPROVAL", LEARNING_CANDIDATE: "LEARNING CANDIDATE", UX_FRICTION: "FRICTION", OWNER_FEEDBACK: "FEEDBACK",
};

function nextStepLine(record: HumanFeedbackRecord): string {
  switch (record.type) {
    case "APPROVAL_DECISION":
      return record.approvalDecision === "REJECTED" ? "거절로 기록하고 해당 작업을 진행하지 않겠습니다." : "승인을 반영하여 계속 진행하겠습니다.";
    case "LEARNING_CANDIDATE":
      return "다음 상호작용부터 이 학습 후보를 시험 적용하고 결과를 보여드리겠습니다.";
    case "UX_FRICTION":
      return "Improvement Backlog에 반영하고 우선순위를 검토하겠습니다.";
    default:
      return "기록했습니다. 참고하겠습니다.";
  }
}

/**
 * Full two-way reply the Owner asked for: what the Company understood (echoed, not an LLM
 * paraphrase -- classification stays deterministic per this file's header comment),
 * classification, storage confirmation, scope, next step, and any further Owner action.
 * Replaces the old one-line acknowledgement() -- this IS the Owner-visible half of the
 * feedback round-trip (see office/reportPreferences.ts for the "next report reflects it" half).
 */
export function acknowledgement(record: HumanFeedbackRecord, scope = "Coding Company Office"): string {
  // Array.from() splits on code points, not UTF-16 code units -- a plain .slice(0, 200) can cut
  // a surrogate pair (e.g. an emoji) in half, producing an unpaired surrogate that breaks when
  // sent to Discord (independent review finding).
  const codePoints = Array.from(record.rawText);
  const quoted = codePoints.length > 200 ? `${codePoints.slice(0, 200).join("")}...` : record.rawText;
  return [
    "알겠습니다.",
    "",
    `"${quoted}" 라고 이해했습니다.`,
    "",
    `[${TYPE_LABEL[record.type]}]`,
    `범위: ${scope}`,
    "상태: 저장됨",
    "",
    nextStepLine(record),
    "",
    "주엉쓰가 추가로 할 일: 없음",
  ].join("\n");
}
