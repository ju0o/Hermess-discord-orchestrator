import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/database.js";
import { WorkspaceRegistry } from "../src/registry/workspaceRegistry.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("local workspace registry", () => {
  it("resolves a configured Project ID to an absolute local workspace", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hermess-registry-")); dirs.push(root);
    const workspace = path.join(root, "project"); const file = path.join(root, "registry.json");
    writeFileSync(file, JSON.stringify({ version: "1.0.0", projects: { PROJECT: { workspace, status: "ACTIVE" } } }));
    const store = new Store(path.join(root, "state.db")); const registry = new WorkspaceRegistry(store, file);
    expect(registry.require("PROJECT")).toMatchObject({ projectId: "PROJECT", workspace });
    store.close();
  });

  it("fails closed for an unknown or relative registry entry", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "hermess-registry-")); dirs.push(root);
    const file = path.join(root, "registry.json"); writeFileSync(file, JSON.stringify({ projects: {} }));
    const store = new Store(path.join(root, "state.db")); const registry = new WorkspaceRegistry(store, file);
    expect(() => registry.require("UNKNOWN")).toThrow("WORKSPACE_REGISTRY_PROJECT_NOT_FOUND");
    store.close();
  });
});
