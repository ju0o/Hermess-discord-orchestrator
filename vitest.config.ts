import { defineConfig } from "vitest/config";

const reviewerEvidenceHandoff = "tests/reviewerEvidenceHandoff.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "parallel",
          include: ["tests/**/*.test.ts"],
          exclude: [reviewerEvidenceHandoff],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "reviewer-evidence-handoff",
          include: [reviewerEvidenceHandoff],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
