import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import type { ContextPackage, TaskRecord } from "../domain/types.js";
import type { TaskRepository } from "../tasks/repository.js";
import { readScopedFiles } from "./filesystem.js";
import { collectGitContext } from "./git.js";
import type { DiscordContextSource } from "./discord.js";
import type { MemoryRouter } from "./memoryRouter.js";
import { selectWorkroomContext } from "./workroom.js";

export class ContextResolver {
  constructor(private readonly tasks: TaskRepository, private readonly discord: DiscordContextSource, private readonly memory: MemoryRouter) {}

  async resolve(task: TaskRecord): Promise<ContextPackage> {
    const project = this.tasks.getProject(task.projectId);
    const projectSsot: Array<{ path: string; content: string }> = [];
    let remaining = config.MAX_CONTEXT_BYTES;
    for (const relative of project?.ssotPaths ?? []) {
      try {
        const absolute = path.resolve(task.workspace, relative); const root = path.resolve(task.workspace);
        if (!absolute.startsWith(root)) continue;
        const content = readFileSync(absolute, "utf8"); const bytes = Buffer.byteLength(content);
        if (bytes <= remaining) { projectSsot.push({ path: relative, content }); remaining -= bytes; }
      } catch { /* absent SSOT documents are represented by omission */ }
    }
    const discordMessages = [];
    if (task.readContext.currentTaskThread && task.threadId) discordMessages.push(...selectWorkroomContext(await this.discord.fetchThread(task.threadId)));
    for (const id of task.readContext.previousTaskThreadIds ?? []) discordMessages.push(...await this.discord.fetchThread(id));
    if (task.readContext.projectChannel && task.parentChannelId) discordMessages.push(...await this.discord.fetchChannel(task.parentChannelId));
    const memory = this.memory.resolve(task.projectId, task.assignedAgent, task.role, Boolean(task.readContext.myMemory));
    return {
      task, ...(project ? { project } : {}), projectSsot,
      discord: discordMessages.slice(-200), memory,
      git: collectGitContext(task.workspace),
      files: readScopedFiles(task.workspace, task.fileScope, remaining),
      priority: ["FILESYSTEM_GIT", "PROJECT_SSOT", "TASK_STATE", "DISCORD", "MEMORY"],
    };
  }
}
