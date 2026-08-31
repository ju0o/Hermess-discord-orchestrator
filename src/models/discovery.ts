import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { config } from "../config/env.js";
import type { AgentId, ModelCatalogRecord, ModelVerificationLevel } from "../domain/types.js";
import type { ProcessRunner } from "../runtime/processRunner.js";
import type { ModelCatalog } from "./catalog.js";

type Candidate = Omit<ModelCatalogRecord, "modelId" | "lastVerifiedAt">;
const verified = (level: ModelVerificationLevel) => ["CLI_REPORTED", "EXECUTION_VERIFIED"].includes(level);
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;

export class LocalModelDiscovery {
  constructor(private readonly runner: ProcessRunner, private readonly catalog: ModelCatalog) {}

  async refresh(): Promise<Record<AgentId, number>> {
    const candidates = [...await this.codex(), ...await this.claude(), ...await this.openCode(), ...await this.commandCode()];
    for (const candidate of candidates) this.catalog.upsert(candidate);
    return {
      CODEX: candidates.filter((item) => item.agentId === "CODEX").length,
      CLAUDE_CODE: candidates.filter((item) => item.agentId === "CLAUDE_CODE").length,
      OPENCODE: candidates.filter((item) => item.agentId === "OPENCODE").length,
      COMMAND_CODE: candidates.filter((item) => item.agentId === "COMMAND_CODE").length,
    };
  }

  private candidate(agentId: AgentId, provider: string, modelName: string, level: ModelVerificationLevel, source: string,
    metadata: Record<string, unknown> = {}, alias?: string, displayName?: string): Candidate {
    return { agentId, provider, modelName, ...(alias ? { modelAlias: alias } : {}), displayName: displayName || modelName,
      available: level !== "UNAVAILABLE", verified: verified(level), verificationLevel: level, overrideSupported: true,
      overrideValue: agentId === "OPENCODE" ? `${provider}/${modelName}` : (alias || modelName), resumeOverrideSupported: true,
      source, metadata };
  }

  private async codex(): Promise<Candidate[]> {
    const root = path.join(homedir(), ".codex"); const cachePath = path.join(root, "models_cache.json"); const result: Candidate[] = [];
    if (existsSync(cachePath)) {
      const parsed = readJson<{ models?: Array<{ slug?: string; display_name?: string; visibility?: string }> } | Array<{ slug?: string; display_name?: string; visibility?: string }>>(cachePath);
      const models = Array.isArray(parsed) ? parsed : parsed.models || [];
      for (const model of models) if (model.slug) result.push(this.candidate("CODEX", "openai-chatgpt", model.slug, "DISCOVERED", "codex_models_cache",
        { visibility: model.visibility || "unknown" }, undefined, model.display_name));
    }
    const configPath = path.join(root, "config.toml"); const configured = existsSync(configPath) ? readFileSync(configPath, "utf8").match(/^\s*model\s*=\s*["']([^"']+)["']/m)?.[1] : undefined;
    if (configured) result.push(this.candidate("CODEX", "openai-chatgpt", configured, "CONFIGURED", "codex_config", { default: true }));
    return result;
  }

  private async claude(): Promise<Candidate[]> {
    const help = await this.runner.probe(config.CLAUDE_CODE_CLI, ["--help"], config.HERMESS_ROOT, 30_000);
    const text = `${help.stdout}\n${help.stderr}`; const aliases = [...text.matchAll(/'(fable|opus|sonnet)'/g)].map((match) => match[1]!).filter((value, index, all) => all.indexOf(value) === index);
    const result = aliases.map((alias) => this.candidate("CLAUDE_CODE", "claude.ai", alias, "CLI_REPORTED", "claude_cli_help", { alias: true }, alias, alias));
    const settingsPath = path.join(homedir(), ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const settings = readJson<{ model?: string }>(settingsPath);
      if (settings.model) result.push(this.candidate("CLAUDE_CODE", "claude.ai", settings.model, "CONFIGURED", "claude_settings", { default: true, alias: true }, settings.model));
    }
    return result;
  }

  private async openCode(): Promise<Candidate[]> {
    const output = await this.runner.probe(config.OPENCODE_CLI, ["models"], config.HERMESS_ROOT, 60_000); const result: Candidate[] = [];
    for (const line of output.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const slash = line.indexOf("/"); if (slash < 1 || /\s/.test(line)) continue;
      result.push(this.candidate("OPENCODE", line.slice(0, slash), line.slice(slash + 1), "CLI_REPORTED", "opencode_models", { fullId: line }));
    }
    return result;
  }

  private async commandCode(): Promise<Candidate[]> {
    const output = await this.runner.probe(config.COMMAND_CODE_CLI, ["--no-auto-update", "--list-models"], config.HERMESS_ROOT, 60_000);
    const result: Candidate[] = []; let family = "unknown";
    for (const raw of output.stdout.split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      if (/^(Open Source|Anthropic|OpenAI|Google|Sakana|Meta|xAI)$/.test(line)) { family = line; continue; }
      const match = line.match(/^([^\s]+)\s{2,}/); if (!match || !/^[a-z0-9][a-z0-9._/-]+$/i.test(match[1]!)) continue;
      result.push(this.candidate("COMMAND_CODE", "command-code", match[1]!, "CLI_REPORTED", "commandcode_list_models", { family }));
    }
    const configPath = path.join(homedir(), ".commandcode", "config.json");
    if (existsSync(configPath)) {
      const settings = readJson<{ provider?: string; model?: string }>(configPath);
      if (settings.model) result.push(this.candidate("COMMAND_CODE", settings.provider || "command-code", settings.model, "CONFIGURED", "commandcode_config", { default: true }));
    }
    return result;
  }
}
