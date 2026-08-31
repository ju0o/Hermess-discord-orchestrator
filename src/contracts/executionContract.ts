import type { TaskRecord } from "../domain/types.js";

export type ExecutionMode = "READ_ONLY_DISCOVERY" | "IMPLEMENT_AND_VALIDATE";

export interface ExecutionContract {
  mode: ExecutionMode;
  canRead: boolean;
  canEditRequiredScope: boolean;
  canTypecheck: boolean;
  canTest: boolean;
  canBuild: boolean;
  canResetDirtyWorkspace: boolean;
  canEditUnrelatedScope: boolean;
}

export const READ_ONLY_DISCOVERY: ExecutionContract = {
  mode: "READ_ONLY_DISCOVERY", canRead: true, canEditRequiredScope: false,
  canTypecheck: false, canTest: false, canBuild: false,
  canResetDirtyWorkspace: false, canEditUnrelatedScope: false,
};

export const IMPLEMENT_AND_VALIDATE: ExecutionContract = {
  mode: "IMPLEMENT_AND_VALIDATE", canRead: true, canEditRequiredScope: true,
  canTypecheck: true, canTest: true, canBuild: true,
  canResetDirtyWorkspace: false, canEditUnrelatedScope: false,
};

const GLOBAL_SOURCE_BLOCK = "source modification";
const IMPLEMENT_PROTECTIONS = ["unrelated modification", "dirty workspace preservation", "Auth preservation", "Firebase preservation", "reset", "clean", "stash", "commit", "merge", "rebase", "package installation", "deployment", "credential changes"];

export function contractProjectionContradiction(contract: ExecutionContract, protectedInvariants: string[]): boolean {
  return contract.mode === "IMPLEMENT_AND_VALIDATE" && contract.canEditRequiredScope
    && protectedInvariants.some((item) => item.trim().toLowerCase() === GLOBAL_SOURCE_BLOCK);
}

export function projectProtectedInvariants(contract: ExecutionContract, protectedInvariants: string[]): string[] {
  const filtered = protectedInvariants.filter((item) => item.trim().toLowerCase() !== GLOBAL_SOURCE_BLOCK);
  if (contract.mode === "READ_ONLY_DISCOVERY") return [...new Set([GLOBAL_SOURCE_BLOCK, ...filtered])];
  return [...new Set([...filtered, ...IMPLEMENT_PROTECTIONS])];
}

export function assertProjectionConsistency(contract: ExecutionContract, protectedInvariants: string[]): void {
  if (contractProjectionContradiction(contract, protectedInvariants)) throw new Error("CONTRACT_CONTRADICTION");
}

export function effectiveExecutionContract(task: TaskRecord): ExecutionContract {
  return task.executionContract || (mutationRequired(task) || task.role === "DEVELOPER" ? IMPLEMENT_AND_VALIDATE : READ_ONLY_DISCOVERY);
}

// English-keyword goal matching alone silently mis-defaults every non-English (e.g. Korean)
// DEVELOPER-role goal to READ_ONLY_DISCOVERY with no error (Company dogfood run,
// A prior bounded run: goal text was entirely Korean, matched no
// keyword, task.executionContract was unset, so the DEVELOPER task silently ran read-only).
// effectiveExecutionContract() additionally treats role === "DEVELOPER" as decisive.
export function mutationRequired(task: Pick<TaskRecord, "goal" | "validation">): boolean {
  return /\b(implement|fix|modify|edit|change|build failure|resolve)\b/i.test(`${task.goal} ${task.validation.join(" ")}`);
}

export function assertExecutionContract(contract: ExecutionContract | undefined, task: Pick<TaskRecord, "goal" | "validation">): ExecutionContract {
  if (!contract) {
    if (mutationRequired(task)) throw new Error("EXECUTION_CONTRACT_MISSING");
    return READ_ONLY_DISCOVERY;
  }
  if (contract.mode === "IMPLEMENT_AND_VALIDATE" && (!contract.canRead || !contract.canEditRequiredScope || !contract.canTypecheck || !contract.canTest || !contract.canBuild || contract.canResetDirtyWorkspace || contract.canEditUnrelatedScope)) {
    throw new Error("EXECUTION_CONTRACT_INVALID");
  }
  if (contract.mode === "READ_ONLY_DISCOVERY" && (contract.canEditRequiredScope || contract.canTypecheck || contract.canTest || contract.canBuild || contract.canResetDirtyWorkspace || contract.canEditUnrelatedScope)) {
    throw new Error("EXECUTION_CONTRACT_INVALID");
  }
  if (contract.mode === "READ_ONLY_DISCOVERY" && mutationRequired(task)) {
    throw new Error("EXECUTION_CONTRACT_INCOMPATIBLE");
  }
  return contract;
}
