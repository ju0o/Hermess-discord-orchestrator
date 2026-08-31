import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { TaskRecord } from "../domain/types.js";

export interface GitSafetyReport { safe: boolean; repository: boolean; branch?: string; head?: string; dirty?: string; reason?: string; }

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 15_000 });
}

export function inspectGit(task: TaskRecord): GitSafetyReport {
  const inside = git(task.workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) return { safe: true, repository: false, reason: "Workspace is not a Git repository" };
  const branch = git(task.workspace, ["branch", "--show-current"]).stdout.trim();
  const head = git(task.workspace, ["rev-parse", "HEAD"]).stdout.trim();
  const dirty = git(task.workspace, ["status", "--porcelain"]).stdout.trim();
  if (dirty && task.fileScope.length === 0) return { safe: false, repository: true, branch, head, dirty, reason: "Dirty repository requires explicit FILE_SCOPE" };
  return { safe: true, repository: true, branch, head, dirty };
}

export function createIsolatedWorktree(task: TaskRecord, root: string): string {
  const worktree = path.join(root, task.projectId, task.taskId);
  mkdirSync(path.dirname(worktree), { recursive: true });
  const branch = `hermess/${task.taskId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60)}`;
  const result = git(task.workspace, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  if (result.status !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim()}`);
  return worktree;
}

export const FORBIDDEN_GIT_OPERATIONS = ["reset --hard", "push --force", "push -f", "rebase -i", "filter-branch"] as const;
