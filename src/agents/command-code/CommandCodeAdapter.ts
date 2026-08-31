import { config } from "../../config/env.js";
import type { AdapterTaskResult, Capability, ContextPackage, HealthResult } from "../../domain/types.js";
import type { RunOutput } from "../../runtime/processRunner.js";
import { BaseCliAdapter } from "../baseCliAdapter.js";
import type { AdapterExecutionOptions } from "../adapter.js";
import { findDeepString, parseJsonLines } from "../json.js";

export class CommandCodeAdapter extends BaseCliAdapter {
  protected readonly providerId = "command-code";
  readonly id = "COMMAND_CODE" as const; readonly name = "Command Code";
  readonly capabilities: Capability[] = ["coding", "refactoring", "debugging", "testing", "review", "repository_analysis"];
  protected readonly executable = config.COMMAND_CODE_CLI;
  protected versionArgs() { return ["--no-auto-update", "--version"]; }
  protected authArgs() { return ["--no-auto-update", "status"]; }
  protected classifyAuth(output: RunOutput): HealthResult {
    const text = `${output.stdout}\n${output.stderr}`;
    return output.exitCode === 0 && /authentication verified|authenticated|logged.?in/i.test(text) ? { status: "ONLINE", detail: "Command Code session usable" } : { status: "AUTH_REQUIRED", detail: "Run commandcode login as the ASUS runtime user" };
  }
  // --yolo is required for unattended/headless Runtime dispatch: --permission-mode auto-accept
  // still refuses write_file/bash tool calls in --print mode ("Use --yolo (or
  // --dangerously-skip-permissions) to enable file writes and shell commands in print mode"),
  // which silently downgraded every DEVELOPER-role Command Code task to a no-op discovery run
  // (A prior bounded run: exit 0 with zero files written, then
  // exit 6 "Tool write_file requires permissions" once the task actually tried to write).
  protected buildStart(context: ContextPackage, options: AdapterExecutionOptions) {
    return { args: ["--no-auto-update", "--print", "--output-format", "json", "--yolo", "--skip-onboarding", ...(options.model ? ["--model", options.model] : [])], stdin: this.prompt(context) };
  }
  protected buildResume(context: ContextPackage, sessionId: string, options: AdapterExecutionOptions) {
    return { args: ["--no-auto-update", "--print", "--output-format", "json", "--yolo", "--skip-onboarding", "--session", sessionId, ...(options.model ? ["--model", options.model] : [])], stdin: this.prompt(context) };
  }
  protected parseResult(output: RunOutput): AdapterTaskResult {
    const events = parseJsonLines(output.stdout); const last = events.at(-1);
    // The terminal stream event carries the Worker's actual semantic final
    // report in `finalText`. Without it in the key list the parser fell back
    // to the entire raw stream-json narration (live D-023 QA 2026-08-24:
    // 1.3MB of tool events became the authoritative "result", burying the
    // explicit "Verdict: ACCEPT"), so the authority layer normalized
    // narration instead of the Worker's verdict.
    const text = findDeepString(last, ["result", "text", "content", "message", "finalText"]) || output.stdout.trim() || output.stderr.trim();
    const sessionId = events.map((event) => findDeepString(event, ["session_id", "sessionId"])).find(Boolean);
    const effectiveModel = events.map((event) => findDeepString(event, ["model"])).find(Boolean);
    return { ok: output.exitCode === 0, output: text, ...(sessionId ? { sessionId } : {}), ...(effectiveModel ? { effectiveModel, modelVerificationSource: "commandcode_model_event" } : {}), evidence: [output.logPath], exitCode: output.exitCode };
  }
}
