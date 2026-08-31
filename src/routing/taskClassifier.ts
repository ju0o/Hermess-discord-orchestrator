import { ROLES, TASK_TYPES, type Role, type TaskRecord, type TaskType } from "../domain/types.js";

export const DEFAULT_ROLE_POLICY: Record<TaskType, Role[]> = {
  FEATURE: ["DEVELOPER", "REVIEWER", "QA"], BUG: ["DEBUGGER", "REVIEWER", "QA"],
  REFACTOR: ["REFACTORER", "REVIEWER", "QA"], ARCHITECTURE: ["ARCHITECT", "DEVELOPER", "REVIEWER", "QA"],
  QA_ONLY: ["QA"], REVIEW_ONLY: ["REVIEWER"], MCP: ["MCP_SPECIALIST", "REVIEWER", "QA"],
  VALIDATION: ["QA"], SCRIPT: ["DEVELOPER"], UNKNOWN: ["DEVELOPER", "REVIEWER"],
};

export interface Classification { taskType: TaskType; requiredRoles: Role[]; source: "MANUAL_ROLES" | "EXPLICIT_TYPE" | "DETERMINISTIC_INFERENCE" | "SAFE_DEFAULT"; }

export function classifyTask(task: TaskRecord): Classification {
  const manual = uniqueRoles(task.requiredRoles ?? []); const explicit = task.taskType && TASK_TYPES.includes(task.taskType) ? task.taskType : undefined;
  if (manual.length) return { taskType: explicit || inferTaskType(task) || "UNKNOWN", requiredRoles: manual, source: "MANUAL_ROLES" };
  if (explicit) return { taskType: explicit, requiredRoles: [...DEFAULT_ROLE_POLICY[explicit]], source: "EXPLICIT_TYPE" };
  const inferred = inferTaskType(task); if (inferred) return { taskType: inferred, requiredRoles: [...DEFAULT_ROLE_POLICY[inferred]], source: "DETERMINISTIC_INFERENCE" };
  return { taskType: "UNKNOWN", requiredRoles: [...DEFAULT_ROLE_POLICY.UNKNOWN], source: "SAFE_DEFAULT" };
}

function inferTaskType(task: TaskRecord): TaskType | undefined {
  const text = `${task.title} ${task.goal}`.toLowerCase();
  if (/\bmcp\b|model context protocol/.test(text)) return "MCP";
  if (/\b(refactor|cleanup|restructure)\b/.test(text)) return "REFACTOR";
  if (/\b(architecture|architect|system design)\b/.test(text)) return "ARCHITECTURE";
  if (/\b(bug|debug|defect|fix crash|regression)\b/.test(text)) return "BUG";
  if (/\b(review only|code review)\b/.test(text)) return "REVIEW_ONLY";
  if (/\b(qa only|test only)\b/.test(text)) return "QA_ONLY";
  if (/\b(validate|validation|verify)\b/.test(text)) return "VALIDATION";
  if (/\b(script|powershell|batch file)\b/.test(text)) return "SCRIPT";
  if (/\b(feature|implement|add support|build)\b/.test(text)) return "FEATURE";
  return undefined;
}
function uniqueRoles(values: Role[]): Role[] { return [...new Set(values.filter((role) => ROLES.includes(role)))]; }
