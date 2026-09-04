import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "../storage/database.js";

export interface WorkspaceRegistryEntry {
  projectId: string;
  workspace: string;
  status: string;
}

export class WorkspaceRegistry {
  private readonly configured: Map<string, WorkspaceRegistryEntry>;

  constructor(private readonly store: Store, registryPath = defaultRegistryPath()) {
    this.configured = loadRegistry(registryPath);
  }

  resolve(projectId: string): WorkspaceRegistryEntry | undefined {
    const key = projectId.trim();
    if (!key) return undefined;
    const configured = this.configured.get(key);
    if (configured) return configured;
    const row = this.store.db.prepare("SELECT project_id,workspace,status FROM projects WHERE project_id=?").get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const workspace = String(row.workspace || "");
    if (!path.isAbsolute(workspace)) return undefined;
    return { projectId: String(row.project_id), workspace, status: String(row.status || "UNKNOWN") };
  }

  resolveByLabel(label: string): WorkspaceRegistryEntry | undefined {
    const normalized = path.basename(label.trim()).toLowerCase();
    if (!normalized) return undefined;
    for (const entry of this.configured.values()) {
      if (entry.projectId.toLowerCase() === normalized || path.basename(entry.workspace).toLowerCase() === normalized) return entry;
    }
    const rows = this.store.db.prepare("SELECT project_id,workspace,status FROM projects").all() as Array<Record<string, unknown>>;
    const row = rows.find((candidate) => path.basename(String(candidate.workspace || "")).toLowerCase() === normalized || String(candidate.project_id || "").toLowerCase() === normalized);
    if (!row || !path.isAbsolute(String(row.workspace || ""))) return undefined;
    return { projectId: String(row.project_id), workspace: String(row.workspace), status: String(row.status || "UNKNOWN") };
  }

  require(projectId: string): WorkspaceRegistryEntry {
    const resolved = this.resolve(projectId);
    if (!resolved) throw new Error(`WORKSPACE_REGISTRY_PROJECT_NOT_FOUND: ${projectId}`);
    if (!path.isAbsolute(resolved.workspace)) throw new Error(`WORKSPACE_REGISTRY_PATH_NOT_ABSOLUTE: ${projectId}`);
    return resolved;
  }

  snapshot(): WorkspaceRegistryEntry[] {
    return [...this.configured.values()].map((entry) => ({ ...entry }));
  }
}

/** A machine-local registry may override the tracked default without changing
 * the Windows-compatible default when WORKSPACE_REGISTRY_PATH is unset. */
function defaultRegistryPath(): string {
  const override = (process.env.WORKSPACE_REGISTRY_PATH || "").trim();
  return override || path.resolve("config/project-workspaces.json");
}

function loadRegistry(filePath: string): Map<string, WorkspaceRegistryEntry> {
  if (!existsSync(filePath)) return new Map();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(filePath, "utf8")); } catch (error) { throw new Error(`WORKSPACE_REGISTRY_INVALID_JSON: ${String(error)}`); }
  const projects = raw && typeof raw === "object" && "projects" in raw ? (raw as { projects?: unknown }).projects : undefined;
  if (!projects || typeof projects !== "object") return new Map();
  const result = new Map<string, WorkspaceRegistryEntry>();
  for (const [projectId, value] of Object.entries(projects)) {
    if (!value || typeof value !== "object") throw new Error(`WORKSPACE_REGISTRY_INVALID_ENTRY: ${projectId}`);
    const workspace = String((value as { workspace?: unknown }).workspace || "");
    if (!path.isAbsolute(workspace)) throw new Error(`WORKSPACE_REGISTRY_PATH_NOT_ABSOLUTE: ${projectId}`);
    result.set(projectId, { projectId, workspace, status: String((value as { status?: unknown }).status || "ACTIVE") });
  }
  return result;
}
