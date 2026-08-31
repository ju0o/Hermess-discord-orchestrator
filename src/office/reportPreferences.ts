import type { Store } from "../storage/database.js";

/**
 * The mechanical half of "Owner feedback must cause visible change" (Sprint 01 V09): a small,
 * fixed, deterministic set of report-rendering preferences derived from recent Owner feedback.
 * This is a bounded, reversible Company self-improvement -- it changes how the NEXT report
 * renders, not any constitutional policy, and only covers report *presentation* (never which
 * data is included). No LLM/Hermes inference.
 */
export interface ReportPreferences {
  /** e.g. "불편해. 이 보고 방식은 너무 길어." / "학습해. 짧게 요약해줘." */
  shortForm: boolean;
  /** feedback_id the shortForm preference was derived from, for traceability in the report itself. */
  appliedFrom?: string;
}

// Word-boundary anchored (\b), not a free substring match -- an earlier version matched
// "short"/"shorter"/"shorten" anywhere, which false-triggers on completely unrelated English
// like "I'll get back to you shortly", "a shortfall in the budget", "shorthand notation"
// (independent review finding: this repeats the exact class of bug already fixed once in
// humanFeedback.ts's REJECT_PATTERN -- fixed here the same way).
const SHORT_FORM_PATTERN = /(짧게|간단히|간략|줄여|\btoo\s*long\b|\bshorten\b|\bshort(er)?\b|\bconcise\b)/i;
// Explicit reversal: without this, once shortForm is set it can only clear once 20 newer
// LEARNING_CANDIDATE/UX_FRICTION rows push it out of the lookback window (independent review
// finding) -- an Owner saying "다시 길게 보여줘" should immediately restore the full report.
const LONG_FORM_PATTERN = /(길게|자세히|풀어서|전체\s*보여|\bexpand\b|\blonger\b|\bfull\s*(version|report)\b)/i;

export function deriveReportPreferences(store: Store): ReportPreferences {
  const rows = store.db.prepare(
    "SELECT feedback_id, raw_text, created_at FROM human_feedback WHERE type IN ('LEARNING_CANDIDATE','UX_FRICTION') ORDER BY created_at DESC LIMIT 20",
  ).all() as Array<{ feedback_id: string; raw_text: string; created_at: string }>;
  for (const row of rows) {
    if (LONG_FORM_PATTERN.test(row.raw_text)) return { shortForm: false }; // most recent relevant signal wins
    if (SHORT_FORM_PATTERN.test(row.raw_text)) return { shortForm: true, appliedFrom: row.feedback_id };
  }
  return { shortForm: false };
}
