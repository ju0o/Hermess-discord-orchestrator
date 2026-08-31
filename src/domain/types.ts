export const AGENT_IDS = ["CODEX", "CLAUDE_CODE", "OPENCODE", "COMMAND_CODE"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const ROLES = [
  "DEVELOPER", "REVIEWER", "DEBUGGER", "QA", "REFACTORER", "ARCHITECT", "MCP_SPECIALIST",
] as const;
export type Role = (typeof ROLES)[number];

export type Capability =
  | "coding" | "refactoring" | "debugging" | "testing" | "review"
  | "repository_analysis" | "architecture" | "large_context_analysis"
  | "mcp" | "provider_flexibility" | "jutell";

export const TASK_STATUSES = [
  "QUEUED", "DISPATCHED", "CLAIMED", "RUNNING", "WAITING_RESULT", "REVIEWING",
  "PASS", "COMPLETED", "FAIL", "BLOCKED", "CANCELLED", "WAITING_MAIN", "HUMAN_GATE",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type AgentStatus = "OFFLINE" | "AVAILABLE" | "BUSY" | "WAITING" | "ERROR";
export type HealthStatus = "ONLINE" | "AUTH_REQUIRED" | "CLI_NOT_FOUND" | "ERROR";
export const COLLABORATION_EVENT_TYPES = [
  "QUESTION", "ANSWER", "PROPOSAL", "OBJECTION", "CLARIFICATION", "CONSENSUS",
  "EXPERT_REQUEST", "EXPERT_INVITE", "EXPERT_RESULT",
  "MEETING_INVITE", "CAPABILITY_REPORT", "EXECUTION_PROPOSAL", "RESOURCE_REPORT", "MODEL_PROPOSAL",
  "PARALLEL_PLAN", "DEPENDENCY_REPORT", "BLOCKER", "COUNTER_PROPOSAL", "ROLE_ACCEPT",
] as const;
export type CollaborationEventType = (typeof COLLABORATION_EVENT_TYPES)[number];
export type ProtocolEventType = "TASK" | "ACK" | "RESULT" | "REVIEW" | "QA_RESULT" | "VERDICT" | "COMPLETION" | "HANDOFF" | "REVISION_REQUEST" | "REVISION_RESULT" | CollaborationEventType;

export const MODEL_VERIFICATION_LEVELS = ["DISCOVERED", "CLI_REPORTED", "CONFIGURED", "EXECUTION_VERIFIED", "UNAVAILABLE"] as const;
export type ModelVerificationLevel = (typeof MODEL_VERIFICATION_LEVELS)[number];
export const REASONING_COMPLEXITIES = ["T0", "T1", "T2", "T3", "T4"] as const;
export type ReasoningComplexity = (typeof REASONING_COMPLEXITIES)[number];
export const MODEL_TIERS = ["CHEAP", "STANDARD", "STRONG", "FRONTIER"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const FAILURE_CATEGORIES = ["MODEL_CAPABILITY", "AGENT_CAPABILITY", "PROJECT", "ENVIRONMENT", "TOOL", "UNKNOWN"] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const DATA_CLASSES = ["CANARY", "TEST", "REAL_PROJECT"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const PERFORMANCE_FAILURE_CATEGORIES = [
  "PROJECT", "AGENT_CAPABILITY", "MODEL_CAPABILITY", "CONTEXT", "WORKSPACE_CONFLICT",
  "ENVIRONMENT", "TOOL", "AUTH", "NETWORK", "TEST", "BUILD", "REVIEW", "QA", "HUMAN_GATE", "UNKNOWN",
] as const;
export type PerformanceFailureCategory = (typeof PERFORMANCE_FAILURE_CATEGORIES)[number];
export const CONTEXT_FAILURE_CATEGORIES = [
  "MISSING_REQUIRED_CONTEXT", "STALE_CONTEXT", "WRONG_PROJECT_CONTEXT", "INSUFFICIENT_FILE_SCOPE", "CONTEXT_TOO_LARGE",
] as const;
export type ContextFailureCategory = (typeof CONTEXT_FAILURE_CATEGORIES)[number];

export interface ModelCatalogRecord {
  modelId: string;
  agentId: AgentId;
  provider: string;
  modelName: string;
  modelAlias?: string;
  displayName: string;
  available: boolean;
  verified: boolean;
  verificationLevel: ModelVerificationLevel;
  overrideSupported: boolean;
  overrideValue: string;
  resumeOverrideSupported: boolean;
  observedActualModel?: string;
  source: string;
  lastVerifiedAt: string;
  metadata: Record<string, unknown>;
}

export interface AgentModelPreference {
  agentId: AgentId;
  modelId: string;
  selectedModel: string;
  provider: string;
  selectedAt: string;
  source: string;
  verificationState: ModelVerificationLevel | "MODEL_REVALIDATION_REQUIRED";
}

export interface ModelTierMapping {
  agentId: AgentId;
  roleScope: Role | "*";
  modelTier: ModelTier;
  modelCatalogId: string;
  provider: string;
  verificationLevel: ModelVerificationLevel;
  enabled: boolean;
  source: string;
  reason: string;
  lastVerifiedAt: string;
}

export interface ModelRoutingDecision {
  decisionId: string;
  taskId: string;
  role: Role;
  agentId: AgentId;
  complexity: ReasoningComplexity;
  requestedTier: ModelTier;
  selectedTier?: ModelTier;
  modelCatalogId?: string;
  requestedModel?: string;
  provider?: string;
  reason: string;
  fallback: boolean;
  status: "SELECTED" | "BLOCKED";
  createdAt: string;
}

export interface ModelEscalationRecord {
  escalationId: string;
  taskId: string;
  role: Role;
  agentId: AgentId;
  fromTier: ModelTier;
  toTier?: ModelTier;
  fromModel: string;
  toModel?: string;
  failureCategory: FailureCategory;
  reason: string;
  attempt: number;
  evidence: string[];
  action: "RETRY_SAME_MODEL" | "ESCALATED" | "NO_ESCALATION" | "BLOCKED" | "AGENT_SWITCH_CANDIDATE";
  createdAt: string;
}

export const TASK_TYPES = ["FEATURE", "BUG", "REFACTOR", "ARCHITECTURE", "QA_ONLY", "REVIEW_ONLY", "MCP", "VALIDATION", "SCRIPT", "UNKNOWN"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const ROLE_STATUSES = ["PENDING", "ASSIGNED", "ACTIVE", "PASS", "FAIL", "BLOCKED", "SKIPPED"] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];
export type { ExecutionContract } from "../contracts/executionContract.js";
export type { AuthorityDecision, AuthorityClass } from "../authority/delegatedAuthority.js";

export interface AgentRecord {
  agentId: AgentId;
  displayName: string;
  backendType: string;
  /** Durable logical-to-Discord identity contract. */
  agentType?: string;
  discordBotId?: string;
  discordMention?: string;
  runtimeAdapter?: string;
  availableModels?: string[];
  status: AgentStatus;
  capabilities: Capability[];
  currentRole?: Role;
  currentProject?: string;
  currentTask?: string;
  workingDirectory?: string;
  sessionId?: string;
  lastSeen?: string;
  health: HealthStatus;
  healthDetail?: string;
}

export interface ReadContext {
  projectChannel?: boolean;
  currentTaskThread?: boolean;
  previousTaskThreadIds?: string[];
  decisions?: boolean;
  agentMemory?: boolean;
  myMemory?: boolean;
}

export interface TaskRecord {
  taskId: string;
  projectId: string;
  title: string;
  goal: string;
  role: Role;
  requiredCapabilities: Capability[];
  assignedAgent?: AgentId;
  status: TaskStatus;
  /** External reconciliation/recovery tasks remain non-runnable until released. */
  executionHold?: boolean;
  executionContract?: import("../contracts/executionContract.js").ExecutionContract;
  authority?: import("../authority/delegatedAuthority.js").AuthorityDecision;
  workspace: string;
  threadId?: string;
  parentChannelId?: string;
  readContext: ReadContext;
  fileScope: string[];
  doNot: string[];
  validation: string[];
  owner: string;
  nextOwner?: string;
  attempt: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  evidence: string[];
  lockToken?: string;
  taskType?: TaskType;
  requiredRoles?: Role[];
  agentOverrides?: Partial<Record<Role, AgentId>>;
  teamMode?: "SEQUENTIAL";
  currentRoleSequence?: number;
  completionCandidate?: boolean;
  complexity?: ReasoningComplexity;
  complexityReasons?: string[];
  complexitySource?: "MANUAL" | "DETERMINISTIC";
  modelTierOverride?: ModelTier;
  modelOverride?: string;
  dataClass?: DataClass;
  dataClassSource?: "MANUAL" | "INFERRED";
}

export interface TaskRoleRecord {
  taskId: string;
  role: Role;
  sequence: number;
  assignedAgent?: AgentId;
  status: RoleStatus;
  routingReason?: string;
  revisionRound: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  evidence: string[];
}

export interface DiscussionTopicRecord {
  topicId: string;
  taskId: string;
  topic: string;
  fingerprint: string;
  status: "ACTIVE" | "CONSENSUS" | "LIMIT_REACHED" | "ESCALATED";
  currentRound: number;
  createdBy: AgentId;
  consensus?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiscussionEventRecord {
  eventId: string;
  taskId: string;
  topicId: string;
  eventType: Exclude<CollaborationEventType, "EXPERT_REQUEST" | "EXPERT_INVITE" | "EXPERT_RESULT">;
  senderAgent: AgentId;
  recipientAgent: AgentId;
  senderRole: Role;
  recipientRole: Role;
  round: number;
  parentEventId?: string;
  content: string;
  nextOwner: string;
  status: "CREATED" | "SENT" | "RECEIVED" | "PROCESSED" | "BLOCKED";
  fingerprint: string;
  discordMessageId?: string;
  createdAt: string;
}

export interface ExpertRequestRecord {
  requestId: string;
  taskId: string;
  requestedRole: Role;
  requestedCapabilities: Capability[];
  reason: string;
  evidence: string[];
  requestingAgent: AgentId;
  urgency: "LOW" | "NORMAL" | "HIGH";
  scope: string[];
  status: "REQUESTED" | "INVITED" | "ACTIVE" | "PASS" | "FAIL" | "BLOCKED" | "UNAVAILABLE" | "NOT_NEEDED";
  selectedAgent?: AgentId;
  selectedTier?: ModelTier;
  selectedModel?: string;
  provider?: string;
  returnRoleSequence?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExpertMembershipRecord {
  taskId: string;
  role: Role;
  agentId: AgentId;
  requestId: string;
  status: "INVITED" | "ACTIVE" | "PASS" | "FAIL" | "BLOCKED";
  joinedAt: string;
  joinReason: string;
  requestedBy: AgentId;
  scope: string[];
  completedAt?: string;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  workspace: string;
  discordChannelId?: string;
  ssotPaths: string[];
  status: string;
}

export interface ProcessRecord {
  processId: string;
  agentId: AgentId;
  taskId: string;
  pid: number;
  workingDir: string;
  sessionId?: string;
  startedAt: string;
  lastSeen: string;
  exitCode?: number;
  status: "RUNNING" | "EXITED" | "LOST" | "CANCELLED";
  logPath: string;
}

export interface ContextPackage {
  task: TaskRecord;
  continuation?: {
    intentId: string; runId?: string; role: Role; revisionRound: number; instruction: string;
    evidenceReferences: import("../runtime/correction.js").ValidationEvidence[]; authoritySource: string; createdAt: string;
  };
  handoff?: import("../runtime/handoffContext.js").DurableHandoffContext;
  project?: ProjectRecord;
  projectSsot: Array<{ path: string; content: string }>;
  discord: Array<{ source: string; author: string; content: string; timestamp: string }>;
  memory: Array<{ source: string; content: string }>;
  git: Record<string, unknown>;
  files: Array<{ path: string; content: string }>;
  collaboration?: {
    mode: "DISCUSSION" | "EXPERT";
    topic?: string;
    prompt?: string;
    history: Array<{ eventType: string; sender: string; recipient: string; round: number; content: string }>;
    expertRequest?: { role: Role; reason: string; evidence: string[]; scope: string[]; requestedBy: AgentId };
  };
  priority: ["FILESYSTEM_GIT", "PROJECT_SSOT", "TASK_STATE", "DISCORD", "MEMORY"];
}

export interface AdapterTaskResult {
  ok: boolean;
  output: string;
  /** Process creation failed before the CLI could execute. */
  spawnErrorCode?: string;
  sessionId?: string;
  requestedModel?: string;
  effectiveModel?: string;
  provider?: string;
  modelVerificationSource?: string;
  evidence: string[];
  validationEvidence?: import("../runtime/correction.js").ValidationEvidence[];
  exitCode: number | null;
  /**
   * Set only when the CLI runner/transport itself failed to deliver a real
   * execution attempt (e.g. a repeated pipe-wedge timeout) rather than the
   * Worker completing and reporting a genuine outcome. A non-empty value here
   * always means BLOCKED, regardless of `ok` or `exitCode` -- a transport
   * failure must never be normalized into a successful Developer completion.
   */
  blockedReason?: string;
}

export interface HealthResult {
  status: HealthStatus;
  detail: string;
  version?: string;
}
