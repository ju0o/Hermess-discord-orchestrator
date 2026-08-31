import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config/env.js";
import { FREE_TIER_CANDIDATES, FreeModelRegistry, QWEN_WORKSPACE_FREE_PROVIDER, type FreeModelProbeResult } from "../models/freeTierRegistry.js";
import { Store } from "../storage/database.js";

type Credential = { access_token?: string; base_url?: string; priority?: number; id?: string; label?: string };
type AuthFile = { credential_pool?: Record<string, Credential[]> };

function credentialPath(): string {
  const explicit = process.env.HERMES_ASUS_PROFILE_HOME;
  const profileHome = explicit || path.join(os.homedir(), "AppData", "Local", "hermes", "profiles", config.HERMES_ASUS_PROFILE);
  return path.join(profileHome, "auth.json");
}

function safeDetail(value: string): string { return value.replace(/sk-[A-Za-z0-9._-]+/g, "[REDACTED]").slice(0, 240); }

async function getModelCatalog(credentials: Credential[]): Promise<{ status: number; ids: Set<string>; credentialId?: string; baseUrl?: string; detail?: string }> {
  for (const credential of [...credentials].sort((a, b) => (a.priority || 0) - (b.priority || 0))) {
    if (!credential.access_token || !credential.base_url) continue;
    const baseUrl = credential.base_url.replace(/\/$/, "");
    try {
      const response = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${credential.access_token}`, Accept: "application/json" } });
      const text = await response.text();
      if (response.status === 401 || response.status === 403) continue;
      if (!response.ok) return { status: response.status, ids: new Set(), detail: safeDetail(text) };
      const body = JSON.parse(text) as { data?: Array<{ id?: string }> };
      return { status: response.status, ids: new Set((body.data || []).map((item) => item.id).filter((id): id is string => Boolean(id))),
        ...(credential.id ? { credentialId: credential.id } : {}), baseUrl };
    } catch (error) {
      return { status: 0, ids: new Set(), detail: safeDetail(String(error)) };
    }
  }
  return { status: 401, ids: new Set(), detail: "All configured secure credentials rejected by provider" };
}

function resultFor(modelName: string, catalog: Awaited<ReturnType<typeof getModelCatalog>>): FreeModelProbeResult {
  if (catalog.status === 200) {
    return catalog.ids.has(modelName)
      ? { state: "AVAILABLE", evidence: { httpStatus: 200, catalogModelId: modelName, probe: "GET /models", credentialSource: "Hermes secure credential pool" } }
      : { state: "UNAVAILABLE", errorCode: "MODEL_NOT_LISTED", errorDetail: "Provider catalog did not list this candidate", evidence: { httpStatus: 200, probe: "GET /models" } };
  }
  if (catalog.status === 401 || catalog.status === 403) return { state: "AUTH_FAILED", errorCode: `HTTP_${catalog.status}`, errorDetail: "Provider authentication failed; no model fallback attempted" };
  if (catalog.status === 429) return { state: "RATE_LIMITED", errorCode: "HTTP_429", errorDetail: "Provider catalog probe rate limited" };
  return { state: "TEMP_UNAVAILABLE", errorCode: catalog.status ? `HTTP_${catalog.status}` : "NETWORK_ERROR", errorDetail: catalog.detail || "Provider catalog probe failed" };
}

const store = new Store();
const registry = new FreeModelRegistry(store);
const registration = registry.registerCandidates(FREE_TIER_CANDIDATES);
const authPath = credentialPath();
if (!existsSync(authPath)) {
  console.log(JSON.stringify({ provider: QWEN_WORKSPACE_FREE_PROVIDER, registration, credentialSource: "Hermes secure credential pool", credentialStore: "NOT_FOUND", productExecution: 0 }));
  store.close(); process.exitCode = 2;
} else {
  const auth = JSON.parse(readFileSync(authPath, "utf8")) as AuthFile;
  const credentials = auth.credential_pool?.[QWEN_WORKSPACE_FREE_PROVIDER] || [];
  const catalog = await getModelCatalog(credentials);
  for (const candidate of registry.list(QWEN_WORKSPACE_FREE_PROVIDER)) {
    registry.beginProbe(candidate.modelName, { maxAttempts: 1 });
    registry.recordProbe(candidate.modelName, resultFor(candidate.modelName, catalog));
  }
  const records = registry.list(QWEN_WORKSPACE_FREE_PROVIDER);
  console.log(JSON.stringify({
    provider: QWEN_WORKSPACE_FREE_PROVIDER, registration, credentialSource: "Hermes secure credential pool", credentialStore: "USED_WITHOUT_SECRET_OUTPUT",
    httpStatus: catalog.status, credentialId: catalog.credentialId || "NONE", baseUrl: catalog.baseUrl || "NONE", catalogProbe: "GET /models",
    attempted: records.length, active: records.filter((item) => item.state === "AVAILABLE").map((item) => item.modelName),
    stateCounts: Object.fromEntries([...new Set(records.map((item) => item.state))].map((state) => [state, records.filter((item) => item.state === state).length])),
    productExecution: 0, tokenPlanUsage: 0, payg: 0,
  }));
  store.close();
}
