import { config } from "../../config/env.js";
import type { AdapterTaskResult, Capability, ContextPackage, HealthResult } from "../../domain/types.js";
import type { RunOutput } from "../../runtime/processRunner.js";
import { BaseCliAdapter } from "../baseCliAdapter.js";
import type { AdapterExecutionOptions } from "../adapter.js";
import { findDeepString, findLastDeepString, parseJsonLines } from "../json.js";

export class CodexAdapter extends BaseCliAdapter {
  protected readonly providerId = "openai-chatgpt";
  readonly id = "CODEX" as const; readonly name = "Codex";
  readonly capabilities: Capability[] = ["coding", "refactoring", "debugging", "testing", "review", "repository_analysis"];
  protected readonly executable = config.CODEX_CLI;
  protected versionArgs() { return ["--version"]; }
  protected authArgs() { return ["login", "status"]; }
  protected classifyAuth(output: RunOutput): HealthResult {
    const text = `${output.stdout}\n${output.stderr}`;
    return output.exitCode === 0 && /logged in/i.test(text) ? { status: "ONLINE", detail: "Codex CLI session usable" } : { status: "AUTH_REQUIRED", detail: "Run codex login as the ASUS runtime user" };
  }
  protected buildStart(context: ContextPackage, options: AdapterExecutionOptions) {
    return { args: ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "--json", "--color", "never", ...(options.model ? ["--model", options.model] : []), "-"], stdin: this.prompt(context) };
  }
  protected buildResume(context: ContextPackage, sessionId: string, options: AdapterExecutionOptions) {
    return { args: ["--sandbox", "workspace-write", "--ask-for-approval", "never", "exec", "resume", sessionId, "-", "--json", ...(options.model ? ["--model", options.model] : [])], stdin: this.prompt(context) };
  }
  protected parseResult(output: RunOutput): AdapterTaskResult {
    const events = parseJsonLines(output.stdout);
    const text = findLastDeepString(events, ["text", "output_text", "message"]) || output.stdout.trim() || output.stderr.trim();
    const sessionId = events.map((event) => findDeepString(event, ["thread_id", "session_id"])).find(Boolean);
    // A repeated unified-exec pipe-wedge timeout is a runner/transport
    // failure, not a completed attempt: Codex can still exit 0 after
    // reporting the pipe failure internally, so exitCode alone is not
    // trustworthy here. Fail closed regardless of exitCode or output text.
    //
    // CODEX_UNIFIED_EXEC_ELEVATED_SANDBOX_PROVISIONING (live D-023
    // a prior bounded run): live
    // evidence traced the pipe timeout past ProcessRunner's own respawn
    // boundary -- both the outer runner process and its pipe server start
    // and connect correctly on every attempt. The wedge is inside Codex's
    // own closed-source Windows unified-exec runner: with `--sandbox
    // read-only` or `--sandbox workspace-write`, each real shell tool call
    // provisions Codex's own restricted/elevated sandbox helper
    // (codex-windows-sandbox-setup.exe) over its own internal named pipe,
    // and that provisioning consistently exceeded Codex's hardcoded,
    // non-configurable 15000ms budget in an isolated reproduction unrelated
    // to any Product worktree -- reproduced identically on a fresh process
    // every time, so ProcessRunner's bounded respawn cannot recover it.
    // `codex doctor` names the actual cause: Microsoft Defender has no
    // exclusion for Codex's helper binaries (codex-windows-sandbox-setup.exe,
    // codex-command-runner.exe, codex-code-mode-host.exe), and this host's
    // `~/.codex/config.toml` selects the elevated Windows sandbox backend.
    // (An unelevated override avoids the timeout but every command then
    // fails immediately with STATUS_DLL_INIT_FAILED under the resulting
    // restricted token; only `danger-full-access` -- no restricted-token
    // provisioning at all -- ran cleanly. That removes the Reviewer's OS
    // sandbox boundary, so it is a deliberate operator decision, not
    // something this adapter changes on its own.) Fixing this requires a
    // host-level Defender exclusion (see `codex doctor`) or a `windows.
    // sandbox` policy change -- not a ProcessRunner/adapter code change --
    // so the fail-closed BLOCKED classification below is preserved exactly;
    // only the surfaced diagnosis is more actionable.
    if (output.transportWedgeExhausted) {
      return { ok: false, output: text ||
        "Codex unified-exec runner failed repeatedly (pipe timeout); no Product change or validation was executed. " +
        "This is Codex's own Windows sandbox-helper provisioning failing to connect within its internal 15000ms budget, " +
        "not a HERMESS runner/retry defect -- run `codex doctor` and add the reported Microsoft Defender exclusions for " +
        "Codex's helper binaries (or review the `[windows] sandbox` setting in ~/.codex/config.toml), then retry.",
        blockedReason: "CODEX_UNIFIED_EXEC_PIPE_TIMEOUT_EXHAUSTED", evidence: [output.logPath], exitCode: output.exitCode };
    }
    return { ok: output.exitCode === 0, output: text, ...(sessionId ? { sessionId } : {}), evidence: [output.logPath], exitCode: output.exitCode };
  }
}
