import { describe, expect, it } from "vitest";
import { isOwnerInboxChannel } from "../src/discord/routing/multiBotGateway.js";
import type { Message } from "discord.js";

// Minimal shape checks only what isOwnerInboxChannel actually reads -- no full discord.js Client/Guild needed.
function channel(overrides: Partial<{ name: string; isThreadValue: boolean; parentName: string }>): Message["channel"] {
  return {
    name: overrides.name,
    isThread: () => Boolean(overrides.isThreadValue),
    parent: overrides.parentName ? { name: overrides.parentName } : undefined,
  } as unknown as Message["channel"];
}

describe("isOwnerInboxChannel", () => {
  it("matches the top-level #owner-inbox channel", () => {
    expect(isOwnerInboxChannel(channel({ name: "owner-inbox" }))).toBe(true);
  });
  it("matches a thread under #owner-inbox", () => {
    expect(isOwnerInboxChannel(channel({ isThreadValue: true, parentName: "owner-inbox" }))).toBe(true);
  });
  it("does not match unrelated channels or threads", () => {
    expect(isOwnerInboxChannel(channel({ name: "coding-status" }))).toBe(false);
    expect(isOwnerInboxChannel(channel({ isThreadValue: true, name: "random-thread", parentName: "coding-control" }))).toBe(false);
  });

  // V0 bridge (Sprint 01): while #owner-inbox itself is blocked on a Discord permission, an
  // interim "오너 인박스" thread under #coding-control stands in for it -- this is exactly the
  // thread the real Sprint 01 Owner-reply invitation was posted into.
  it("matches the V0 interim '오너 인박스' thread under #coding-control", () => {
    expect(isOwnerInboxChannel(channel({ isThreadValue: true, name: "📥 오너 인박스 (임시)", parentName: "coding-control" }))).toBe(true);
  });
  it("does not match an unrelated thread under #coding-control that merely happens to be a thread", () => {
    expect(isOwnerInboxChannel(channel({ isThreadValue: true, name: "🏢 코딩 오피스 (임시)", parentName: "coding-control" }))).toBe(false);
  });
});
