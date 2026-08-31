import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { HumanFeedback, classify, acknowledgement } from "../src/office/humanFeedback.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("classify() -- deterministic Owner reply classification", () => {
  it.each([
    ["승인", "APPROVAL_DECISION"], ["거절", "APPROVAL_DECISION"],
    ["이건 다음부터 알아서 해", "LEARNING_CANDIDATE"],
    ["학습해. 결과는 기술 설명보다 쉬운 설명을 먼저 보여줘.", "LEARNING_CANDIDATE"],
    ["불편해. 이 보고 방식은 너무 길어.", "UX_FRICTION"],
    ["오늘 날씨가 좋네요", "OWNER_FEEDBACK"],
  ] as const)("classifies %j as %s", (text, expected) => {
    expect(classify(text).type).toBe(expected);
  });

  it("distinguishes approve vs reject within APPROVAL_DECISION", () => {
    expect(classify("승인").approvalDecision).toBe("APPROVED");
    expect(classify("거절").approvalDecision).toBe("REJECTED");
  });

  // Regression: an earlier substring-matching REJECT_PATTERN misclassified these extremely
  // common Korean phrases (which are not rejections at all) as APPROVAL_DECISION/REJECTED.
  it.each([
    "무리하지 마세요, 천천히 하셔도 됩니다",
    "걱정하지 마세요 잘 하고 있어요",
    "잘 안 돼요 다시 확인해주세요",
  ])("does not misclassify %j (a longer sentence merely containing a reject-like word) as a rejection", (text) => {
    expect(classify(text).type).not.toBe("APPROVAL_DECISION");
  });

  it("still classifies a bare, whole-message reject reply correctly", () => {
    expect(classify("안 돼").type).toBe("APPROVAL_DECISION");
    expect(classify("안 돼").approvalDecision).toBe("REJECTED");
    expect(classify("하지마.").approvalDecision).toBe("REJECTED");
  });
});

describe("HumanFeedback store", () => {
  it("captures, classifies, and durably persists an Owner reply exactly once per Discord message", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-human-feedback-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    const input = { rawText: "승인", sourceChannelId: "chan-1", sourceMessageId: "msg-1", sourceAuthorId: "owner-1" };
    const record = feedback.capture(input);
    expect(record.type).toBe("APPROVAL_DECISION");
    expect(record.approvalDecision).toBe("APPROVED");
    expect(acknowledgement(record)).toContain("승인");
    // Replaying the same Discord message (e.g. gateway retry) must not create a second row.
    const replay = feedback.capture(input);
    expect(replay.feedbackId).toBe(record.feedbackId);
    expect(feedback.list()).toHaveLength(1);
    // approvalDecision must be read back from its own persisted column, not re-derived from
    // (possibly bounded()-truncated) stored raw_text on every read.
    expect(feedback.get("msg-1")?.approvalDecision).toBe("APPROVED");
    expect(feedback.list({ type: "APPROVAL_DECISION" })[0]?.approvalDecision).toBe("APPROVED");
    store.close();
  });

  it("does not silently turn a learning candidate into applied policy", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-human-feedback-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    const record = feedback.capture({ rawText: "학습해. 앞으로는 짧게 요약해줘.", sourceChannelId: "owner-inbox", sourceMessageId: "msg-2", sourceAuthorId: "owner-1" });
    expect(record.type).toBe("LEARNING_CANDIDATE");
    expect(record.applied).toBe(false);
    feedback.markApplied(record.feedbackId);
    expect(feedback.list({ type: "LEARNING_CANDIDATE" })[0]?.applied).toBe(true);
    store.close();
  });

  it("separates the four feedback types on list()", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-human-feedback-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    feedback.capture({ rawText: "승인", sourceChannelId: "c", sourceMessageId: "m1", sourceAuthorId: "o" });
    feedback.capture({ rawText: "불편해요", sourceChannelId: "c", sourceMessageId: "m2", sourceAuthorId: "o" });
    feedback.capture({ rawText: "학습해줘", sourceChannelId: "c", sourceMessageId: "m3", sourceAuthorId: "o" });
    feedback.capture({ rawText: "그냥 참고용 코멘트입니다", sourceChannelId: "c", sourceMessageId: "m4", sourceAuthorId: "o" });
    expect(feedback.list({ type: "APPROVAL_DECISION" })).toHaveLength(1);
    expect(feedback.list({ type: "UX_FRICTION" })).toHaveLength(1);
    expect(feedback.list({ type: "LEARNING_CANDIDATE" })).toHaveLength(1);
    expect(feedback.list({ type: "OWNER_FEEDBACK" })).toHaveLength(1);
    store.close();
  });
});

describe("acknowledgement() -- the full two-way reply the Owner asked for", () => {
  it("always includes what was understood, classification, storage status, next step, and further Owner action", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-human-feedback-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    const record = feedback.capture({
      rawText: "학습해. 결과는 기술 설명보다 쉬운 설명을 먼저 보여줘.", sourceChannelId: "owner-inbox", sourceMessageId: "m-ack-1", sourceAuthorId: "owner",
    });
    const reply = acknowledgement(record);
    expect(reply).toContain("알겠습니다.");
    expect(reply).toContain("결과는 기술 설명보다 쉬운 설명을 먼저 보여줘"); // echoes what was understood, not a fabricated paraphrase
    expect(reply).toContain("[LEARNING CANDIDATE]");
    expect(reply).toContain("상태: 저장됨");
    expect(reply).toContain("주엉쓰가 추가로 할 일: 없음");
    store.close();
  });

  it("truncates very long raw text in the echoed line rather than sending an oversized Discord message", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-human-feedback-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    const record = feedback.capture({ rawText: "가".repeat(500), sourceChannelId: "c", sourceMessageId: "m-ack-2", sourceAuthorId: "owner" });
    expect(acknowledgement(record).length).toBeLessThan(1_500);
    store.close();
  });

  // Regression: a plain .slice(0, 200) on a string containing astral-plane characters (e.g.
  // emoji) can cut a surrogate pair in half, producing an unpaired surrogate that breaks when
  // sent to Discord (independent review finding).
  it("truncates on code-point boundaries, never splitting a surrogate pair", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-human-feedback-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    const rawText = `${"가".repeat(199)}😀😀😀`; // the 200th code point boundary lands inside an emoji pair
    const record = feedback.capture({ rawText, sourceChannelId: "c", sourceMessageId: "m-ack-3", sourceAuthorId: "owner" });
    const reply = acknowledgement(record);
    // eslint-disable-next-line no-misleading-character-class -- intentionally checking for a lone surrogate
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(reply)).toBe(false);
    store.close();
  });
});
