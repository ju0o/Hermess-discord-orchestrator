import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandCodeAdapter } from "../src/agents/command-code/CommandCodeAdapter.js";
import type { ProcessRunner, RunOutput } from "../src/runtime/processRunner.js";
import type { ContextPackage } from "../src/domain/types.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** buildStart/buildResume are pure functions of context+options; they never touch the runner. */
type Buildable = { buildStart(context: ContextPackage, options: { model?: string }): { args: string[] }; buildResume(context: ContextPackage, sessionId: string, options: { model?: string }): { args: string[] }; };

function context(dir: string): ContextPackage {
  return {
    task: { taskId: "t-commandcode", projectId: "p", title: "T", goal: "G", role: "DEVELOPER", requiredCapabilities: ["coding"],
      status: "RUNNING", workspace: dir, readContext: {}, fileScope: [], doNot: [], validation: [], owner: "MAIN", attempt: 1, createdAt: new Date().toISOString(), evidence: [] },
    projectSsot: [], discord: [], memory: [], git: {}, files: [],
  };
}

describe("CommandCodeAdapter headless write-authorized (yolo) profile", () => {
  // A prior bounded run: the prior
  // "--permission-mode auto-accept" flag still refuses write_file/bash tool calls in --print
  // (headless) mode -- the real CLI error was "Use --yolo (or --dangerously-skip-permissions) to
  // enable file writes and shell commands in print mode." A DEVELOPER-role Task exited 0 having
  // written zero files, then a retry exited non-zero once it actually tried to write. --yolo is
  // the Owner-approved Developer profile (`cmdc --yolo`).
  it("includes --yolo (not --permission-mode auto-accept) in the start command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-commandcode-")); dirs.push(dir);
    const adapter = new CommandCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildStart(context(dir), {});
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("auto-accept");
  });

  it("includes --yolo in the resume command", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-commandcode-")); dirs.push(dir);
    const adapter = new CommandCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildResume(context(dir), "session-123", {});
    expect(args).toContain("--yolo");
    expect(args).toContain("session-123");
    expect(args).not.toContain("--permission-mode");
  });

  it("keeps --model placement working alongside --yolo", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-commandcode-")); dirs.push(dir);
    const adapter = new CommandCodeAdapter({} as ProcessRunner);
    const { args } = (adapter as unknown as Buildable).buildStart(context(dir), { model: "anthropic/claude-sonnet" });
    expect(args).toContain("--yolo");
    expect(args).toContain("--model");
    expect(args).toContain("anthropic/claude-sonnet");
  });
});

describe("CommandCodeAdapter CLI health classification", () => {
  const output = (overrides: Partial<RunOutput> = {}): RunOutput => ({ stdout: "", stderr: "", exitCode: 0, processId: "probe", logPath: "probe.log", ...overrides });
  const adapterFor = (...responses: Array<RunOutput | Error>) => {
    const runner = { probe: async () => {
      const response = responses.shift();
      if (!response) throw new Error("missing probe response");
      if (response instanceof Error) throw response;
      return response;
    } } as unknown as ProcessRunner;
    return new CommandCodeAdapter(runner);
  };

  it("reports CLI_NOT_FOUND only for an ENOENT spawn failure", async () => {
    await expect(adapterFor(output({ exitCode: null, spawnErrorCode: "ENOENT" })).healthCheck())
      .resolves.toMatchObject({ status: "CLI_NOT_FOUND" });
  });

  it.each([
    ["quota exhaustion", "quota exhausted"],
    ["model unavailability", "requested model unavailable"],
    ["generic non-zero exit", "unexpected process failure"],
  ])("does not label %s as CLI_NOT_FOUND", async (_name, stderr) => {
    await expect(adapterFor(output({ exitCode: 1, stderr })).healthCheck())
      .resolves.toMatchObject({ status: "ERROR" });
  });
});
