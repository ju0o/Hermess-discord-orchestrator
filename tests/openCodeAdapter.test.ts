import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeAdapter } from "../src/agents/opencode/OpenCodeAdapter.js";
import type { ProcessRunner } from "../src/runtime/processRunner.js";
import type { ContextPackage } from "../src/domain/types.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** buildStart/buildResume are pure functions of context+options; they never touch the runner. */
type Buildable = { buildStart(context: ContextPackage, options: { model?: string }): { args: string[] }; buildResume(context: ContextPackage, sessionId: string, options: { model?: string }): { args: string[] }; };

function context(dir: string): ContextPackage {
  return {
    task: { taskId: "t-opencode", projectId: "p", title: "T", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"],
      status: "RUNNING", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN", attempt: 1, createdAt: new Date().toISOString(), evidence: [] },
    projectSsot: [], discord: [], memory: [], git: {}, files: [],
  };
}

describe("OpenCodeAdapter headless auto-approve profile", () => {
  it("advertises the review and testing capabilities used by bounded fallback routing", () => {
    const adapter = new OpenCodeAdapter({} as ProcessRunner);
    expect(adapter.capabilities).toEqual(expect.arrayContaining(["review", "testing", "repository_analysis"]));
  });

  it("includes --auto in the start command (unattended dispatch would otherwise hang on an interactive permission prompt)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-opencode-")); dirs.push(dir);
    const adapter = new OpenCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildStart(context(dir), {});
    expect(args).toContain("--auto");
    expect(args[0]).toBe("run"); // --auto must not disturb the existing subcommand/positional shape
  });

  it("includes --auto in the resume command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-opencode-")); dirs.push(dir);
    const adapter = new OpenCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildResume(context(dir), "session-123", {});
    expect(args).toContain("--auto");
    expect(args).toContain("session-123");
  });

  it("prints provider logs so a silent quota failure becomes watchdog evidence", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-opencode-")); dirs.push(dir);
    const adapter = new OpenCodeAdapter({} as ProcessRunner);
    const start = (adapter as unknown as Buildable).buildStart(context(dir), {}).args;
    const resume = (adapter as unknown as Buildable).buildResume(context(dir), "session-123", {}).args;
    expect(start).toContain("--print-logs");
    expect(resume).toContain("--print-logs");
  });

  it("keeps --model placement working alongside --auto", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-opencode-")); dirs.push(dir);
    const adapter = new OpenCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildStart(context(dir), { model: "anthropic/claude-sonnet" });
    expect(args).toContain("--auto");
    expect(args).toContain("--model");
    expect(args).toContain("anthropic/claude-sonnet");
  });
});
