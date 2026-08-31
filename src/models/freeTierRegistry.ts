import type { Store } from "../storage/database.js";

export const QWEN_WORKSPACE_FREE_PROVIDER = "custom:qwen-workspace-free" as const;

export const FREE_MODEL_STATES = [
  "UNKNOWN", "PROBING", "AVAILABLE", "DEGRADED", "RATE_LIMITED", "QUOTA_EXHAUSTED",
  "AUTH_FAILED", "TEMP_UNAVAILABLE", "DISABLED", "UNAVAILABLE",
] as const;
export type FreeModelState = (typeof FREE_MODEL_STATES)[number];

export const FREE_MODEL_CAPABILITIES = ["GENERAL", "CODING", "REASONING", "VISION", "OCR", "TRANSLATION", "AUDIO", "MULTIMODAL", "SUMMARY"] as const;
export type FreeModelCapability = (typeof FREE_MODEL_CAPABILITIES)[number];
export type FreeModelRouteClass = "ROUTINE" | "ENGINEERING" | "COMPLEX" | "HARD" | "SPECIAL";
const ROUTE_CLASS_RANK: Record<FreeModelRouteClass, number> = { ROUTINE: 0, ENGINEERING: 1, COMPLEX: 2, HARD: 3, SPECIAL: 4 };

export interface FreeModelCandidate {
  providerId: string;
  modelName: string;
  routeClass: FreeModelRouteClass;
  capabilities: FreeModelCapability[];
  automaticRouting: boolean;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface FreeModelRecord extends FreeModelCandidate {
  registryId: string;
  state: FreeModelState;
  probeAttempts: number;
  maxProbeAttempts: number;
  lastProbeAt?: string;
  nextProbeAt?: string;
  lastErrorCode?: string;
  lastErrorDetail?: string;
  updatedAt: string;
}

export interface FreeModelProbeResult {
  state: Exclude<FreeModelState, "UNKNOWN" | "PROBING">;
  errorCode?: string;
  errorDetail?: string;
  retryAfterMs?: number;
  evidence?: Record<string, unknown>;
}

export interface FreeModelProbeSummary {
  providerId: string;
  attempted: number;
  available: number;
  unavailable: number;
  authFailed: number;
  quotaExhausted: number;
  skipped: number;
}

const CANDIDATE_SOURCE = "user_supplied_free_tier_candidates_2026-08-12";
const names = [
  "qwen-vl-ocr",
  "qwen-vl-ocr-2025-11-20",
  "qwen-mt-flash",
  "qwen3-livetranslate-flash",
  "qwen3-livetranslate-flash-2025-12-01",
  "qwen-mt-lite",
  "qwen-mt-turbo",
  "qwen-mt-plus",
  "qwen-plus-character",
  "qwen3-coder-next",
  "qwen3-vl-32b-instruct",
  "qwen3-vl-32b-thinking",
  "qwen3-vl-30b-a3b-instruct",
  "qwen3-vl-30b-a3b-thinking",
  "qwen3-vl-8b-instruct",
  "qwen3-vl-8b-thinking",
  "qwen3-vl-235b-a22b-thinking",
  "qwen3-vl-235b-a22b-instruct",
  "qwen3-next-80b-a3b-thinking",
  "qwen3-next-80b-a3b-instruct",
  "qwen3-30b-a3b-thinking-2507",
  "qwen3-30b-a3b-instruct-2507",
  "qwen3-235b-a22b-thinking-2507",
  "qwen3-235b-a22b-instruct-2507",
  "qwen3-14b",
  "qwen3-30b-a3b",
  "qwen3-8b",
  "qwen3-32b",
  "qwen3-235b-a22b",
  "qwen3-coder-plus",
  "qwen3-coder-plus-2025-09-23",
  "qwen3-coder-plus-2025-07-22",
  "qwen3-coder-flash",
  "qwen3-coder-flash-2025-07-28",
  "qwen-flash",
  "qwen-flash-2025-07-28",
  "qwen3-omni-flash-2025-12-01",
  "qwen-turbo",
  "qwen-vl-plus",
  "qwen-vl-max",
  "qvq-max",
  "qwq-plus",
  "qwen-max",
  "qwen3-coder-30b-a3b-instruct",
  "qwen3-coder-480b-a35b-instruct",
  "kimi-k2.7-code",
  "qwen-vl-max-2025-08-13",
  "qwen-max-2025-01-25",
  "qwen2.5-14b-instruct",
  "qwen2.5-vl-72b-instruct",
  "qwen2.5-7b-instruct",
  "qwen-vl-plus-2025-08-15",
  "qwen-turbo-latest",
  "qwen-vl-plus-latest",
  "qwen-vl-max-latest",
  "qvq-max-2025-03-25",
  "qwen2.5-72b-instruct",
  "qwen2.5-vl-32b-instruct",
  "qwen-turbo-2025-04-28",
  "qwen2.5-vl-3b-instruct",
  "qvq-max-latest",
  "qwen3-max-2025-10-30",
  "qwen-vl-plus-2025-05-07",
  "qwen3-4b",
  "qwen2.5-14b-instruct-1m",
  "qwen-vl-max-2025-04-08",
  "qwen-vl-plus-2025-01-25",
  "qwen3-1.7b",
  "qwen2.5-7b-instruct-1m",
  "qwen3-tts-vc-realtime-2025-11-27",
  "qwen2.5-vl-7b-instruct",
  "qwen2.5-32b-instruct",
  "qwen3-omni-flash-realtime-2025-12-01",
  "qwen3-0.6b",
  "deepseek-v4-flash-0731",
] as const;

export const FREE_TIER_CANDIDATE_NAMES = names;

function classify(name: string): Pick<FreeModelCandidate, "routeClass" | "capabilities" | "automaticRouting"> {
  const value = name.toLowerCase();
  const capabilities = new Set<FreeModelCapability>(["GENERAL"]);
  if (/(coder|code|kimi-k2\.7)/.test(value)) capabilities.add("CODING");
  if (/(thinking|qwq|reason|qvq|max)/.test(value)) capabilities.add("REASONING");
  if (/(vl|vision)/.test(value)) capabilities.add("VISION");
  if (/ocr/.test(value)) capabilities.add("OCR");
  if (/(mt-|translate)/.test(value)) capabilities.add("TRANSLATION");
  if (/(tts|realtime)/.test(value)) capabilities.add("AUDIO");
  if (/omni/.test(value)) capabilities.add("MULTIMODAL");
  if (/(flash|turbo|lite|0\.6b|1\.7b|3b|4b|7b|8b)/.test(value)) capabilities.add("SUMMARY");

  const special = /(vl|ocr|translate|livetranslate|character|tts|realtime|omni)/.test(value);
  const hard = /(480b|235b|max|thinking)/.test(value);
  const complex = /(80b|72b|32b|30b|35b|122b|397b|14b|plus|pro|deepseek|kimi)/.test(value);
  return {
    routeClass: special ? "SPECIAL" : hard ? "HARD" : complex ? "ENGINEERING" : "ROUTINE",
    capabilities: [...capabilities],
    automaticRouting: !special,
  };
}

export const FREE_TIER_CANDIDATES: FreeModelCandidate[] = names.map((modelName) => ({
  providerId: QWEN_WORKSPACE_FREE_PROVIDER,
  modelName,
  ...classify(modelName),
  source: CANDIDATE_SOURCE,
  metadata: { candidateListPosition: names.indexOf(modelName) + 1 },
}));

function registryId(providerId: string, modelName: string): string {
  return `${providerId}:${modelName}`.toLowerCase();
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

function rowToRecord(row: Record<string, unknown>): FreeModelRecord {
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
  return {
    registryId: String(row.registry_id), providerId: String(row.provider_id), modelName: String(row.model_name),
    routeClass: row.route_class as FreeModelRouteClass, capabilities: parseJson<FreeModelCapability[]>(row.capabilities_json, ["GENERAL"]),
    automaticRouting: Boolean(row.automatic_routing), state: row.state as FreeModelState,
    probeAttempts: Number(row.probe_attempts), maxProbeAttempts: Number(row.max_probe_attempts),
    ...(row.last_probe_at ? { lastProbeAt: String(row.last_probe_at) } : {}),
    ...(row.next_probe_at ? { nextProbeAt: String(row.next_probe_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: String(row.last_error_code) } : {}),
    ...(row.last_error_detail ? { lastErrorDetail: String(row.last_error_detail) } : {}),
    source: String(row.source), metadata, updatedAt: String(row.updated_at),
  };
}

export class FreeModelRegistry {
  constructor(private readonly store: Store) {}

  registerCandidates(candidates: readonly FreeModelCandidate[] = FREE_TIER_CANDIDATES): { submitted: number; registered: number; duplicates: number } {
    const unique = new Map(candidates.map((candidate) => [registryId(candidate.providerId, candidate.modelName), candidate]));
    this.store.transaction(() => {
      for (const candidate of unique.values()) {
        const id = registryId(candidate.providerId, candidate.modelName);
        const existing = this.get(id);
        this.store.db.prepare(`INSERT INTO free_model_pool(registry_id,provider_id,model_name,route_class,capabilities_json,automatic_routing,state,
          probe_attempts,max_probe_attempts,last_probe_at,next_probe_at,last_error_code,last_error_detail,source,metadata_json,updated_at)
          VALUES(?,?,?,?,?,?,?,0,1,NULL,NULL,NULL,NULL,?,?,?) ON CONFLICT(registry_id) DO UPDATE SET
          provider_id=excluded.provider_id,model_name=excluded.model_name,route_class=excluded.route_class,capabilities_json=excluded.capabilities_json,
          automatic_routing=excluded.automatic_routing,source=excluded.source,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
          .run(id, candidate.providerId, candidate.modelName, candidate.routeClass, JSON.stringify(candidate.capabilities), candidate.automaticRouting ? 1 : 0,
            existing?.state || "UNKNOWN", candidate.source, JSON.stringify({ ...(existing?.metadata || {}), ...(candidate.metadata || {}), submittedCount: candidates.filter((item) => item.modelName === candidate.modelName).length }), this.store.now());
      }
    });
    return { submitted: candidates.length, registered: unique.size, duplicates: candidates.length - unique.size };
  }

  get(id: string): FreeModelRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM free_model_pool WHERE registry_id=?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  getByModel(modelName: string, providerId: string = QWEN_WORKSPACE_FREE_PROVIDER): FreeModelRecord | undefined {
    return this.get(registryId(providerId, modelName));
  }

  list(providerId?: string): FreeModelRecord[] {
    const rows = providerId
      ? this.store.db.prepare("SELECT * FROM free_model_pool WHERE provider_id=? ORDER BY automatic_routing DESC,route_class,model_name").all(providerId)
      : this.store.db.prepare("SELECT * FROM free_model_pool ORDER BY provider_id,automatic_routing DESC,route_class,model_name").all();
    return (rows as Record<string, unknown>[]).map(rowToRecord);
  }

  active(capability: FreeModelCapability, providerId = QWEN_WORKSPACE_FREE_PROVIDER): FreeModelRecord[] {
    return this.list(providerId).filter((model) => model.state === "AVAILABLE" && model.capabilities.includes(capability)
      && (capability !== "GENERAL" || model.automaticRouting))
      .sort((left, right) => ROUTE_CLASS_RANK[left.routeClass] - ROUTE_CLASS_RANK[right.routeClass] || left.modelName.localeCompare(right.modelName));
  }

  select(capability: FreeModelCapability, providerId = QWEN_WORKSPACE_FREE_PROVIDER): FreeModelRecord | undefined {
    return this.active(capability, providerId)[0];
  }

  beginProbe(modelName: string, options: { providerId?: string; maxAttempts?: number } = {}): boolean {
    const model = this.getByModel(modelName, options.providerId || QWEN_WORKSPACE_FREE_PROVIDER);
    if (!model || model.state === "AVAILABLE" || model.probeAttempts >= (options.maxAttempts ?? model.maxProbeAttempts)) return false;
    this.store.db.prepare("UPDATE free_model_pool SET state='PROBING',probe_attempts=probe_attempts+1,max_probe_attempts=?,updated_at=? WHERE registry_id=?")
      .run(options.maxAttempts ?? model.maxProbeAttempts, this.store.now(), model.registryId);
    return true;
  }

  recordProbe(modelName: string, result: FreeModelProbeResult, options: { providerId?: string } = {}): FreeModelRecord {
    const model = this.getByModel(modelName, options.providerId || QWEN_WORKSPACE_FREE_PROVIDER);
    if (!model) throw new Error(`FREE_MODEL_NOT_REGISTERED:${modelName}`);
    const now = this.store.now();
    const nextProbeAt = result.retryAfterMs ? new Date(Date.now() + result.retryAfterMs).toISOString() : null;
    this.store.db.prepare(`UPDATE free_model_pool SET state=?,last_probe_at=?,next_probe_at=?,last_error_code=?,last_error_detail=?,metadata_json=?,updated_at=? WHERE registry_id=?`)
      .run(result.state, now, nextProbeAt, result.errorCode || null, result.errorDetail || null,
        JSON.stringify({ ...model.metadata, ...(result.evidence || {}), healthProbe: "bounded_catalog_auth" }), now, model.registryId);
    return this.get(model.registryId)!;
  }

  async probeRegistered(probe: (model: FreeModelRecord) => Promise<FreeModelProbeResult>, options: { providerId?: string; maxAttempts?: number } = {}): Promise<FreeModelProbeSummary> {
    const providerId = options.providerId || QWEN_WORKSPACE_FREE_PROVIDER;
    const maxAttempts = options.maxAttempts ?? 1;
    const candidates = this.list(providerId);
    const summary: FreeModelProbeSummary = { providerId, attempted: 0, available: 0, unavailable: 0, authFailed: 0, quotaExhausted: 0, skipped: 0 };
    for (const candidate of candidates) {
      if (!this.beginProbe(candidate.modelName, { providerId, maxAttempts })) { summary.skipped += 1; continue; }
      summary.attempted += 1;
      try {
        const result = await probe(this.getByModel(candidate.modelName, providerId)!);
        const final = this.recordProbe(candidate.modelName, result, { providerId });
        if (final.state === "AVAILABLE") summary.available += 1;
        else if (final.state === "AUTH_FAILED") summary.authFailed += 1;
        else if (final.state === "QUOTA_EXHAUSTED") summary.quotaExhausted += 1;
        else summary.unavailable += 1;
      } catch (error) {
        this.recordProbe(candidate.modelName, { state: "TEMP_UNAVAILABLE", errorCode: "PROBE_EXCEPTION", errorDetail: String(error).slice(0, 240) }, { providerId });
        summary.unavailable += 1;
      }
    }
    return summary;
  }
}
