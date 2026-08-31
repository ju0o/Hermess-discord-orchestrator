import { spawnSync } from "node:child_process";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() : `ERROR: ${(result.stderr || "git failed").trim()}`;
}

export function collectGitContext(workspace: string): Record<string, unknown> {
  const inside = git(workspace, "rev-parse", "--is-inside-work-tree");
  if (inside !== "true") return { repository: false, detail: inside };
  return {
    repository: true,
    branch: git(workspace, "branch", "--show-current"),
    head: git(workspace, "rev-parse", "HEAD"),
    status: git(workspace, "status", "--short"),
    worktree: git(workspace, "rev-parse", "--show-toplevel"),
    recentCommits: git(workspace, "log", "-5", "--oneline", "--decorate"),
    diffStat: git(workspace, "diff", "--stat"),
  };
}
