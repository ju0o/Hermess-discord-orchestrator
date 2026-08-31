import { config } from "../../config/env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redact } from "../../security/redaction.js";
import type { AdapterTaskResult, Capability, ContextPackage, HealthResult } from "../../domain/types.js";
import type { RunOutput } from "../../runtime/processRunner.js";
import { BaseCliAdapter } from "../baseCliAdapter.js";
import type { AdapterExecutionOptions } from "../adapter.js";
import { findDeepString, parseJsonLines } from "../json.js";

export class OpenCodeAdapter extends BaseCliAdapter {
  protected readonly providerId = "opencode-go";
  protected providerForModel(model?: string) { return model?.includes("/") ? model.split("/")[0]! : this.providerId; }
  readonly id = "OPENCODE" as const; readonly name = "OpenCode";
  readonly capabilities: Capability[] = ["coding", "mcp", "provider_flexibility", "debugging", "testing", "review", "jutell", "repository_analysis"];
  protected readonly executable = config.OPENCODE_CLI;
  protected versionArgs() { return ["--version"]; }
  protected authArgs() { return ["providers", "list"]; }
  protected classifyAuth(output: RunOutput): HealthResult {
    const text = `${output.stdout}\n${output.stderr}`;
    return output.exitCode === 0 && !/0 credentials/i.test(text) ? { status: "ONLINE", detail: "OpenCode provider session usable" } : { status: "AUTH_REQUIRED", detail: "Configure an OpenCode provider on ASUS" };
  }
  protected buildStart(context: ContextPackage, options: AdapterExecutionOptions) {
    const file = this.contextFile(context);
    // --auto is required for unattended/headless Runtime dispatch: without it OpenCode 1.18.18
    // blocks on an interactive permission prompt for the first tool call and the Task hangs
    // until timeout. Owner-approved execution profile (2026-08 findings); mirrors the equivalent
    // non-interactive flag every sibling adapter already sets (Claude Code --permission-mode
    // acceptEdits, CommandCode --yolo, Codex --ask-for-approval never).
    // OpenCode otherwise keeps provider failures (including exhausted usage quota)
    // in its private application log while the headless CLI remains alive and
    // silent. Printing those logs gives the durable watchdog progress evidence it
    // can classify without polling OpenCode or relying on an operator turn.
    return { args: ["run", "Execute the attached HERMESS task context.", "--format", "json", "--print-logs", "--dir", context.task.workspace, "--auto", ...(options.model ? ["--model", options.model] : []), "--file", file], cleanup: [file] };
  }
  protected buildResume(context: ContextPackage, sessionId: string, options: AdapterExecutionOptions) {
    const file = this.contextFile(context);
    return { args: ["run", "Continue with the attached HERMESS task context.", "--format", "json", "--print-logs", "--dir", context.task.workspace, "--session", sessionId, "--auto", ...(options.model ? ["--model", options.model] : []), "--file", file], cleanup: [file] };
  }
  protected parseResult(output: RunOutput): AdapterTaskResult {
    const events = parseJsonLines(output.stdout);
    // The Worker's terminal report is the LAST {"type":"text"} stream event
    // (part.text); the final event of a completed run is always step_finish,
    // which carries no text/content/result key (live D-023 2026-08-25: the
    // lawful "# RESULT … implementation-complete" report was dropped and the
    // entire raw stream became the "result", which semantic admission then
    // lawfully rejected as EXECUTION_STREAM_NARRATION). Sessions that produced
    // no text event still fall through to the raw-stream fallback and fail
    // closed downstream.
    const lastText = [...events].reverse().find((event) => event.type === "text");
    const text = findDeepString(lastText, ["text", "content", "result"])
      || findDeepString(events.at(-1), ["text", "content", "result"])
      || output.stdout.trim()
      || output.stderr.trim();
    const sessionId = events.map((event) => findDeepString(event, ["sessionID", "session_id", "sessionId"])).find(Boolean);
    return { ok: output.exitCode === 0, output: text, ...(sessionId ? { sessionId } : {}), evidence: [output.logPath], exitCode: output.exitCode };
  }
  private contextFile(context: ContextPackage): string {
    const directory = path.join(config.dataDir, "runtime-context"); mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${context.task.taskId.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`);
    writeFileSync(file, redact(this.prompt(context)), { encoding: "utf8", mode: 0o600 }); return file;
  }
}
