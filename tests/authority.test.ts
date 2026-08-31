import { describe, expect, it } from "vitest";
import { classifyAuthority } from "../src/authority/delegatedAuthority.js";

describe("Delegated Authority Model V1", () => {
  it.each([
    ["same-task retry", "AUTO_DELEGATED"], ["state reconciliation", "AUTO_DELEGATED"],
    ["reviewer revision", "AUTO_DELEGATED"], ["validation rerun", "AUTO_DELEGATED"],
    ["context rollover", "AUTO_DELEGATED"], ["agent reassignment", "AUTO_DELEGATED"],
    ["architecture choice", "MAIN_DECISION"], ["model escalation", "MAIN_DECISION"],
    ["production deploy", "HUMAN_REQUIRED"], ["paid action over threshold", "HUMAN_REQUIRED"],
    ["destructive Git reset --hard", "HUMAN_REQUIRED"],
  ])("classifies %s as %s", (operation, expected) => {
    expect(classifyAuthority({ operation }).authorityClass).toBe(expected);
  });

  it("escalates only after the autonomous retry limit", () => {
    expect(classifyAuthority({ operation: "validation retry", retryCount: 1, retryLimit: 3 }).authorityClass).toBe("AUTO_DELEGATED");
    expect(classifyAuthority({ operation: "validation retry", retryCount: 3, retryLimit: 3 }).authorityClass).toBe("MAIN_DECISION");
  });
});
