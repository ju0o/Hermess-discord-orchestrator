import type { Store } from "../storage/database.js";

export type OwnerControlMode = "RUNNING" | "PAUSED_BY_OWNER" | "FULL_STOP";

export interface OwnerControlState {
  mode: OwnerControlMode;
  reason: string;
  source: string;
  updatedAt: string;
}

const KEY = "office:owner_control";

/** Durable, deterministic control that takes precedence over dispatch and recovery. */
export class OwnerControl {
  constructor(private readonly store: Store) {}

  get(): OwnerControlState {
    return this.store.getRuntimeState<OwnerControlState>(KEY) || {
      mode: "RUNNING", reason: "INITIAL_DEFAULT", source: "SYSTEM", updatedAt: this.store.now(),
    };
  }

  isPaused(): boolean { return this.get().mode !== "RUNNING"; }

  pause(reason: string, source = "OWNER"): OwnerControlState {
    return this.set("PAUSED_BY_OWNER", reason, source);
  }

  fullStop(reason: string, source = "OWNER"): OwnerControlState {
    return this.set("FULL_STOP", reason, source);
  }

  resume(reason: string, source = "OWNER"): OwnerControlState {
    return this.set("RUNNING", reason, source);
  }

  private set(mode: OwnerControlMode, reason: string, source: string): OwnerControlState {
    const state = { mode, reason, source, updatedAt: this.store.now() } satisfies OwnerControlState;
    this.store.upsertRuntimeState(KEY, state);
    this.store.upsertRuntimeState("office:product_checkpoint", {
      state: mode === "RUNNING" ? "READY_FOR_EXPLICIT_RESUME" : "PAUSED_FOR_SYMPHONY_INFRA_FIX",
      ownerControl: mode, updatedAt: state.updatedAt,
    });
    return state;
  }
}
