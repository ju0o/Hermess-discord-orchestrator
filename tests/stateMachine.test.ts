import { describe, expect, it } from "vitest";
import { canTransition, assertTransition } from "../src/tasks/stateMachine.js";

describe("task state machine", () => {
  it("allows the handshake path", () => { expect(canTransition("QUEUED", "DISPATCHED")).toBe(true); expect(canTransition("DISPATCHED", "CLAIMED")).toBe(true); expect(canTransition("CLAIMED", "RUNNING")).toBe(true); });
  it("allows result and pass", () => { expect(canTransition("RUNNING", "WAITING_RESULT")).toBe(true); expect(canTransition("WAITING_RESULT", "PASS")).toBe(true); });
  it("does not replay terminal work", () => { expect(canTransition("PASS", "QUEUED")).toBe(false); expect(() => assertTransition("PASS", "RUNNING")).toThrow(/Illegal/); });
  it("supports offline Main gates", () => { expect(canTransition("RUNNING", "WAITING_MAIN")).toBe(true); expect(canTransition("WAITING_MAIN", "QUEUED")).toBe(true); });
});
