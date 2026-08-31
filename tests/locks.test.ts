import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/storage/database.js";
import { WorkspaceLocks } from "../src/tasks/locks.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function setup() { const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-lock-")); dirs.push(dir); const store = new Store(path.join(dir, "db.sqlite")); return { dir, store, locks: new WorkspaceLocks(store) }; }
describe("workspace locks", () => {
  it("blocks overlapping scope", () => { const { dir, store, locks } = setup(); const token = locks.acquire("a", dir, ["src"]); expect(token).toBeTruthy(); expect(locks.acquire("b", dir, ["src/x.ts"])).toBeUndefined(); store.close(); });
  it("allows non-overlapping scope", () => { const { dir, store, locks } = setup(); expect(locks.acquire("a", dir, ["src"])).toBeTruthy(); expect(locks.acquire("b", dir, ["docs"])).toBeTruthy(); store.close(); });
  it("releases locks", () => { const { dir, store, locks } = setup(); const token = locks.acquire("a", dir, ["src"])!; locks.release(token); expect(locks.acquire("b", dir, ["src"])).toBeTruthy(); store.close(); });
});
