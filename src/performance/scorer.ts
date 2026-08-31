/** Extension point only. Phase G never feeds performance into routing. */
export class PerformanceScorer {
  readonly enabled = false;
  score(): never { throw new Error("PERFORMANCE_LEARNING_DISABLED"); }
}
