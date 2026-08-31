import { config } from "../../config/env.js";
import type { AdapterTaskResult, Capability, ContextPackage, HealthResult } from "../../domain/types.js";
import type { RunOutput } from "../../runtime/processRunner.js";
import { BaseCliAdapter } from "../baseCliAdapter.js";
import type { AdapterExecutionOptions } from "../adapter.js";
import { findDeepString, parseJsonLines } from "../json.js";

// A prior bounded run: a headless CLAUDE_CODE REVIEWER
// session with no --allowedTools had every Bash/PowerShell call denied -- including harmless
// read-only probes like `git --version` -- because --permission-mode acceptEdits auto-approves
// Edit/Write but still requires interactive approval for Bash, which never comes in --print mode.
// The reviewer correctly refused to fabricate typecheck/test/build results and returned
// "Validation -- BLOCKED", which normalizeReviewResult() (see src/worker/runtime.ts) then routed to
// REVISION_REQUIRED -- sent back to the Developer as a "fix this" request for a problem the
// Developer cannot fix (it isn't a code defect). This is not the same automatic-write-authority
// concern Section 14 warns about (Edit/Write approval is untouched): it only unblocks the exact
// read-only validation commands every Task's own `validation` field already mandates, so the
// Reviewer can execute -- not merely read -- the evidence it is required to report on.
const VALIDATION_ALLOWED_TOOLS = "Bash(npm run typecheck:*) Bash(npm test:*) Bash(npm run test:*) Bash(npm run build:*) Bash(npm run check:*) Bash(git status:*) Bash(git diff:*) Bash(git --version) Bash(node --version) Bash(npm --version)";

export class ClaudeCodeAdapter extends BaseCliAdapter {
  protected readonly providerId = "claude.ai";
  readonly id = "CLAUDE_CODE" as const; readonly name = "Claude Code";
  readonly capabilities: Capability[] = ["coding", "architecture", "debugging", "review", "large_context_analysis", "repository_analysis"];
  protected readonly executable = config.CLAUDE_CODE_CLI;
  protected defaultModel() { return "sonnet"; }
  protected versionArgs() { return ["--version"]; }
  protected authArgs() { return ["auth", "status"]; }
  protected classifyAuth(output: RunOutput): HealthResult {
    const text = `${output.stdout}\n${output.stderr}`;
    return output.exitCode === 0 && /"loggedIn"\s*:\s*true|logged.?in|authenticated/i.test(text) ? { status: "ONLINE", detail: "Claude Code session usable" } : { status: "AUTH_REQUIRED", detail: "Run claude login as the ASUS runtime user" };
  }
  protected buildStart(context: ContextPackage, options: AdapterExecutionOptions) {
    return { args: ["--safe-mode", "--setting-sources", "project,local", "--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "acceptEdits", "--allowedTools", VALIDATION_ALLOWED_TOOLS, "--model", options.model || "sonnet"], stdin: this.prompt(context) };
  }
  protected buildResume(context: ContextPackage, sessionId: string, options: AdapterExecutionOptions) {
    return { args: ["--safe-mode", "--setting-sources", "project,local", "--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "acceptEdits", "--allowedTools", VALIDATION_ALLOWED_TOOLS, "--resume", sessionId, "--model", options.model || "sonnet"], stdin: this.prompt(context) };
  }
  protected parseResult(output: RunOutput): AdapterTaskResult {
    const events = parseJsonLines(output.stdout); const result = [...events].reverse().find((e) => e.type === "result") || events.at(-1);
    const text = findDeepString(result, ["result", "text", "content"]) || output.stdout.trim() || output.stderr.trim();
    const sessionId = findDeepString(result, ["session_id"]);
    const effectiveModel = events.map((event) => findDeepString(event, ["model"])).find((value) => /^claude-/i.test(value || ""));
    return { ok: output.exitCode === 0, output: text, ...(sessionId ? { sessionId } : {}), ...(effectiveModel ? { effectiveModel, modelVerificationSource: "claude_stream_event" } : {}), evidence: [output.logPath], exitCode: output.exitCode };
  }
}
