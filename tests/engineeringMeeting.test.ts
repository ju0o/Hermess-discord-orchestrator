import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/database.js";
import { TaskRepository } from "../src/tasks/repository.js";
import { EngineeringMeetingService } from "../src/collaboration/meeting.js";
import { parseEnvelope } from "../src/discord/control/types.js";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-meeting-"));
  const store = new Store(path.join(dir, "meeting.db")); const tasks = new TaskRepository(store);
  tasks.upsertProject({ projectId: "p", name: "Synthetic Meeting", workspace: dir, ssotPaths: [], status: "ACTIVE" });
  const task = tasks.create({ taskId: "SYM-MEETING-001", projectId: "p", title: "Harmless meeting", goal: "Protocol-only", role: "DEVELOPER", requiredCapabilities: ["coding"], assignedAgent: "CLAUDE_CODE", status: "RUNNING", workspace: dir, threadId: "thread-synthetic", parentChannelId: "channel-synthetic", readContext: {}, fileScope: [], doNot: [], validation: [], owner: "ASUS", nextOwner: "ASUS" });
  const protocol = { events: [] as Array<Record<string, unknown>>, async emit(type: string, taskRecord: typeof task, sender: string, recipient: string, payload: Record<string, unknown>) {
    const event = { eventId: `${this.events.length + 1}`, taskId: taskRecord.taskId, type, sender, recipient, payload, createdAt: new Date().toISOString() };
    this.events.push(event); return event;
  } };
  const workrooms = { get: (taskId: string) => taskId === task.taskId ? { threadId: task.threadId, state: "ACTIVE" } : undefined };
  const meeting = new EngineeringMeetingService(store, tasks, workrooms as never, protocol as never);
  return { dir, store, tasks, task, protocol, meeting };
}

describe("EngineeringMeetingService", () => {
  it("persists a multi-agent meeting and keeps natural-language body in the event", async () => {
    const x = fixture();
    const opened = await x.meeting.open(x.task, ["CLAUDE_CODE", "OPENCODE"], "테스트 회의를 시작합니다. 각자 안전한 역할과 dependency를 자연어로 제안해 주세요.");
    expect(opened.eventIds).toHaveLength(2); expect(x.meeting.session(x.task.taskId)?.threadId).toBe(x.task.threadId);
    expect(x.meeting.members(x.task.taskId).map((item) => item.state)).toEqual(["INVITED", "INVITED"]);
    await x.meeting.propose({ taskId: x.task.taskId, eventType: "COUNTER_PROPOSAL", sender: "OPENCODE", recipient: "ASUS", body: "전체 구현 대신 bounded UI review를 맡겠습니다." });
    expect(x.meeting.members(x.task.taskId).find((item) => item.agentId === "OPENCODE")?.state).toBe("PROPOSING");
    await x.meeting.decide(x.task.taskId, "MODIFY", "승인. Claude는 schema, OpenCode는 bounded UI review를 맡습니다.", ["CLAUDE_CODE", "OPENCODE"]);
    expect(x.meeting.session(x.task.taskId)?.decisionType).toBe("MODIFY");
    expect(x.meeting.members(x.task.taskId).every((item) => item.state === "ACTIVE")).toBe(true);
    x.store.close(); rmSync(x.dir, { recursive: true, force: true });
  });

  it("accepts hidden structured metadata while preserving human-readable body", () => {
    const content = "[CAPABILITY REPORT]\n현재 runtime에서는 내부 병렬화를 지원하지 않습니다.\n<!-- SYMPHONY_EVENT {\"event_type\":\"CAPABILITY_REPORT\",\"task_id\":\"SYM-MEETING-001\",\"sender\":\"OPENCODE\",\"recipient\":\"ASUS\",\"round\":0,\"message_id\":\"pending\",\"created_at\":\"2026-01-01T00:00:00.000Z\",\"payload\":{\"body\":\"bounded\"}} -->";
    const envelope = parseEnvelope(content, { messageId: "m1", threadId: "thread-synthetic", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(envelope).toMatchObject({ event_type: "CAPABILITY_REPORT", sender: "OPENCODE", task_id: "SYM-MEETING-001", thread_id: "thread-synthetic" });
  });
});
