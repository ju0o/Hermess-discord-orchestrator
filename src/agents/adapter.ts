import type { AdapterTaskResult, AgentId, Capability, ContextPackage, HealthResult } from "../domain/types.js";

export interface AdapterExecutionOptions { model?: string; sessionId?: string; }
export interface ModelControlResult { supported: boolean; model?: string; provider?: string; effectiveModel?: string; detail: string; code?: string; }

export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly capabilities: Capability[];
  availability(): Promise<HealthResult>;
  authenticateCheck(): Promise<HealthResult>;
  startTask(context: ContextPackage, options?: AdapterExecutionOptions): Promise<AdapterTaskResult>;
  resumeTask(context: ContextPackage, sessionId: string, options?: AdapterExecutionOptions): Promise<AdapterTaskResult>;
  cancelTask(taskId: string): Promise<boolean>;
  getStatus(): Promise<HealthResult>;
  collectResult(taskId: string): Promise<AdapterTaskResult | undefined>;
  healthCheck(): Promise<HealthResult>;
  modelGet(): Promise<ModelControlResult>;
  modelSet(model: string): Promise<ModelControlResult>;
  modelClear(): Promise<ModelControlResult>;
}
