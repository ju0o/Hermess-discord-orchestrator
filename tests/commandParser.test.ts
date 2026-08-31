import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/discord/commands/parser.js";

describe("command parser", () => {
  it("parses status", () => expect(parseCommand("!agent status")).toEqual({ kind: "agent-status" }));
  it("parses model control", () => expect(parseCommand("!agent model CODEX gpt-test")).toMatchObject({ kind: "agent-model", agentId: "CODEX", model: "gpt-test" }));
  it("parses model listing", () => expect(parseCommand("!agent models OPENCODE")).toEqual({ kind: "agent-models", agentId: "OPENCODE" }));
  it("parses quoted assignment", () => expect(parseCommand('!task assign project=p role=DEVELOPER workspace="C:\\repo" title="Fix auth"')).toMatchObject({ kind: "task-assign" }));
  it("parses machine JSON", () => expect(parseCommand('TASK_JSON {"taskId":"T1"}')).toEqual({ kind: "task-assign", payload: { taskId: "T1" } }));
  it("parses handoff", () => expect(parseCommand("!runtime handoff")).toEqual({ kind: "runtime-handoff" }));
  it("parses Owner controls", () => {
    expect(parseCommand("작업중지")).toEqual({ kind: "office-pause" });
    expect(parseCommand("멈춰")).toEqual({ kind: "office-pause" });
    expect(parseCommand("시작해")).toEqual({ kind: "office-resume" });
    expect(parseCommand("완전정지")).toEqual({ kind: "office-full-stop" });
  });
  it("parses concise performance queries with REAL_PROJECT default", () => {
    expect(parseCommand("!performance agents")).toEqual({ kind: "performance-agents", dataClass: "REAL_PROJECT" });
    expect(parseCommand("!performance CODEX canary")).toEqual({ kind: "performance-agent", agentId: "CODEX", dataClass: "CANARY" });
    expect(parseCommand("!performance role REVIEWER")).toEqual({ kind: "performance-role", role: "REVIEWER", dataClass: "REAL_PROJECT" });
    expect(parseCommand("!performance models CODEX all")).toEqual({ kind: "performance-models", agentId: "CODEX", dataClass: "ALL" });
    expect(parseCommand("!performance project AVM canary")).toEqual({ kind: "performance-project", projectId: "AVM", dataClass: "CANARY" });
  });
});
