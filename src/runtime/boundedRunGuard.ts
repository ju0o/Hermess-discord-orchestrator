import type { Store } from "../storage/database.js";

export interface BoundedRunGuardOptions {
  maxConsecutiveWaits?: number;
  noProgressMs?: number;
}

export interface BoundedRunGuardResult {
  shouldStop: boolean;
  reason?: string;
  evidence: Record<string, unknown>;
}

export class BoundedRunGuard {
  private consecutiveWaits = 0;
  private lastProgressAt = Date.now();
  constructor(private readonly store: Store, private readonly options: BoundedRunGuardOptions = {}) {}

  observe(taskStatuses: string[]): BoundedRunGuardResult {
    const waitingMain = taskStatuses.filter((s) => s === "WAITING_MAIN").length;
    const hasWaitingMain = waitingMain > 0;
    if (hasWaitingMain) this.consecutiveWaits++;
    else { this.consecutiveWaits = 0; this.lastProgressAt = Date.now(); }
    const maxWaits = this.options.maxConsecutiveWaits ?? 3;
    if (this.consecutiveWaits >= maxWaits) {
      return { shouldStop: true, reason: `BOUNDED_RUN_WATCHDOG: ${this.consecutiveWaits} consecutive WAITING_MAIN observations`, evidence: { consecutiveWaits: this.consecutiveWaits, waitingMain, at: this.store.now() } };
    }
    const noProgressMs = this.options.noProgressMs;
    if (noProgressMs && Date.now() - this.lastProgressAt > noProgressMs) {
      return { shouldStop: true, reason: `BOUNDED_RUN_NO_PROGRESS: no non-WAITING_MAIN progress for ${noProgressMs}ms`, evidence: { noProgressMs, lastProgressAt: this.lastProgressAt, at: this.store.now() } };
    }
    return { shouldStop: false, evidence: { consecutiveWaits: this.consecutiveWaits, waitingMain, at: this.store.now() } };
  }

  evaluate(deadPids: number, lostProcesses: number, waitingMainCount: number): BoundedRunGuardResult {
    const evidence: Record<string, unknown> = { deadPids, lostProcesses, waitingMainCount, consecutiveWaits: this.consecutiveWaits, at: this.store.now() };
    if (waitingMainCount > 0) this.consecutiveWaits++;
    else { this.consecutiveWaits = 0; this.lastProgressAt = Date.now(); }
    const maxWaits = this.options.maxConsecutiveWaits ?? 3;
    if (this.consecutiveWaits >= maxWaits) return { shouldStop: true, reason: `BOUNDED_RUN_WATCHDOG: ${this.consecutiveWaits} consecutive WAITING_MAIN observations (deadPids=${deadPids}, lost=${lostProcesses})`, evidence };
    return { shouldStop: false, evidence };
  }

  reset(): void { this.consecutiveWaits = 0; this.lastProgressAt = Date.now(); }
}
