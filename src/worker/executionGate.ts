import type { ExecutionContract } from "../contracts/executionContract.js";
import type { Role } from "../domain/types.js";

/**
 * Per-Role execution permissions, derived from the Task's ExecutionContract but not
 * identical to it: Reviewer/Architect always run an independent review contract (verify,
 * never mutate) regardless of what the Task's own contract allows a Developer to do, and an
 * Expert invited into a Task is bounded to the scope it was invited for.
 */
export interface WorkerExecutionPermissions { canEdit: boolean; canTypecheck: boolean; canTest: boolean; canBuild: boolean; scope?: string[]; }
export interface ExecutionGateOptions { expertScope?: string[]; }

const REVIEW_ROLES: Role[] = ["REVIEWER", "ARCHITECT"];

export function resolvePermissions(role: Role, contract: ExecutionContract, options: ExecutionGateOptions = {}): WorkerExecutionPermissions {
  if (REVIEW_ROLES.includes(role)) {
    // Independent review contract: read + verify (typecheck/test/build to confirm evidence), never mutate the Product.
    return { canEdit: false, canTypecheck: true, canTest: true, canBuild: true };
  }
  if (options.expertScope?.length) {
    // Expert Agents only perform the bounded request they were invited for.
    return { canEdit: contract.canEditRequiredScope, canTypecheck: contract.canTypecheck, canTest: contract.canTest, canBuild: contract.canBuild, scope: options.expertScope };
  }
  // Developer/Debugger/Refactorer/QA/MCP_SPECIALIST: whatever IMPLEMENT_AND_VALIDATE vs READ_ONLY_DISCOVERY propagates from the Task.
  return { canEdit: contract.canEditRequiredScope, canTypecheck: contract.canTypecheck, canTest: contract.canTest, canBuild: contract.canBuild };
}

export function withinScope(filePath: string, scope: string[] | undefined): boolean {
  if (!scope || !scope.length) return true;
  return scope.some((pattern) => filePath === pattern || filePath.startsWith(pattern.replace(/\*+$/, "")));
}

export function assertMutationPermitted(role: Role, contract: ExecutionContract, filePath: string, options: ExecutionGateOptions = {}): void {
  const permissions = resolvePermissions(role, contract, options);
  if (!permissions.canEdit) throw new Error(`EXECUTION_NOT_PERMITTED: ${role} may not mutate ${filePath}`);
  if (!withinScope(filePath, permissions.scope)) throw new Error(`EXECUTION_NOT_PERMITTED: ${filePath} is outside the bounded Expert scope`);
}
