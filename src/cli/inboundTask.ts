import { readFileSync } from "node:fs";
import { Store } from "../storage/database.js";
import { TaskRepository } from "../tasks/repository.js";
import { SymphonyTaskBridge, type ExternalSymphonyTask } from "../inbound/symphonyTaskBridge.js";
import { safeError } from "../security/redaction.js";

const raw = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
const input = JSON.parse(raw) as ExternalSymphonyTask & { action?: string; ackMessageId?: string; reason?: string };
const store = new Store(); const tasks = new TaskRepository(store); const bridge = new SymphonyTaskBridge(store, tasks);
try {
  const result = input.action === "markAck"
    ? bridge.markAck(input.sourceMessageId, String(input.ackMessageId || ""))
    : input.action === "release"
      ? bridge.release(input.sourceMessageId)
    : input.action === "releaseTask"
      ? bridge.releaseTask(input.taskId)
    : input.action === "retryExisting"
      ? bridge.retryExisting(input.taskId, Number(input.round || 0), input.executionContract)
    : input.action === "hold"
      ? bridge.hold(input.sourceMessageId, String(input.reason || "External reconciliation requires explicit release"))
    : bridge.register(input);
  process.stdout.write(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: safeError(error) })); process.exitCode = 1;
} finally { store.close(); }
