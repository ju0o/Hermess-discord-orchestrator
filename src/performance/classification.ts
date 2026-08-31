import type { ContextFailureCategory, DataClass, PerformanceFailureCategory, TaskRecord } from "../domain/types.js";

export function classifyData(task: Pick<TaskRecord, "taskId" | "dataClass"> & { projectId?: string; projectStatus?: string }): DataClass {
  if (task.dataClass) return task.dataClass;
  if (/TEST/i.test(task.projectStatus || "") || /(?:^|[-_])test(?:$|[-_])/i.test(task.projectId || "")) return "TEST";
  if (/CANARY|E2E/i.test(task.projectStatus || "") || /(?:^|[-_])(?:canary|e2e)(?:$|[-_])/i.test(task.projectId || "")) return "CANARY";
  if (/^SYM-(?:E2E|WORKROOM|TEAM|DISCUSS|EXPERT|PERF)-/i.test(task.taskId)) return "CANARY";
  if (/^(?:TEST|SPEC|FIXTURE)-/i.test(task.taskId)) return "TEST";
  return "REAL_PROJECT";
}

export function classifyFailure(value: unknown): PerformanceFailureCategory | null {
  const text = String(value || "").toUpperCase(); if (!text) return null;
  if (/HUMAN_GATE|WAITING_MAIN|APPROVAL/.test(text)) return "HUMAN_GATE";
  if (/AUTH|LOGIN|CREDENTIAL/.test(text)) return "AUTH";
  if (/NETWORK|ECONN|DNS|TIMEOUT/.test(text)) return "NETWORK";
  if (/WORKSPACE[ _-]?CONFLICT|FILE[ _-]?CONFLICT|LOCK/.test(text)) return "WORKSPACE_CONFLICT";
  if (/CONTEXT|FILE_SCOPE/.test(text)) return "CONTEXT";
  if (/MODEL_CAPABILITY|MODEL_TIER|MODEL_ROUTING/.test(text)) return "MODEL_CAPABILITY";
  if (/AGENT_CAPABILITY|NO_ELIGIBLE_AGENT|CAPABILITY_MISMATCH/.test(text)) return "AGENT_CAPABILITY";
  if (/TYPECHECK|\bTEST\b|ASSERT|VITEST|JEST/.test(text)) return "TEST";
  if (/\bBUILD\b|COMPILE|TSC/.test(text)) return "BUILD";
  if (/REVIEW|REVISION/.test(text)) return "REVIEW";
  if (/QA_RESULT|\bQA\b/.test(text)) return "QA";
  if (/CLI_NOT_FOUND|ENVIRONMENT|PROCESS|SPAWN/.test(text)) return "ENVIRONMENT";
  if (/TOOL|COMMAND|EXIT CODE/.test(text)) return "TOOL";
  if (/PROJECT/.test(text)) return "PROJECT";
  return "UNKNOWN";
}

export function classifyContextFailure(value: unknown): ContextFailureCategory | null {
  const text = String(value || "").toUpperCase();
  if (/MISSING_REQUIRED_CONTEXT/.test(text)) return "MISSING_REQUIRED_CONTEXT";
  if (/STALE_CONTEXT/.test(text)) return "STALE_CONTEXT";
  if (/WRONG_PROJECT_CONTEXT/.test(text)) return "WRONG_PROJECT_CONTEXT";
  if (/INSUFFICIENT_FILE_SCOPE/.test(text)) return "INSUFFICIENT_FILE_SCOPE";
  if (/CONTEXT_TOO_LARGE/.test(text)) return "CONTEXT_TOO_LARGE";
  return null;
}
