import { spawn } from "node:child_process";
import { config } from "../../config/env.js";
import { redact } from "../../security/redaction.js";

export interface ControlSendResult { messageId: string; reportedBy: "ASUS"; fallbackReason: "DEDICATED_ORCHESTRATOR_UNAVAILABLE"; }

export class AsusHermesControlTransport {
  async availability(): Promise<boolean> {
    try { await this.run(["--profile", config.HERMES_ASUS_PROFILE, "send", "--list", "discord", "--json"]); return true; }
    catch { return false; }
  }

  async send(channelId: string, content: string): Promise<ControlSendResult> {
    const output = await this.run(["--profile", config.HERMES_ASUS_PROFILE, "send", "--to", `discord:${channelId}`, "--file", "-", "--json"], content);
    const parsed = parseJson(output); const messageId = deepString(parsed, ["message_id", "messageId", "id"]);
    if (!messageId || !/^\d{17,20}$/.test(messageId)) throw new Error("ASUS control transport did not return a Discord message ID");
    return { messageId, reportedBy: "ASUS", fallbackReason: "DEDICATED_ORCHESTRATOR_UNAVAILABLE" };
  }

  private run(args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(config.HERMES_CLI, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
      child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString("utf8")).slice(-100_000); });
      child.stderr.on("data", (data: Buffer) => { stderr = (stderr + redact(data.toString("utf8"))).slice(-20_000); });
      child.on("error", reject); child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`ASUS control transport failed (${code}): ${stderr}`)); });
      child.stdin.end(stdin ?? "");
    });
  }
}

function parseJson(output: string): unknown {
  try { return JSON.parse(output); } catch { const line = output.split(/\r?\n/).reverse().find((item) => item.trim().startsWith("{")); try { return JSON.parse(line || "null"); } catch { return undefined; } }
}
function deepString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) { if (keys.includes(key) && typeof child === "string") return child; const nested = deepString(child, keys); if (nested) return nested; }
  return undefined;
}
