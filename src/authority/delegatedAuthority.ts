export type AuthorityClass = "AUTO_DELEGATED" | "MAIN_DECISION" | "HUMAN_REQUIRED";

export interface AuthorityDecision {
  authorityClass: AuthorityClass;
  decisionReason: string;
  riskCategory: string;
  approvedBy?: string;
  decisionTimestamp: string;
}

export interface AuthorityInput {
  operation: string;
  detail?: string;
  retryCount?: number;
  retryLimit?: number;
}

const HUMAN_PATTERNS: Array<[RegExp, string]> = [
  [/production\s+deploy|deploy\s+to\s+production/i, "PRODUCTION_DEPLOY"],
  [/credential|secret|token|password|api\s*key/i, "CREDENTIAL_OR_SECRET"],
  [/paid\s+action|purchase|billing|cost\s+threshold/i, "PAID_ACTION"],
  [/delete\s+production|drop\s+(?:database|table)|destructive\s+(?:data|operation)/i, "DESTRUCTIVE_ACTION"],
  [/force\s+push|reset\s+--hard|rebase\s+-i|history\s+rewrite/i, "DESTRUCTIVE_GIT"],
  [/privacy|security\s+risk|legal\s+risk|irreversible/i, "SECURITY_PRIVACY_LEGAL"],
  [/material\s+(?:product\s+)?goal\s+change|value\s+judgment/i, "MATERIAL_GOAL_CHANGE"],
];

const MAIN_PATTERNS: Array<[RegExp, string]> = [
  [/architecture|implementation\s+strategy|bounded\s+scope|refactor/i, "ARCHITECTURE_OR_SCOPE"],
  [/expert\s+invite|dependency\s+task|project\s+priority|blocker\s+resolution/i, "PRODUCT_ORCHESTRATION_DECISION"],
  [/model\s+escalat|retry\s+limit|reassign(?:ment)?\s+limit/i, "POLICY_LIMIT_EXCEEDED"],
];

const AUTO_PATTERNS: Array<[RegExp, string]> = [
  [/retry|revision|validation|reconcile|recovery|workroom|context|rollover|handoff|stale\s+lease|state\s+repair|agent\s+reassign|transient/i, "OPERATIONAL_RECOVERY"],
];

export function classifyAuthority(input: AuthorityInput, now = new Date().toISOString()): AuthorityDecision {
  const text = `${input.operation} ${input.detail || ""}`;
  for (const [pattern, riskCategory] of HUMAN_PATTERNS) if (pattern.test(text)) {
    return { authorityClass: "HUMAN_REQUIRED", decisionReason: `Human-required risk matched: ${pattern.source}`, riskCategory, decisionTimestamp: now };
  }
  if (input.retryLimit !== undefined && (input.retryCount || 0) >= input.retryLimit) {
    return { authorityClass: "MAIN_DECISION", decisionReason: "Autonomous retry/recovery limit exceeded", riskCategory: "POLICY_LIMIT_EXCEEDED", decisionTimestamp: now };
  }
  for (const [pattern, riskCategory] of MAIN_PATTERNS) if (pattern.test(text)) {
    return { authorityClass: "MAIN_DECISION", decisionReason: `Main decision matched: ${pattern.source}`, riskCategory, decisionTimestamp: now };
  }
  const auto = AUTO_PATTERNS.find(([pattern]) => pattern.test(text));
  return { authorityClass: "AUTO_DELEGATED", decisionReason: auto ? `Operational recovery: ${auto[1]}` : "Default delegated engineering operation", riskCategory: auto?.[1] || "ENGINEERING_OPERATION", decisionTimestamp: now };
}

export function authorityAllowsAutomaticContinuation(decision: AuthorityDecision): boolean {
  return decision.authorityClass === "AUTO_DELEGATED";
}
