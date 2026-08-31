import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  HERMESS_ROOT: z.string().default(process.cwd()),
  HERMESS_DATA_DIR: z.string().optional(),
  HERMESS_LOG_DIR: z.string().optional(),
  HERMESS_PROJECTS_ROOT: z.string().default(path.join(process.cwd(), "projects")),
  HERMESS_CONTROL_TOKEN: z.string().optional(),
  HERMESS_CONTROL_HOST: z.string().default("127.0.0.1"),
  HERMESS_CONTROL_PORT: z.coerce.number().int().min(0).max(65535).default(47_831),
  DISCORD_ORCHESTRATOR_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(),
  DISCORD_MAIN_USER_ID: z.string().optional(),
  DISCORD_MAIN_BOT_ID: z.string().optional(),
  DISCORD_ASUS_BOT_ID: z.string().optional(),
  DISCORD_IDENTITY_CONFIG: z.string().optional(),
  DISCORD_CODEX_BOT_TOKEN: z.string().optional(),
  DISCORD_CLAUDE_BOT_TOKEN: z.string().optional(),
  DISCORD_OPENCODE_BOT_TOKEN: z.string().optional(),
  DISCORD_COMMANDCODE_BOT_TOKEN: z.string().optional(),
  CODEX_CLI: z.string().default("codex.cmd"),
  CLAUDE_CODE_CLI: z.string().default("claude.cmd"),
  OPENCODE_CLI: z.string().default("opencode.cmd"),
  COMMAND_CODE_CLI: z.string().default("commandcode.cmd"),
  HERMES_CLI: z.string().default("hermes"),
  HERMES_ASUS_PROFILE: z.string().default("asus"),
  HERMES_ASUS_MODEL: z.string().default("tencent/hy3:free"),
  MAX_DISCUSSION_ROUNDS: z.coerce.number().int().positive().default(3),
  MAX_AUTONOMOUS_RETRIES: z.coerce.number().int().positive().default(3),
  DISCOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  TASK_STUCK_MS: z.coerce.number().int().positive().default(1_800_000),
  MAX_CONTEXT_BYTES: z.coerce.number().int().positive().default(200_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  PERFORMANCE_EARLY_SIGNAL_MIN: z.coerce.number().int().positive().default(5),
  PERFORMANCE_OBSERVED_MIN: z.coerce.number().int().positive().default(20),
});

const raw = schema.parse(process.env);
export const config = {
  ...raw,
  dataDir: raw.HERMESS_DATA_DIR || path.join(raw.HERMESS_ROOT, "data"),
  logDir: raw.HERMESS_LOG_DIR || path.join(raw.HERMESS_ROOT, "logs"),
  databasePath: path.join(raw.HERMESS_DATA_DIR || path.join(raw.HERMESS_ROOT, "data"), "orchestrator.db"),
  DISCORD_IDENTITY_CONFIG: raw.DISCORD_IDENTITY_CONFIG || path.join(raw.HERMESS_ROOT, "config", "discord-identities.json"),
  botTokens: {
    CODEX: raw.DISCORD_CODEX_BOT_TOKEN,
    CLAUDE_CODE: raw.DISCORD_CLAUDE_BOT_TOKEN,
    OPENCODE: raw.DISCORD_OPENCODE_BOT_TOKEN,
    COMMAND_CODE: raw.DISCORD_COMMANDCODE_BOT_TOKEN,
  },
} as const;
