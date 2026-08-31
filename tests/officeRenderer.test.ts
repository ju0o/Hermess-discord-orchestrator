import { describe, expect, it } from "vitest";
import { parseEnvelope, serializeEnvelope, type NativeEnvelope } from "../src/discord/control/types.js";
import { renderOfficeMessage } from "../src/discord/conversation/officeRenderer.js";

const envelope: NativeEnvelope = {
  event_type: "RESULT", task_id: "OFFICE-CONVERSATION-001", sender: "CODEX", recipient: "ASUS", role: "DEVELOPER",
  round: 0, message_id: "pending", thread_id: "thread-1", created_at: new Date().toISOString(), payload: {},
};

describe("Discord Office conversation layer", () => {
  it("keeps the native envelope machine-readable without visible protocol text", () => {
    const wire = serializeEnvelope(envelope);
    expect(wire).not.toContain("SYMPHONY_EVENT"); expect(wire).not.toContain("{");
    expect(parseEnvelope(`<@1> 한국어 요청\n${wire}`, { messageId: "m1", threadId: "thread-1", createdAt: envelope.created_at })?.task_id).toBe(envelope.task_id);
  });

  it("renders ACK and RESULT as short Korean office messages", () => {
    expect(renderOfficeMessage("ACK", { status: "ACK" }, { ...envelope, event_type: "ACK" })).toContain("확인했습니다");
    const result = renderOfficeMessage("RESULT", { result: "step_start\n{\"type\":\"tool_use\"}\nREADME.md exists\npackage.json exists" }, envelope);
    expect(result).toContain("README.md"); expect(result).not.toContain("step_start"); expect(result).not.toContain("tool_use");
  });

  it("renders review verdicts without exposing JSON or invisible controls", () => {
    const review = renderOfficeMessage("REVIEW", { verdict: "REVIEW_PASS", evidence: ["Product mutation 0"] }, { ...envelope, event_type: "REVIEW", role: "REVIEWER" });
    expect(review).toContain("독립 검토"); expect(review).not.toContain("REVIEW_PASS"); expect(review).not.toContain("{");
    expect(review).not.toMatch(/[\u200B-\u200F\u2060-\u2064\uFEFF]/);
  });

  it("replaces mojibake-like visible model text with a safe office summary", () => {
    const result = renderOfficeMessage("RESULT", { result: "媛??? 뚯씪?? 덉뒿덈떎????" }, envelope);
    expect(result).not.toContain("媛"); expect(result).not.toContain("뚯씪"); expect(result).toContain("bounded");
  });
});
