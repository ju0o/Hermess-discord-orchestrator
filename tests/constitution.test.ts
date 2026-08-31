import { describe, expect, it } from "vitest";
import { ASUS_ROLE, CONSTITUTION_VERSION, isAsusAutoRecovery, isAsusLocalObservation, isAsusProductImplementation } from "../src/authority/constitution.js";

describe("Company Constitution authority", () => {
  it("binds ASUS to the local engineering site manager role", () => {
    expect(ASUS_ROLE).toBe("LOCAL_ENGINEERING_SITE_MANAGER");
    expect(CONSTITUTION_VERSION).toBe("1.0.0");
    expect(isAsusLocalObservation("git status")).toBe(true);
    expect(isAsusLocalObservation("processes")).toBe(true);
  });
  it("keeps Product implementation delegated", () => {
    expect(isAsusProductImplementation("feature code")).toBe(true);
    expect(isAsusProductImplementation("bounded observation")).toBe(false);
  });
  it("classifies operational recovery as ASUS-owned", () => {
    expect(isAsusAutoRecovery("stale lease")).toBe(true);
    expect(isAsusAutoRecovery("product direction decision")).toBe(false);
  });
});
