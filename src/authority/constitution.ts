export const CONSTITUTION_VERSION = "1.0.0" as const;
export const CONSTITUTION_PATH = "docs/company/MAIN_HERMES_COMPANY_SUPERVISOR_CONSTITUTION.md" as const;

export const ASUS_ROLE = "LOCAL_ENGINEERING_SITE_MANAGER" as const;

export const ASUS_LOCAL_OBSERVATION = [
  "PROJECT_DIRECTORY", "FILES", "PRD_SSOT", "GIT_STATUS", "DIFF", "BUILD_LOGS",
  "RUNTIME_LOGS", "PROCESSES", "PORTS", "WORKSPACE_MAPPING", "SESSION_STATE", "AGENT_STATUS",
] as const;

export const ASUS_DELEGATED_PRODUCT_WORK = [
  "IMPLEMENT", "REFACTOR", "PRODUCT_BUG_FIX", "FEATURE_CODE", "LARGE_CODE_CHANGE",
] as const;

export const ASUS_AUTO_RECOVERY = [
  "SYMPHONY_ACTIVATION", "RUNTIME_RESTART", "STALE_LEASE", "WORKSPACE_MAPPING",
  "THREAD_SESSION_MAPPING", "WORKER_SESSION", "ROUTING", "CONTEXT_HANDOFF", "RETRY",
  "REASSIGNMENT", "TRANSIENT_PROVIDER_FAILURE", "MODEL_QUOTA_ROTATION",
] as const;

export type AsusLocalObservation = (typeof ASUS_LOCAL_OBSERVATION)[number];
export type AsusDelegatedProductWork = (typeof ASUS_DELEGATED_PRODUCT_WORK)[number];
export type AsusAutoRecovery = (typeof ASUS_AUTO_RECOVERY)[number];

export function constitutionReference(): { path: string; version: string; role: typeof ASUS_ROLE } {
  return { path: CONSTITUTION_PATH, version: CONSTITUTION_VERSION, role: ASUS_ROLE };
}

export function isAsusLocalObservation(operation: string): boolean {
  const normalized = operation.trim().toUpperCase().replace(/[ -]+/g, "_");
  return (ASUS_LOCAL_OBSERVATION as readonly string[]).includes(normalized);
}

export function isAsusProductImplementation(operation: string): boolean {
  const normalized = operation.trim().toUpperCase().replace(/[ -]+/g, "_");
  return (ASUS_DELEGATED_PRODUCT_WORK as readonly string[]).includes(normalized);
}

export function isAsusAutoRecovery(operation: string): boolean {
  const normalized = operation.trim().toUpperCase().replace(/[ -]+/g, "_");
  return (ASUS_AUTO_RECOVERY as readonly string[]).includes(normalized);
}
