import { existsSync, rmSync } from "node:fs";
import type { AdapterTaskResult, AgentId, Capability, ContextPackage, HealthResult } from "../domain/types.js";
import type { ProcessRunner, RunOutput } from "../runtime/processRunner.js";
import type { AgentAdapter, AdapterExecutionOptions, ModelControlResult } from "./adapter.js";
import { safeError } from "../security/redaction.js";
import { effectiveExecutionContract } from "../contracts/executionContract.js";
import { canonicalValidationEvidence, captureProductDigest, gitValue, type ValidationEvidence, type ValidationType } from "../runtime/correction.js";

export abstract class BaseCliAdapter implements AgentAdapter {
  private readonly results = new Map<string, AdapterTaskResult>();
  private selectedModel: string | undefined;
  abstract readonly id: AgentId;
  abstract readonly name: string;
  abstract readonly capabilities: Capability[];
  protected abstract readonly executable: string;
  protected abstract versionArgs(): string[];
  protected abstract authArgs(): string[];
  protected abstract classifyAuth(output: RunOutput): HealthResult;
  protected abstract buildStart(context: ContextPackage, options: AdapterExecutionOptions): { args: string[]; stdin?: string; cleanup?: string[] };
  protected abstract buildResume(context: ContextPackage, sessionId: string, options: AdapterExecutionOptions): { args: string[]; stdin?: string; cleanup?: string[] };
  protected abstract parseResult(output: RunOutput): AdapterTaskResult;
  protected abstract readonly providerId: string;
  protected defaultModel(): string | undefined { return undefined; }
  protected providerForModel(_model?: string): string { return this.providerId; }

  constructor(protected readonly runner: ProcessRunner) {}

  async availability(): Promise<HealthResult> { return this.healthCheck(); }
  async authenticateCheck(): Promise<HealthResult> {
    try { return this.classifyAuth(await this.runner.probe(this.executable, this.authArgs())); }
    catch (error) { return probeExceptionResult(error); }
  }
  async healthCheck(): Promise<HealthResult> {
    try {
      const version = await this.runner.probe(this.executable, this.versionArgs());
      if (version.spawnErrorCode === "ENOENT") return { status: "CLI_NOT_FOUND", detail: "CLI executable was not found" };
      if (version.exitCode !== 0) return { status: "ERROR", detail: version.stderr || `CLI version probe exited ${version.exitCode}` };
      const auth = await this.authenticateCheck();
      const versionText = (version.stdout || version.stderr).trim().split(/\r?\n/)[0];
      return { ...auth, ...(versionText ? { version: versionText } : {}) };
    } catch (error) { return probeExceptionResult(error); }
  }

  async startTask(context: ContextPackage, options: AdapterExecutionOptions = {}): Promise<AdapterTaskResult> {
    const resolved = this.resolveOptions(options); return this.execute(context, this.buildStart(context, resolved), resolved.model);
  }
  async resumeTask(context: ContextPackage, sessionId: string, options: AdapterExecutionOptions = {}): Promise<AdapterTaskResult> {
    const resolved = this.resolveOptions(options); return this.execute(context, this.buildResume(context, sessionId, resolved), resolved.model);
  }
  async cancelTask(taskId: string): Promise<boolean> { return this.runner.cancelTask(taskId); }
  async getStatus(): Promise<HealthResult> { return this.healthCheck(); }
  async collectResult(taskId: string): Promise<AdapterTaskResult | undefined> { return this.results.get(taskId); }
  async modelGet(): Promise<ModelControlResult> { return { supported: true, ...(this.selectedModel ? { model: this.selectedModel } : {}), detail: this.selectedModel || "CLI default" }; }
  async modelSet(model: string): Promise<ModelControlResult> { this.selectedModel = model; return { supported: true, model, detail: "Applied to future invocations" }; }
  async modelClear(): Promise<ModelControlResult> { this.selectedModel = undefined; return { supported: true, detail: "CLI default" }; }

  protected prompt(context: ContextPackage): string {
    return [
      "You are a worker in HERMESS Symphony Coding Team. Work only within the authorized scope.",
      "Return a concise RESULT with changed files, validation, evidence, blockers, and any human decision required.",
      ...(context.continuation ? [
        `CURRENT_CONTINUATION_INTENT (AUTHORITATIVE IMMEDIATE ACTION):\n${context.continuation.instruction}`,
        `ORIGINAL_TASK_GOAL (HISTORICAL BACKGROUND ONLY):\n${context.task.goal}`,
        `EXISTING_EVIDENCE_REFERENCES (REFERENCES, NOT NEW COMMANDS):\n${JSON.stringify(context.continuation.evidenceReferences, null, 2)}`,
      ] : []),
      ...(context.handoff ? [
        `CURRENT_HANDOFF_ACTION (AUTHORITATIVE IMMEDIATE ACTION):\n${context.handoff.currentAction}`,
        `ORIGINAL_TASK_GOAL (HISTORICAL BACKGROUND ONLY):\n${context.handoff.originalGoal}`,
        `PREVIOUS_ROLE_RESULT_AND_EVIDENCE (IMMUTABLE):\n${JSON.stringify(context.handoff, null, 2)}`,
        "Structured reused evidence may be relied on. Additional independent execution is required only when this Role's contract requires it.",
      ] : []),
      `EXECUTION_CONTRACT:\n${JSON.stringify(effectiveExecutionContract(context.task), null, 2)}`,
      `AUTHORITY_DECISION:\n${JSON.stringify(context.task.authority || { authorityClass: "AUTO_DELEGATED", decisionReason: "Default delegated engineering operation", riskCategory: "ENGINEERING_OPERATION" }, null, 2)}`,
      JSON.stringify(context, null, 2),
    ].join("\n\n");
  }

  private resolveOptions(options: AdapterExecutionOptions): AdapterExecutionOptions {
    const model = options.model || this.selectedModel || this.defaultModel();
    return { ...options, ...(model ? { model } : {}) };
  }

  private async execute(context: ContextPackage, command: { args: string[]; stdin?: string; cleanup?: string[] }, requestedModel?: string): Promise<AdapterTaskResult> {
    if (!existsSync(context.task.workspace)) return { ok: false, output: `Workspace not found: ${context.task.workspace}`, evidence: [], exitCode: null };
    try {
      const raw = await this.runner.run({ agentId: this.id, taskId: context.task.taskId, executable: this.executable,
        args: command.args, cwd: context.task.workspace, ...(command.stdin !== undefined ? { stdin: command.stdin } : {}) });
      const parsed = this.parseResult(raw);
      const validationEvidence = parsed.ok ? await this.executeValidation(context) : [];
      const result: AdapterTaskResult = { ...parsed, ...(raw.spawnErrorCode ? { spawnErrorCode: raw.spawnErrorCode } : {}), ...(requestedModel ? { requestedModel } : {}), provider: parsed.provider || this.providerForModel(requestedModel),
        validationEvidence,
        ...(!parsed.effectiveModel && requestedModel && parsed.ok ? { effectiveModel: requestedModel, modelVerificationSource: "explicit_cli_override_success" } : {}) };
      this.results.set(context.task.taskId, result); return result;
    } catch (error) {
      const spawnErrorCode = (error as NodeJS.ErrnoException).code;
      const result = { ok: false, output: safeError(error), evidence: [], exitCode: null,
        ...(spawnErrorCode ? { spawnErrorCode } : {}) } satisfies AdapterTaskResult;
      this.results.set(context.task.taskId, result); return result;
    } finally {
      for (const file of command.cleanup ?? []) { try { rmSync(file, { force: true }); } catch { /* recovery prunes local data */ } }
    }
  }

  private async executeValidation(context: ContextPackage): Promise<ValidationEvidence[]> {
    const observations: Array<{ command: string; output: RunOutput }> = [];
    for (const command of context.task.validation) {
      const argv = splitValidationCommand(command);
      if (!argv.length) continue;
      const output = await this.runner.run({ agentId: this.id, taskId: context.task.taskId, executable: argv[0]!, args: argv.slice(1), cwd: context.task.workspace });
      observations.push({ command, output });
      if (output.exitCode !== 0) break;
    }
    const head = gitValue(context.task.workspace, "rev-parse", "HEAD");
    const branch = gitValue(context.task.workspace, "branch", "--show-current");
    const productDigest = captureProductDigest(context.task.workspace);
    return observations.map(({ command, output }) => canonicalValidationEvidence({
        task_id: context.task.taskId, attempt: context.task.attempt, worker_id: this.id, role: context.task.role,
        type: validationType(command), command, exit_code: output.exitCode, status: output.exitCode === 0 ? "PASS" : "FAIL",
        timestamp: new Date().toISOString(), worktree: context.task.workspace, branch,
        head_sha: head, base_sha: head, product_digest: productDigest, source: "EXECUTED",
        source_execution_id: output.processId, source_process: output.processId, source_log: output.logPath,
      }));
  }
}

function probeExceptionResult(error: unknown): HealthResult {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ? { status: "CLI_NOT_FOUND", detail: "CLI executable was not found" }
    : { status: "ERROR", detail: safeError(error) };
}

function validationType(command: string): ValidationType { return /build/i.test(command) ? "BUILD" : /test/i.test(command) ? "TEST" : "TYPECHECK"; }

function splitValidationCommand(command: string): string[] {
  if (/[&|;<>`\r\n]/.test(command)) throw new Error("VALIDATION_COMMAND_UNSAFE");
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!).filter(Boolean);
}
