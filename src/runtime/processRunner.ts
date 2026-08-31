import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import type { AgentId, ProcessRecord } from "../domain/types.js";
import type { Store } from "../storage/database.js";
import { redact, safeError } from "../security/redaction.js";

// ---- Windows-safe process execution (argument-safe, not shell-string) ----
//
// A plain executable (a real .exe, found either as an absolute path or via a
// PATH lookup) can always be spawned directly: Node's default, non-verbatim
// spawn quoting on Windows uses the same CommandLineToArgvW-compatible
// escaping the target process's CRT expects, and that is correct even when
// the path or an argument contains spaces -- verified directly against
// "C:\Program Files\nodejs\node.exe" during this fix.
//
// A .cmd/.bat launcher (the standard shape of a Windows npm install, e.g.
// "C:\Program Files\nodejs\npm.cmd") is different: Node refuses to spawn it
// directly without an explicit shell, and the natural-looking fix of
// spawning cmd.exe with ["/d","/s","/c", found, ...args] as a normal argv
// array is *not* safe. cmd.exe re-parses its own received command line
// using rules that, under /S, only honor a single pair of quotes wrapping
// the *entire* line -- not per-argument OS-level quoting of just the
// executable. A path with a space in the middle (like the one above) gets
// split at that first space and cmd.exe reports
// "'C:\Program' is not recognized..." -- this was the actual V1 failure
// (reproduced and confirmed against the real "C:\Program Files\nodejs"
// install while diagnosing this fix).
//
// The correction below assembles the entire cmd.exe command line ourselves
// -- escaping the executable and each argument as independent tokens, never
// concatenating raw content into one string -- and disables Node's own
// re-quoting via windowsVerbatimArguments so our escaping isn't re-escaped
// on top. This is the same escaping table and shell-invocation shape used
// by the widely-used, audited `cross-spawn` package (lib/parse.js +
// lib/util/escape.js, itself based on https://qntm.org/cmd), reimplemented
// locally rather than taking on cross-spawn as a new production dependency
// for what is currently only an incidental transitive one (pulled in by
// @vitest/coverage-v8, a dev dependency).
const WIN_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;
const WIN_CMD_SHIM_IN_NODE_MODULES = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;

function escapeCmdMetaChars(value: string): string {
  return value.replace(WIN_SHELL_META_CHARS, "^$1");
}

function escapeCmdArgument(value: string, doubleEscapeMetaChars: boolean): string {
  // Double up any backslashes that immediately precede a quote (or the end
  // of the string, once quoted), then quote the whole argument, then escape
  // cmd.exe's own metacharacters (including the space that separates
  // tokens). Ported verbatim from cross-spawn's lib/util/escape.js, whose
  // backslash regexes are deliberately written to avoid catastrophic
  // backtracking on crafted input (see moxystudio/node-cross-spawn#160).
  let arg = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`;
  arg = escapeCmdMetaChars(arg);
  if (doubleEscapeMetaChars) arg = escapeCmdMetaChars(arg);
  return arg;
}

interface ExecutionPlan { executable: string; args: string[]; windowsVerbatimArguments: boolean; display: string; }

function planCmdShellInvocation(found: string, args: string[]): ExecutionPlan {
  const normalized = path.normalize(found);
  // A local node_modules/.bin/*.cmd shim re-invokes node with its arguments
  // proxied through cmd.exe a second time; its metacharacter escaping needs
  // to survive that extra hop, hence the double escape.
  const doubleEscape = WIN_CMD_SHIM_IN_NODE_MODULES.test(normalized);
  const shellCommand = [escapeCmdMetaChars(normalized), ...args.map((a) => escapeCmdArgument(a, doubleEscape))].join(" ");
  return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${shellCommand}"`], windowsVerbatimArguments: true, display: found };
}

function resolveExecutable(command: string, args: string[]): ExecutionPlan {
  const candidates: string[] = [];
  if (path.isAbsolute(command)) candidates.push(command);
  else {
    for (const directory of (process.env.PATH || "").split(path.delimiter)) {
      if (!directory) continue;
      for (const ext of process.platform === "win32" ? [".cmd", ".exe", ".ps1", ".bat", ""] : [""]) {
        candidates.push(path.join(directory, command.replace(/\.(cmd|ps1|exe|bat)$/i, "") + ext));
      }
    }
  }
  const found = candidates.find(existsSync);
  if (!found) return { executable: command, args, windowsVerbatimArguments: false, display: command };
  if (found.toLowerCase().endsWith(".ps1")) {
    return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", found, ...args], windowsVerbatimArguments: false, display: found };
  }
  if (/\.(cmd|bat)$/i.test(found)) return planCmdShellInvocation(found, args);
  return { executable: found, args, windowsVerbatimArguments: false, display: found };
}

export interface RunSpec {
  agentId: AgentId;
  taskId: string;
  executable: string;
  args: string[];
  cwd: string;
  stdin?: string;
  sessionId?: string;
}

export interface RunOutput {
  stdout: string; stderr: string; exitCode: number | null; processId: string; logPath: string;
  /**
   * Set only when process creation itself failed before the executable could
   * run.  Consumers must not infer this from an ordinary non-zero exit.
   */
  spawnErrorCode?: string;
  /**
   * Set when every bounded pipe-wedge retry (see the unified-exec timeout
   * handling below) was exhausted and the runner still could not deliver a
   * real execution attempt. This is a transport failure, not a Worker
   * outcome: callers must never let a truthy `exitCode === 0` on its own
   * stand in for a genuine Result when this is set.
   */
  transportWedgeExhausted?: boolean;
}

export class ProcessRunner {
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(private readonly store: Store) { mkdirSync(config.logDir, { recursive: true }); }

  async probe(executable: string, args: string[], cwd = config.HERMESS_ROOT, timeoutMs = 15_000): Promise<RunOutput> {
    return this.spawnAndCollect({ agentId: "CODEX", taskId: `probe-${randomUUID()}`, executable, args, cwd }, false, timeoutMs);
  }

  run(spec: RunSpec): Promise<RunOutput> { return this.spawnAndCollect(spec, true); }

  cancelTask(taskId: string): boolean {
    const row = this.store.db.prepare("SELECT process_id FROM worker_processes WHERE task_id=? AND status='RUNNING' ORDER BY started_at DESC LIMIT 1").get(taskId) as { process_id: string } | undefined;
    if (!row) return false;
    const child = this.children.get(row.process_id);
    if (!child) return false;
    child.kill("SIGTERM");
    this.store.db.prepare("UPDATE worker_processes SET status='CANCELLED',last_seen=? WHERE process_id=?").run(this.store.now(), row.process_id);
    return true;
  }

  private spawnAndCollect(spec: RunSpec, persist: boolean, timeoutMs?: number): Promise<RunOutput> {
    const processId = randomUUID();
    const logPath = path.join(config.logDir, `${spec.taskId}-${processId.slice(0, 8)}.log`);
    const resolved = resolveExecutable(spec.executable, spec.args);
    const spawnOnce = () => spawn(resolved.executable, resolved.args, {
      cwd: spec.cwd, windowsHide: true, windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let child = spawnOnce();
    const isPipeTimeout = (stderr: string) => stderr.includes("Failed to create unified exec process") && stderr.includes("timed out after 15000ms");
    let pipeRetries = 0;
    if (spec.stdin !== undefined) child.stdin.end(spec.stdin); else child.stdin.end();
    if (persist && child.pid) {
      const now = this.store.now();
      const task = this.store.db.prepare("SELECT attempt FROM tasks WHERE task_id=?").get(spec.taskId) as { attempt: number } | undefined;
      this.store.db.prepare(`INSERT INTO worker_processes(process_id,agent_id,task_id,attempt,pid,working_dir,session_id,
        started_at,last_seen,status,log_path) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(processId, spec.agentId, spec.taskId, task?.attempt ?? 1, child.pid, spec.cwd, spec.sessionId ?? null, now, now, "RUNNING", logPath);
      this.children.set(processId, child);
    }

    return new Promise((resolve) => {
      let stdout = "", stderr = "";
      let spawnErrorCode: string | undefined;
      let stdoutHandler: (d: Buffer) => void = () => {};
      let stderrHandler: (d: Buffer) => void = () => {};
      let errorHandler: (e: Error) => void = () => {};
      let closeHandler: (code: number | null) => void = () => {};
      let timer: NodeJS.Timeout | undefined;
      const attach = () => {
        stdoutHandler = (data: Buffer) => {
          const safe = redact(data.toString("utf8"));
          appendFileSync(logPath, `[${new Date().toISOString()}] stdout: ${safe}`);
          stdout = (stdout + safe).slice(-2_000_000);
          if (persist) try { this.store.db.prepare("UPDATE worker_processes SET last_seen=? WHERE process_id=?").run(this.store.now(), processId); } catch {}
        };
        stderrHandler = (data: Buffer) => {
          const safe = redact(data.toString("utf8"));
          appendFileSync(logPath, `[${new Date().toISOString()}] stderr: ${safe}`);
          stderr = (stderr + safe).slice(-500_000);
          if (persist) try { this.store.db.prepare("UPDATE worker_processes SET last_seen=? WHERE process_id=?").run(this.store.now(), processId); } catch {}
        };
        errorHandler = (error: Error) => {
          spawnErrorCode = (error as NodeJS.ErrnoException).code;
          stderr += safeError(error);
        };
        closeHandler = (exitCode: number | null) => {
          if (timer) clearTimeout(timer);
          const pipeWedge = persist && isPipeTimeout(stderr) && pipeRetries < 2;
          if (pipeWedge) {
            pipeRetries++;
            appendFileSync(logPath, `[${new Date().toISOString()}] retry: codex pipe wedge detected, retry ${pipeRetries}/2 after 3s\n`);
            this.children.delete(processId);
            stderr = ""; stdout = "";
            setTimeout(() => {
              child = spawnOnce();
              if (spec.stdin !== undefined) child.stdin.end(spec.stdin); else child.stdin.end();
              if (child.pid) {
                try { this.store.db.prepare("UPDATE worker_processes SET pid=?,last_seen=? WHERE process_id=?").run(child.pid, this.store.now(), processId); } catch {}
                this.children.set(processId, child);
              }
              // `attach()` already attaches stdoutHandler/stderrHandler/errorHandler/
              // closeHandler to the freshly respawned `child` at its own end -- do not
              // attach them again here. A prior version of this retry path re-attached
              // the same handler references a second time, so the respawned process's
              // "close" event fired closeHandler twice: the first call correctly detected
              // the next pipe wedge and scheduled another retry, but the second call ran
              // against the just-reset (empty) stderr/stdout, judged no wedge, and
              // resolved the whole run() Promise early with a false "succeeded" empty
              // result -- while the retry the first call had scheduled kept running as an
              // orphaned, unresolved respawn. REVIEWER_UNIFIED_EXEC_PIPE_IN_FAILURE.
              attach();
              if (timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
            }, 3000);
            return;
          }
          this.children.delete(processId);
          // Every bounded retry was spent and the transport is still wedged.
          // The process may still exit 0 (Codex can report the pipe failure
          // internally and exit cleanly) -- that must not be mistaken for a
          // real execution attempt by any caller that only checks exitCode.
          const transportWedgeExhausted = persist && isPipeTimeout(stderr) && pipeRetries >= 2;
          if (persist) try { this.store.db.prepare("UPDATE worker_processes SET status='EXITED',exit_code=?,last_seen=? WHERE process_id=?").run(exitCode, this.store.now(), processId); } catch {}
          resolve({ stdout, stderr, exitCode, processId, logPath,
            ...(spawnErrorCode ? { spawnErrorCode } : {}),
            ...(transportWedgeExhausted ? { transportWedgeExhausted: true } : {}) });
        };
        child.stdout.on("data", stdoutHandler);
        child.stderr.on("data", stderrHandler);
        child.on("error", errorHandler);
        child.on("close", closeHandler);
      };
      attach();
      if (timeoutMs) timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    });
  }
}
