import type { AdapterTaskResult, TaskRecord, TaskRoleRecord } from "../domain/types.js";
import { actionableFindings, captureProductDigest, reuseValidationEvidence, type ValidationType } from "../runtime/correction.js";

export type ReviewVerdict = "REVIEW_PASS" | "REVIEW_BLOCKED" | "REVIEW_FAIL" | "REVIEW_INDETERMINATE";

export interface NormalizedReview { verdict: ReviewVerdict; findings: string[]; evidence: string[]; validationsRun: string[]; }

export function normalizeReviewResult(result: AdapterTaskResult, requiredValidation: string[]): NormalizedReview {
  // A Reviewer whose unified-exec runner never actually connected (a
  // repeated pipe-in timeout, or any other adapter-classified transport
  // failure) never performed a real independent inspection. That is a
  // distinct, more truthful failure than "the Reviewer ran and its evidence
  // was incomplete" -- preserve it as the authoritative finding instead of
  // falling through to the generic missing-evidence wording below.
  // REVIEWER_UNIFIED_EXEC_PIPE_IN_FAILURE (live D-023 certification
  // 2026-08-24): two independent Reviewer rounds failed at "Failed to
  // create unified exec process: timed out after 15000ms connecting runner
  // pipe-in" after lawful Developer validation evidence had already
  // reached the Reviewer; both were nonetheless reported to the Owner as
  // "Required validation evidence is missing", hiding the real
  // execution-boundary failure. Mirrors normalizeDeveloperResult's
  // equivalent blockedReason check.
  if (result.blockedReason) return { verdict: "REVIEW_INDETERMINATE", findings: [`Reviewer execution blocked: ${result.blockedReason}`], evidence: result.evidence, validationsRun: [] };
  const text = String(result.output || "");
  const upper = text.toUpperCase();
  const structured = text.match(/\b(?:VERDICT|STATUS)\s*[:=]\s*(REVIEW_PASS|PASS|BLOCKED|FAIL|CHANGES_REQUIRED|REVISION_REQUIRED)\b/i)?.[1]?.toUpperCase();
  const bodyBlocked = /\b(BLOCKED|NOT\s+APPROVED|IMPLEMENTATION\s*:\s*NOT\s+PERFORMED|BUILD\s*:\s*NOT\s+RUN|NOT\s+RUN)\b/i.test(text);
  const bodyRevision = /\b(CHANGES_REQUIRED|REVISION_REQUIRED|CHANGES?\s+REQUESTED|FAIL)\b/i.test(text);
  const currentEvidence = (result.validationEvidence ?? []).filter((item) => !item.product_digest || item.product_digest === captureProductDigest(item.worktree));
  const structuredValidation = reuseValidationEvidence(currentEvidence, requiredValidation.map((item) => inferValidationType(item)), currentEvidence[0]?.worktree ?? "", currentEvidence[0]?.branch ?? "");
  const validationsRun = requiredValidation.filter((item) => {
    const escaped = escapeRegExp(item);
    if (!new RegExp(`\\b${escaped}\\b`, "i").test(text)) return false;
    return !new RegExp(`\\b${escaped}\\b\\s*[:=-]?\\s*(?:NOT\\s+RUN|NOT\\s+PERFORMED|SKIPPED)\\b`, "i").test(text);
  });
  if (structured && ((structured === "PASS" || structured === "REVIEW_PASS") && (bodyBlocked || bodyRevision))) return { verdict: "REVIEW_INDETERMINATE", findings: ["Contradictory reviewer result"], evidence: result.evidence, validationsRun };
  const evidenceRun = structuredValidation.map((item) => requiredValidation.find((command) => inferValidationType(command) === item.type)).filter(Boolean) as string[];
  const allRun = [...new Set([...validationsRun, ...evidenceRun])];
  if (bodyBlocked || structured === "BLOCKED") return { verdict: "REVIEW_BLOCKED", findings: actionableFindings([text], "Reviewer blocked"), evidence: result.evidence, validationsRun: allRun };
  if (bodyRevision || structured === "FAIL" || structured === "CHANGES_REQUIRED" || structured === "REVISION_REQUIRED") return { verdict: "REVIEW_FAIL", findings: actionableFindings([text], "Reviewer requested revision"), evidence: result.evidence, validationsRun: allRun };
  if (!result.ok || requiredValidation.some((item) => !allRun.includes(item))) return { verdict: "REVIEW_INDETERMINATE", findings: ["Required validation evidence is missing"], evidence: result.evidence, validationsRun: allRun };
  return { verdict: "REVIEW_PASS", findings: [], evidence: result.evidence, validationsRun: allRun };
}

function inferValidationType(command: string): ValidationType { return /build/i.test(command) ? "BUILD" : /test/i.test(command) ? "TEST" : "TYPECHECK"; }

export type QaVerdict = "QA_PASS" | "QA_FAIL" | "QA_BLOCKED" | "QA_INDETERMINATE";

export interface NormalizedQa { verdict: QaVerdict; findings: string[]; evidence: string[]; validationsRun: string[]; }

/**
 * Structured QA verdict recognition. ACCEPT/QA_ACCEPT and REJECT/QA_FAIL are
 * lawful explicit verdicts exactly like PASS/FAIL (live D-023 certification
 * 2026-08-24: a QA "Verdict: ACCEPT" was not recognized, fell through to the
 * ambiguous-output branch, and the non-pass fail-closed mapping then recorded
 * an authoritative status=FAIL -- inverting the Worker's explicit verdict).
 * [\s:*]* around the separator tolerates markdown bold ("**Verdict:** ACCEPT").
 *
 * `[\s_-]+` between QA and its verb, and the optional `(?:ED)?` suffix on
 * each verb, tolerate the hyphen-joined past-tense form lawful QA Workers
 * also use (a prior bounded QA run:
 * "Verdict: QA-PASSED -- IMPLEMENTATION-COMPLETE" did not match
 * `QA[\s_]+PASS` -- no hyphen/ED tolerance -- nor bare `PASS` -- the
 * position right after the separator is fixed at "QA-PASSED", which none of
 * the alternatives start with. `structured` came back undefined, the
 * semantic PASS fell through the ambiguous-output branch, and the
 * fail-closed mapping recorded an authoritative status=FAIL over a lawful
 * PASS verdict backed by complete executed PASS validation evidence).
 */
const QA_STRUCTURED_VERDICT = /\b(?:VERDICT|STATUS|QA_RESULT|QA_VERDICT)\b[\s:*]*[:=][\s:*]*(QA[\s_-]+PASS(?:ED)?|QA[\s_-]+ACCEPT(?:ED)?|QA[\s_-]+FAIL(?:ED)?|PASS(?:ED)?|ACCEPT(?:ED)?|FAIL(?:ED)?|REJECT(?:ED)?|BLOCKED|CHANGES_REQUIRED|REVISION_REQUIRED)\b/i;

export function normalizeQaResult(result: AdapterTaskResult, requiredValidation: string[]): NormalizedQa {
  const text = String(result.output || "");
  const structured = text.match(QA_STRUCTURED_VERDICT)?.[1]?.toUpperCase().replace(/[\s-]+/g, "_");
  const acceptStructured = structured === "PASS" || structured === "PASSED" || structured === "QA_PASS" || structured === "QA_PASSED"
    || structured === "ACCEPT" || structured === "ACCEPTED" || structured === "QA_ACCEPT" || structured === "QA_ACCEPTED";
  const failStructured = structured === "FAIL" || structured === "FAILED" || structured === "QA_FAIL" || structured === "QA_FAILED"
    || structured === "REJECT" || structured === "REJECTED" || structured === "CHANGES_REQUIRED" || structured === "REVISION_REQUIRED";
  const bodyBlocked = /\b(BLOCKED|NOT\s+APPROVED|BUILD\s*:\s*NOT\s+RUN|NOT\s+RUN)\b/i.test(text);
  const bodyFail = /\b(CHANGES_REQUIRED|REVISION_REQUIRED|CHANGES?\s+REQUESTED|\bFAIL\b)\b/i.test(text);
  const textValidationsRun = requiredValidation.filter((item) => {
    const escaped = escapeRegExp(item);
    if (!new RegExp(`\\b${escaped}\\b`, "i").test(text)) return false;
    return !new RegExp(`\\b${escaped}\\b\\s*[:=-]?\\s*(?:NOT\\s+RUN|NOT\\s+PERFORMED|SKIPPED)\\b`, "i").test(text);
  });
  const suppliedStructuredEvidence = result.validationEvidence !== undefined;
  const currentEvidence = (result.validationEvidence ?? []).filter((item) => !item.product_digest || item.product_digest === captureProductDigest(item.worktree));
  const structuredValidation = reuseValidationEvidence(currentEvidence, requiredValidation.map((item) => inferValidationType(item)), currentEvidence[0]?.worktree ?? "", currentEvidence[0]?.branch ?? "");
  const evidenceValidationsRun = structuredValidation.map((item) => requiredValidation.find((command) => inferValidationType(command) === item.type)).filter(Boolean) as string[];
  // Once an adapter supplies structured evidence, it is the authority. Do not
  // let matching prose resurrect evidence rejected by task/attempt/worker/role
  // or Product-digest binding in WorkerRuntime.
  const validationsRun = suppliedStructuredEvidence ? [...new Set(evidenceValidationsRun)] : textValidationsRun;
  if (structured && acceptStructured && (bodyBlocked || bodyFail || failStructured)) return { verdict: "QA_INDETERMINATE", findings: ["Contradictory QA result"], evidence: result.evidence, validationsRun };
  if (bodyBlocked || structured === "BLOCKED") return { verdict: "QA_BLOCKED", findings: [text.slice(0, 500)], evidence: result.evidence, validationsRun };
  if (bodyFail || failStructured) return { verdict: "QA_FAIL", findings: [text.slice(0, 500)], evidence: result.evidence, validationsRun };
  const missingRequired = requiredValidation.length > 0 && requiredValidation.some((item) => !validationsRun.includes(item));
  if (!text.trim() || missingRequired) return { verdict: "QA_INDETERMINATE", findings: [missingRequired ? "Required QA validation evidence is missing" : "QA output is empty or ambiguous"], evidence: result.evidence, validationsRun };
  if (!result.ok) return { verdict: "QA_INDETERMINATE", findings: ["QA process did not report success and no explicit PASS verdict was found"], evidence: result.evidence, validationsRun };
  if (structured && acceptStructured) return { verdict: "QA_PASS", findings: [], evidence: result.evidence, validationsRun };
  if (requiredValidation.length === 0 && result.ok && !bodyBlocked && !bodyFail) return { verdict: "QA_PASS", findings: [], evidence: result.evidence, validationsRun };
  return { verdict: "QA_INDETERMINATE", findings: ["QA output is ambiguous: no explicit PASS verdict"], evidence: result.evidence, validationsRun };
}

export type DeveloperVerdict = "DEVELOPER_PASS" | "DEVELOPER_BLOCKED" | "DEVELOPER_FAIL" | "DEVELOPER_INDETERMINATE";
export interface NormalizedDeveloper { verdict: DeveloperVerdict; ok: boolean; findings: string[]; }

// A declarative execution-state BLOCKED, not any narrated mention of the
// word: a lawful completed report may truthfully disclose past obstacles in
// its history/provenance ("Both were blocked by the sandbox boundary …") and
// still conclude "Implementation complete" (live D-023 2026-08-25). Only an
// explicit current execution-state declaration ("BLOCKED: …",
// "STATUS: BLOCKED", "the run remains blocked", plus EXECUTION FAILED /
// TRANSPORT FAILURE / RUNNER FAILED / PIPE TIMEOUT / UNIFIED EXEC) is a
// blocked terminal result.
const DEVELOPER_BLOCKED_PATTERN = new RegExp([
  "\\bBLOCKED\\s*[:\\-]",
  "\\b(?:STATUS|VERDICT|RESULT|EXECUTION_STATE)\\s*[:=]\\s*BLOCKED\\b",
  "\\b(?:EXECUTION|RUN|TASK|WORKER|PIPELINE)\\s+(?:IS|WAS|REMAINS?|STILL)\\s+BLOCKED\\b",
  "\\bEXECUTION\\s+FAILED\\b",
  "\\bTRANSPORT\\s+FAILURE\\b",
  "\\bRUNNER\\s+FAILED\\b",
  "\\bPIPE\\s+TIMEOUT\\b",
  "\\bUNIFIED\\s+EXEC\\b",
].join("|"), "i");

/**
 * Central semantic admission for Worker final output (SEMANTIC_WORKER_RESULT_ADMISSION).
 * Process exit status is transport evidence, not semantic authority: the Runtime must
 * distinguish a completed terminal result from a question/approval request, progress
 * narration, or raw execution-stream narration before it may record a PASS. Live
 * D-023 certification 2026-08-24: an approval question ("May I revert ...?") exited 0,
 * the adapter reported ok=true, and normalizeDeveloperResult admitted it as a
 * successful completion because it only checked blocked/exit/emptiness.
 */
export type WorkerFinalSemantics = "COMPLETED_RESULT" | "QUESTION_OR_APPROVAL_REQUEST" | "PROGRESS_ONLY_NARRATION" | "EXECUTION_STREAM_NARRATION";

const QUESTION_OR_APPROVAL_PATTERN = new RegExp([
  "\\?[\\s*]*$", // trailing question mark, markdown-tolerant
  "\\b(?:may|should|shall|could|can)\\s+(?:i|we)\\b",
  "\\brequires?\\s+(?:owner\\s+)?approval\\b",
  "\\b(?:approval|permission|confirmation)\\s+(?:request|required|needed|before)",
  "\\bawaiting\\s+(?:your\\s+|owner\\s+)?(?:approval|confirmation|input|decision)\\b",
  "\\bdo\\s+you\\s+want\\b",
  "\\bwould\\s+you\\s+like\\b",
].join("|"), "i");

const PROGRESS_ONLY_PATTERN = /\b(?:in\s+progress|start(?:ing|ed)\b|now\s+implementing|working\s+on|will\s+(?:implement|start|run|fix|write|create|add)|about\s+to|intend\s+to|planning\s+to)\b/i;

const COMPLETION_MARKER_PATTERN = /\b(?:implement(?:ed|s)?|complet(?:e|ed|ion)|finished|done|fixed|resolved|added|created|updated|removed|deleted|refactored|migrated|integrated|delivered|pass(?:ed)?|success(?:ful)?)\b|[완료완성구현수정추가삭제통과성공]/i;

const EXECUTION_STREAM_MARKER_PATTERN = /\b(?:step_start|tool_use|content_block)\b/;

export function classifyWorkerFinalOutput(text: string): WorkerFinalSemantics {
  const value = String(text || "");
  if (QUESTION_OR_APPROVAL_PATTERN.test(value)) return "QUESTION_OR_APPROVAL_REQUEST";
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{") || EXECUTION_STREAM_MARKER_PATTERN.test(value)) return "EXECUTION_STREAM_NARRATION";
  if (PROGRESS_ONLY_PATTERN.test(value) && !COMPLETION_MARKER_PATTERN.test(value)) return "PROGRESS_ONLY_NARRATION";
  return "COMPLETED_RESULT";
}

/**
 * Mirrors normalizeReviewResult/normalizeQaResult for the implementation
 * Roles (DEVELOPER/DEBUGGER/REFACTORER), which previously trusted the raw
 * adapter `ok` with no semantic check at all. A Worker whose runner/transport
 * failed (e.g. a repeated Codex unified-exec pipe timeout) can still exit 0
 * with an empty or blank result; without this gate that was normalized into
 * a successful Developer completion and advanced straight to Review, leaving
 * the Reviewer to discover -- unassisted -- that nothing was ever implemented.
 *
 * Exit 0 with non-empty text is still not enough: the central semantic
 * admission (classifyWorkerFinalOutput) fails closed on questions, approval
 * requests, progress-only narration, and raw execution-stream narration --
 * none of which is a lawful terminal Developer result.
 */
export function normalizeDeveloperResult(result: AdapterTaskResult): NormalizedDeveloper {
  const text = String(result.output || "").trim();
  if (result.blockedReason) return { verdict: "DEVELOPER_BLOCKED", ok: false, findings: [`Worker execution blocked: ${result.blockedReason}`] };
  if (DEVELOPER_BLOCKED_PATTERN.test(text)) return { verdict: "DEVELOPER_BLOCKED", ok: false, findings: [text.slice(0, 500) || "Worker reported an explicit blocked execution"] };
  if (!result.ok) return { verdict: "DEVELOPER_FAIL", ok: false, findings: [text.slice(0, 500) || "Worker execution did not complete successfully"] };
  if (!text) return { verdict: "DEVELOPER_INDETERMINATE", ok: false, findings: ["Worker returned an empty result with no semantic evidence of Product work"] };
  const semantics = classifyWorkerFinalOutput(text);
  if (semantics === "QUESTION_OR_APPROVAL_REQUEST") return { verdict: "DEVELOPER_INDETERMINATE", ok: false, findings: ["Worker final output is a question or approval request, not a completed terminal result"] };
  if (semantics === "PROGRESS_ONLY_NARRATION") return { verdict: "DEVELOPER_INDETERMINATE", ok: false, findings: ["Worker final output is progress narration without a completed terminal result"] };
  if (semantics === "EXECUTION_STREAM_NARRATION") return { verdict: "DEVELOPER_INDETERMINATE", ok: false, findings: ["Worker final output is raw execution-stream narration without a completed terminal result"] };
  return { verdict: "DEVELOPER_PASS", ok: true, findings: [] };
}

export function canCompleteTeam(task: TaskRecord, roles: TaskRoleRecord[]): boolean {
  if (!roles.length || roles.some((role) => role.status !== "PASS")) return false;
  const reviewer = roles.find((role) => role.role === "REVIEWER");
  if (!reviewer || /\b(BLOCKED|FAIL|NOT\s+RUN|NOT\s+APPROVED)\b/i.test(`${reviewer.result || ""} ${reviewer.evidence.join(" ")}`)) return false;
  if (/INDEPENDENT_REVIEW_UNAVAILABLE|MANUAL_OVERRIDE_REJECTED/i.test(reviewer.routingReason || "")) return false;
  const qa = roles.find((role) => role.role === "QA");
  if (qa && /\b(BLOCKED|FAIL|NOT\s+RUN)\b/i.test(`${qa.result || ""} ${qa.evidence.join(" ")}`)) return false;
  const required = task.executionContract?.mode === "IMPLEMENT_AND_VALIDATE" ? task.validation : [];
  const developer = roles.find((role) => role.role === "DEVELOPER");
  if (required.length && !developer) return false;
  if (developer?.assignedAgent && reviewer.assignedAgent === developer.assignedAgent) return false;
  const qaContributors = new Set(roles.filter((r) => ["DEVELOPER", "DEBUGGER", "REFACTORER", "REVIEWER"].includes(r.role) && r.assignedAgent).map((r) => r.assignedAgent!));
  if (qa?.assignedAgent && qaContributors.has(qa.assignedAgent)) return false;
  if (!required.length) return true;
  const qaPresent = qa && qa.status === "PASS";
  if (qaPresent) return true;
  const devText = `${developer?.result || ""} ${developer?.evidence.join(" ")}`.toLowerCase();
  return !required.some((item) => !devText.includes(item.toLowerCase()));
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
