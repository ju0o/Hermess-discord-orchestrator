import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { OwnerControl } from "../src/office/ownerControl.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("Owner control", () => {
  it("persists pause and requires an explicit resume", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-owner-control-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const control = new OwnerControl(store);
    expect(control.isPaused()).toBe(false);
    expect(control.pause("작업중지").mode).toBe("PAUSED_BY_OWNER");
    expect(new OwnerControl(store).isPaused()).toBe(true);
    expect(control.resume("시작해").mode).toBe("RUNNING");
    expect(control.isPaused()).toBe(false); store.close();
  });
});
