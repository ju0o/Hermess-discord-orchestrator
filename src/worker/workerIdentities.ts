import { AGENT_IDS, type AgentId } from "../domain/types.js";
import { workerIdentity, type WorkerIdentity } from "./workerContract.js";

/**
 * The four Coding Agent Workers share one WorkerContract implementation end to end; only
 * the identity (AgentId <-> Discord BotType) differs. CLI/adapter differences already live
 * in src/agents/<agent>/*Adapter.ts and stay out of this module entirely.
 */
export const CLAUDE_CODE_WORKER: WorkerIdentity = workerIdentity("CLAUDE_CODE");
export const CODEX_WORKER: WorkerIdentity = workerIdentity("CODEX");
export const OPENCODE_WORKER: WorkerIdentity = workerIdentity("OPENCODE");
export const COMMANDCODE_WORKER: WorkerIdentity = workerIdentity("COMMAND_CODE");

export const CODING_AGENT_WORKERS: Record<AgentId, WorkerIdentity> = Object.fromEntries(
  AGENT_IDS.map((agentId) => [agentId, workerIdentity(agentId)]),
) as Record<AgentId, WorkerIdentity>;
