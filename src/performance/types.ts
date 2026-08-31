import type { AgentId, DataClass, Role } from "../domain/types.js";

export type Confidence = "NO_DATA" | "INSUFFICIENT_DATA" | "EARLY_SIGNAL" | "OBSERVED";
export interface PerformanceFilter { dataClass?: DataClass | "ALL"; projectId?: string; }
export interface PerformanceSummary {
  subject: string; dataClass: DataClass | "ALL"; executions: number; pass: number; fail: number; blocked: number;
  revisions: number; meanDurationMs: number | null; confidence: Confidence; lastActiveAt?: string;
}
export interface PerformanceObserver { observeTask(taskId: string): void | Promise<void>; }
export interface AgentPerformanceQuery { agentId?: AgentId; role?: Role; modelAgentId?: AgentId; }
