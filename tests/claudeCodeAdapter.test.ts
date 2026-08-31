import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../src/agents/claude-code/ClaudeCodeAdapter.js";
import type { ProcessRunner } from "../src/runtime/processRunner.js";
import type { ContextPackage } from "../src/domain/types.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** buildStart/buildResume are pure functions of context+options; they never touch the runner. */
type Buildable = { buildStart(context: ContextPackage, options: { model?: string }): { args: string[] }; buildResume(context: ContextPackage, sessionId: string, options: { model?: string }): { args: string[] }; };

function context(dir: string): ContextPackage {
  return {
    task: { taskId: "t-claudecode", projectId: "p", title: "T", goal: "G", role: "REVIEWER", requiredCapabilities: ["review"],
      status: "RUNNING", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: ["npm run typecheck", "npm run test", "npm run build"], owner: "MAIN", attempt: 1, createdAt: new Date().toISOString(), evidence: [] },
    projectSsot: [], discord: [], memory: [], git: {}, files: [],
  };
}

describe("ClaudeCodeAdapter headless Reviewer validation-execution profile", () => {
  // A prior bounded run: a headless CLAUDE_CODE REVIEWER
  // session with no --allowedTools had every Bash/PowerShell call denied (including harmless
  // `git --version`), so it could not run the mandated npm run typecheck/test/build and correctly
  // reported "Validation -- BLOCKED" instead of fabricating a result. normalizeReviewResult() then
  // routed that as REVISION_REQUIRED back to the Developer, who has no code defect to fix. Adding a
  // narrow --allowedTools for exactly the validation commands (not general Bash/write authority)
  // lets the Reviewer actually execute the evidence it must report on.
  it("includes a scoped --allowedTools covering typecheck/test/build in the start command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-claudecode-")); dirs.push(dir);
    const adapter = new ClaudeCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildStart(context(dir), {});
    expect(args).toContain("--allowedTools");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    expect(allowed).toContain("Bash(npm run typecheck:*)");
    expect(allowed).toContain("Bash(npm test:*)");
    expect(allowed).toContain("Bash(npm run test:*)");
    expect(allowed).toContain("Bash(npm run build:*)");
    // Edit/Write approval is untouched -- this only unblocks read-only validation execution.
    expect(args).toContain("--permission-mode");
    expect(args).toContain("acceptEdits");
  });

  it("includes the same scoped --allowedTools in the resume command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-claudecode-")); dirs.push(dir);
    const adapter = new ClaudeCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildResume(context(dir), "session-123", {});
    expect(args).toContain("--allowedTools");
    expect(args).toContain("session-123");
  });

  it("keeps --model placement working alongside --allowedTools", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-claudecode-")); dirs.push(dir);
    const adapter = new ClaudeCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildStart(context(dir), { model: "opus" });
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });
});
