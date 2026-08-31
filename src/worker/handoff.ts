import type { Role } from "../domain/types.js";
import type { ReviewVerdict } from "../review/verdict.js";

/**
 * Pure Agent-to-Agent hand-off decisions. This module never resolves *who* the next Agent
 * is (that is the Router/Dispatcher's job) -- it only decides *what kind* of hand-off a
 * finished Role produces, so every Worker (Developer, Reviewer, Expert) computes it the
 * same way regardless of adapter.
 */
export type HandoffKind = "DEVELOPER_TO_REVIEWER" | "REVIEWER_TO_DEVELOPER_REVISION" | "REVIEWER_TO_COMPLETE" | "AGENT_TO_EXPERT" | "TERMINAL";

export interface HandoffInput { fromRole: Role; verdict?: ReviewVerdict; expertRequested?: boolean; currentRound: number; }
export interface HandoffDecision { kind: HandoffKind; nextRole?: Role; round: number; reason: string; }

const REVIEW_ROLES: Role[] = ["REVIEWER", "ARCHITECT"];

export function decideHandoff(input: HandoffInput): HandoffDecision {
  if (input.expertRequested) return { kind: "AGENT_TO_EXPERT", round: input.currentRound, reason: "Bounded Expert request scoped to the current Task" };
  if (input.fromRole === "DEVELOPER" || input.fromRole === "DEBUGGER" || input.fromRole === "REFACTORER") {
    return { kind: "DEVELOPER_TO_REVIEWER", nextRole: "REVIEWER", round: input.currentRound, reason: "Implementation complete; independent review required" };
  }
  if (REVIEW_ROLES.includes(input.fromRole)) {
    if (input.verdict === "REVIEW_PASS") return { kind: "REVIEWER_TO_COMPLETE", round: input.currentRound, reason: "Review passed with required validation evidence" };
    return { kind: "REVIEWER_TO_DEVELOPER_REVISION", nextRole: "DEVELOPER", round: input.currentRound + 1, reason: `Review verdict ${input.verdict ?? "REVIEW_INDETERMINATE"} requires Developer revision` };
  }
  return { kind: "TERMINAL", round: input.currentRound, reason: `${input.fromRole} produces no further hand-off` };
}
