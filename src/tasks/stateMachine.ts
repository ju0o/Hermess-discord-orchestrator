import type { TaskStatus } from "../domain/types.js";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: ["DISPATCHED", "BLOCKED", "CANCELLED", "WAITING_MAIN", "HUMAN_GATE"],
  DISPATCHED: ["CLAIMED", "QUEUED", "BLOCKED", "CANCELLED", "WAITING_MAIN"],
  CLAIMED: ["RUNNING", "BLOCKED", "CANCELLED", "WAITING_MAIN"],
  RUNNING: ["WAITING_RESULT", "BLOCKED", "FAIL", "CANCELLED", "WAITING_MAIN", "HUMAN_GATE"],
  WAITING_RESULT: ["REVIEWING", "PASS", "FAIL", "BLOCKED", "WAITING_MAIN"],
  REVIEWING: ["PASS", "FAIL", "BLOCKED", "WAITING_MAIN", "HUMAN_GATE"],
  FAIL: ["QUEUED", "CANCELLED", "BLOCKED"],
  BLOCKED: ["QUEUED", "CANCELLED", "WAITING_MAIN", "HUMAN_GATE"],
  WAITING_MAIN: ["QUEUED", "DISPATCHED", "PASS", "CANCELLED", "HUMAN_GATE"],
  HUMAN_GATE: ["QUEUED", "DISPATCHED", "CANCELLED", "WAITING_MAIN"],
  PASS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`Illegal task transition: ${from} -> ${to}`);
}

export { TRANSITIONS };
