import { OrchestratorRuntime } from "../runtime/runtime.js";
import { config } from "../config/env.js";

const runtime = new OrchestratorRuntime();
const health = await runtime.health.checkAll();
const bots = Object.fromEntries(Object.entries(config.botTokens).map(([id, token]) => [id, token ? "CONFIGURED" : "BOT_CONFIG_REQUIRED"]));
console.log(JSON.stringify({ projectRoot: config.HERMESS_ROOT, database: config.databasePath, health, bots }, null, 2));
runtime.store.close();
