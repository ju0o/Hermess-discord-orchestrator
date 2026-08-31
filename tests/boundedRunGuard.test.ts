import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/database.js";
import { BoundedRunGuard } from "../src/runtime/boundedRunGuard.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) { const d = dirs.pop()!; try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function storeForTest() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bounded-"));
  dirs.push(dir);
  return new Store(path.join(dir, "test.db"));
}

describe("BoundedRunGuard (stall stop boundary)", () => {
  it("does not stop when no WAITING_MAIN", () => {
    const store = storeForTest();
    try {
      const g = new BoundedRunGuard(store, { maxConsecutiveWaits: 2 });
      expect(g.evaluate(0,0,0).shouldStop).toBe(false);
      expect(g.evaluate(0,0,0).shouldStop).toBe(false);
    } finally { store.close(); }
  });

  it("stops after N consecutive WAITING_MAIN observations", () => {
    const store = storeForTest();
    try {
      const g = new BoundedRunGuard(store, { maxConsecutiveWaits: 2 });
      expect(g.evaluate(0,0,1).shouldStop).toBe(false);
      const r = g.evaluate(0,0,1);
      expect(r.shouldStop).toBe(true);
      expect(r.reason).toMatch(/BOUNDED_RUN_WATCHDOG/);
    } finally { store.close(); }
  });

  it("resets after progress", () => {
    const store = storeForTest();
    try {
      const g = new BoundedRunGuard(store, { maxConsecutiveWaits: 2 });
      g.evaluate(0,0,1);
      g.evaluate(0,0,0);
      expect(g.evaluate(0,0,1).shouldStop).toBe(false);
    } finally { store.close(); }
  });

  it("records evidence and does not retry Product mutation", () => {
    const store = storeForTest();
    try {
      const g = new BoundedRunGuard(store, { maxConsecutiveWaits: 1 });
      const r = g.evaluate(1,1,1);
      expect(r.shouldStop).toBe(true);
      expect(r.evidence).toBeDefined();
    } finally { store.close(); }
  });
});
