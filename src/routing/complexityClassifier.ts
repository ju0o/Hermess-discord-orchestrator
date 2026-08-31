import type { ReasoningComplexity, TaskRecord } from "../domain/types.js";

export interface ComplexityClassification {
  complexity: ReasoningComplexity;
  reasons: string[];
  source: "MANUAL" | "DETERMINISTIC";
}

export function classifyComplexity(task: TaskRecord, evidence: { reasoningFailureCount?: number } = {}): ComplexityClassification {
  if (task.complexity) return { complexity: task.complexity, reasons: task.complexityReasons?.length ? task.complexityReasons : ["COMPLEXITY_OVERRIDE"], source: task.complexitySource || "MANUAL" };
  const text = `${task.title} ${task.goal} ${task.validation.join(" ")}`.toLowerCase();
  const failures = evidence.reasoningFailureCount || 0;
  if (failures >= 2) return deterministic("T4", ["repeated reasoning-category failures"]);
  if (task.taskType === "ARCHITECTURE" || /architecture tradeoff|architectural ambiguity|novel system design|security boundary/.test(text))
    return deterministic("T4", ["architecture-level reasoning or ambiguity"]);
  if (failures === 1) return deterministic("T3", ["prior reasoning-category failure"]);
  const complexFactors = [
    [/\b(concurrency|deadlock|race condition)\b/, "concurrency/state interaction"],
    [/\b(migration|state machine|distributed state)\b/, "state or migration reasoning"],
    [/cross[- ]subsystem|multiple subsystems|dependency graph/, "cross-subsystem dependency reasoning"],
    [/multiple (causes|root causes)|high ambiguity|ambiguous failure/, "multiple plausible causes or ambiguity"],
  ] as const;
  const matched: string[] = complexFactors.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
  if (task.taskType === "MCP") matched.push("provider/MCP integration boundary");
  if (matched.length) return deterministic("T3", matched);
  if (task.taskType === "SCRIPT" || /\b(lint|format|metadata extraction|file lookup|read[- ]only query|deterministic command)\b/.test(text))
    return deterministic("T0", ["deterministic script or metadata operation"]);
  if (["QA_ONLY", "VALIDATION"].includes(task.taskType || "") || /\b(small|isolated|single[- ]file|typo|trivial)\b/.test(text))
    return deterministic("T1", ["small isolated task with low ambiguity"]);
  return deterministic("T2", [`normal ${String(task.taskType || "UNKNOWN").toLowerCase()} reasoning`, "no complex-state or architecture signal"]);
}

function deterministic(complexity: ReasoningComplexity, reasons: string[]): ComplexityClassification {
  return { complexity, reasons, source: "DETERMINISTIC" };
}
