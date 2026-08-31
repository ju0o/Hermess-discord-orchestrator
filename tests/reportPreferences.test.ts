import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/database.js";
import { HumanFeedback } from "../src/office/humanFeedback.js";
import { deriveReportPreferences } from "../src/office/reportPreferences.js";
import { renderSprintReport } from "../src/office/report.js";

const dirs: string[] = []; afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const bigInput = {
  doneToday: ["Task 1", "Task 2", "Task 3", "Task 4", "Task 5"],
  inProgress: [], failuresAndRecovery: [], companySelfImprovement: [], workerFriction: [],
  learningCandidates: [], ownerDecisionsRequired: [], nextAutomaticProgress: [],
};

describe("full Owner-feedback-changes-behavior loop (Sprint 01 V09)", () => {
  it("defaults to no preference when no relevant feedback exists yet", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-report-prefs-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db"));
    expect(deriveReportPreferences(store)).toEqual({ shortForm: false });
    expect(renderSprintReport(bigInput, deriveReportPreferences(store))).toContain("Task 5"); // full list, nothing truncated
    store.close();
  });

  it("a real Owner reply asking for a shorter report visibly changes the very next report rendered", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-report-prefs-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);

    // BEFORE: the full loop's starting point -- an Owner-visible feedback item exists nowhere
    // yet; render once to establish the "before" behavior the Owner should be able to compare against.
    const before = renderSprintReport(bigInput, deriveReportPreferences(store));
    expect(before).toContain("Task 4");
    expect(before).toContain("Task 5");
    expect(before).not.toContain("간단 보기");

    // Owner reply (natural language) -> durable record (this IS the round-trip: capture()).
    const record = feedback.capture({
      rawText: "불편해. 이 보고 방식은 너무 길어. 짧게 요약해줘.",
      sourceChannelId: "owner-inbox", sourceMessageId: "m-shortform", sourceAuthorId: "owner",
    });
    expect(record.type).toBe("UX_FRICTION"); // classified and durably stored

    // AFTER: the exact same input data, rendered again, now visibly differs *because of* the
    // Owner's feedback -- this is the "next real Office interaction reflects the change" proof.
    const preferences = deriveReportPreferences(store);
    expect(preferences.shortForm).toBe(true);
    expect(preferences.appliedFrom).toBe(record.feedbackId);
    const after = renderSprintReport(bigInput, preferences);
    expect(after).toContain("간단 보기");
    expect(after).toContain("Task 1"); expect(after).toContain("Task 2"); expect(after).toContain("Task 3");
    expect(after).not.toContain("Task 4"); // truncated -- this is the observable difference
    expect(after).toContain("...외 2건");

    store.close();
  });

  // Regression: an earlier version matched "short"/"shorten" as a free substring, so ordinary
  // English containing that substring (nothing to do with report length) falsely flipped every
  // subsequent report into short form -- the exact class of bug already fixed once in
  // humanFeedback.ts's REJECT_PATTERN (independent review finding).
  it.each([
    "I'll get back to you shortly with an update.",
    "There was a shortfall in this quarter's budget.",
    "He hit a shortstop ball during the game.",
    "This is shorthand notation for the API.",
  ])("does not misclassify %j as a request for shorter reports", (rawText) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-report-prefs-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    feedback.capture({ rawText, sourceChannelId: "c", sourceMessageId: `m-${rawText.length}`, sourceAuthorId: "owner" });
    expect(deriveReportPreferences(store).shortForm).toBe(false);
    store.close();
  });

  it("a later 'show it long again' reply immediately reverses shortForm, without waiting for the window to expire", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hermess-report-prefs-")); dirs.push(dir);
    const store = new Store(path.join(dir, "state.db")); const feedback = new HumanFeedback(store);
    const shortRecord = feedback.capture({ rawText: "학습해. 짧게 요약해줘.", sourceChannelId: "c", sourceMessageId: "m-short", sourceAuthorId: "owner" });
    expect(shortRecord.type).toBe("LEARNING_CANDIDATE"); // sanity: must land in the pool deriveReportPreferences actually scans
    expect(deriveReportPreferences(store).shortForm).toBe(true);
    const longRecord = feedback.capture({ rawText: "학습해. 이제 다시 길게 자세히 보여줘.", sourceChannelId: "c", sourceMessageId: "m-long", sourceAuthorId: "owner" });
    expect(longRecord.type).toBe("LEARNING_CANDIDATE");
    expect(deriveReportPreferences(store).shortForm).toBe(false);
    store.close();
  });
});
