import { describe, expect, it } from "vitest";
import { OrchestratorRuntime } from "../src/runtime/runtime.js";

function fixture(active: boolean) {
  let request: (() => { accepted: boolean; error?: string; alreadyRequested?: boolean; onAccepted: () => void }) | undefined;
  let calls = 0;
  const runtime = Object.create(OrchestratorRuntime.prototype) as any;
  runtime.maintenanceShutdownRequested = false;
  runtime.store = { db: { prepare: () => ({ get: () => active ? { process_id: "worker-1" } : undefined }) } };
  runtime.localTaskControl = { setMaintenanceShutdown: (handler: typeof request) => { request = handler; } };
  runtime.attachMaintenanceShutdown(() => { calls += 1; });
  return { request: () => request!(), calls: () => calls };
}

describe("canonical maintenance shutdown boundary", () => {
  it("rejects while material Worker execution is active", () => {
    expect(fixture(true).request()).toMatchObject({ accepted: false, error: "RUNTIME_MAINTENANCE_ACTIVE_WORK" });
  });
  it("accepts inactive or blocked tasks and schedules the Runtime-owned callback once", () => {
    const x = fixture(false); const first = x.request(); const second = x.request();
    expect(first).toMatchObject({ accepted: true, alreadyRequested: false }); expect(second).toMatchObject({ accepted: true, alreadyRequested: true });
    first.onAccepted(); second.onAccepted(); expect(x.calls()).toBe(1);
  });
});
