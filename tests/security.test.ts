import { describe, expect, it } from "vitest";
import { redact } from "../src/security/redaction.js";
import { requiresHumanGate } from "../src/security/humanGate.js";

describe("security", () => {
  it("redacts key assignments", () => expect(redact("api_key=supersecretvalue")).not.toContain("supersecretvalue"));
  it("redacts OpenAI-style secrets", () => expect(redact("sk-abcdefghijklmnop123456")).toContain("[REDACTED]"));
  it("gates force push", () => expect(requiresHumanGate("git push --force origin main").required).toBe(true));
  it("allows local tests", () => expect(requiresHumanGate("edit code and run unit tests").required).toBe(false));
});
