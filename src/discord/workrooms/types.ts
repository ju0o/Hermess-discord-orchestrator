export const WORKROOM_STATES = ["ACTIVE", "ARCHIVED", "MISSING", "ACCESS_DENIED"] as const;
export type WorkroomState = (typeof WORKROOM_STATES)[number];

export const WORKROOM_REASONS = [
  "WORKROOM_CREATED", "WORKROOM_REUSED", "WORKROOM_REOPENED", "WORKROOM_ARCHIVED",
  "WORKROOM_ARCHIVE_FAILED", "WORKROOM_MISSING", "WORKROOM_PROJECT_NOT_FOUND",
  "WORKROOM_PROJECT_AMBIGUOUS", "THREAD_ACCESS_DENIED", "THREAD_MAPPING_REPAIRED", "WORKROOM_REACQUIRED",
] as const;
export type WorkroomReason = (typeof WORKROOM_REASONS)[number];

export interface WorkroomRecord {
  taskId: string;
  threadId: string;
  parentChannelId: string;
  threadName: string;
  state: WorkroomState;
  bootstrapMessageId?: string;
  createdAt: string;
  archivedAt?: string;
  lastSyncedAt: string;
  lastReason: WorkroomReason;
}

export interface DiscordThreadSnapshot {
  id: string;
  parentId: string;
  name: string;
  archived: boolean;
  canView: boolean;
  canSend: boolean;
}

export interface DiscordProjectChannelSnapshot {
  id: string;
  name: string;
  categoryId: string;
}

export interface DiscordWorkroomPort {
  ensureProjectChannel?(projectId: string, projectName: string): Promise<DiscordProjectChannelSnapshot>;
  getThread(threadId: string): Promise<DiscordThreadSnapshot | undefined>;
  createPublicThread(parentChannelId: string, name: string): Promise<DiscordThreadSnapshot>;
  setThreadArchived(threadId: string, archived: boolean): Promise<DiscordThreadSnapshot>;
  sendBootstrap(threadId: string, content: string): Promise<string>;
  sendControlMessage(threadId: string, content: string): Promise<string>;
  pinMessage(threadId: string, messageId: string): Promise<void>;
}

export class WorkroomError extends Error {
  constructor(readonly reason: WorkroomReason, message: string = reason) { super(message); this.name = "WorkroomError"; }
}
