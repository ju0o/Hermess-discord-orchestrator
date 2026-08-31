import type { Capability, Role } from "../domain/types.js";
import { ROLES } from "../domain/types.js";
import type { Store } from "../storage/database.js";

export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  DEVELOPER: ["coding"],
  REVIEWER: ["review", "repository_analysis"],
  DEBUGGER: ["debugging", "testing"],
  QA: ["testing", "review"],
  REFACTORER: ["refactoring", "testing"],
  ARCHITECT: ["architecture", "repository_analysis"],
  MCP_SPECIALIST: ["mcp", "coding"],
};

export class RoleRegistry {
  constructor(private readonly store: Store) {}

  seed(): void {
    const statement = this.store.db.prepare(`INSERT INTO roles(role_id,required_capabilities_json,description)
      VALUES(?,?,?) ON CONFLICT(role_id) DO UPDATE SET required_capabilities_json=excluded.required_capabilities_json`);
    for (const role of ROLES) statement.run(role, JSON.stringify(ROLE_CAPABILITIES[role]), `${role} role`);
  }

  requirements(role: Role): Capability[] { return [...ROLE_CAPABILITIES[role]]; }
}
