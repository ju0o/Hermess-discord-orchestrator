/**
 * V1 DUAL DOGFOOD 02 RETRY -- WINDOWS_EXECUTABLE_PATH_QUOTING regression coverage.
 *
 * Observed in the retry: dependencyPreflight() invokes `npm` through
 * ProcessRunner.probe(), which resolves to the standard Windows install
 * location "C:\Program Files\nodejs\npm.cmd". Launching that .cmd file via
 * cmd.exe with a plain argv array (Node's default, non-verbatim quoting)
 * left cmd.exe re-parsing its own command line -- which, under /S, only
 * honors a single pair of quotes wrapping the *entire* line -- so it split
 * at the first space in the path and failed with
 * "'C:\Program' is not recognized as an internal or external command".
 * Both fresh Product worktrees failed at exactly this boundary before a
 * Worker was ever dispatched.
 *
 * These tests exercise the real spawn boundary (not a mocked runner) using
 * deterministic fixtures placed inside a directory whose name contains a
 * space -- they do not depend on the Owner's machine actually having npm
 * installed under Program Files.
 */
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessRunner } from "../src/runtime/processRunner.js";
import { Store } from "../src/storage/database.js";
import { dependencyPreflight } from "../src/projects/dependencyPreflight.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRunner(): { runner: ProcessRunner; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "process-runner-"));
  dirs.push(dir);
  const store = new Store(path.join(dir, "test.db"));
  stores.push(store);
  return { runner: new ProcessRunner(store), dir };
}

/** A fixture directory whose absolute path deliberately contains a space,
 * mirroring the "C:\Program Files\..." shape without depending on it. */
function makeSpacedFixtureDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "process runner spaced "));
  dirs.push(dir);
  return dir;
}

describe("ProcessRunner Windows execution boundary", () => {
  it("(A) executes a no-space executable path correctly", async () => {
    const { runner } = makeRunner();
    const output = await runner.probe("cmd.exe", ["/d", "/c", "echo", "no-space-ok"], process.cwd());
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("no-space-ok");
  });

  it("(B) executes an executable whose path contains spaces without truncating it", async () => {
    const { runner } = makeRunner();
    const spaced = makeSpacedFixtureDir();
    // A real .exe (a copy of the always-present, lightweight cmd.exe) placed
    // under a spaced directory -- exercises the plain (non-.cmd) executable
    // branch with a space in the path itself.
    const target = path.join(spaced, "shell exec.exe");
    copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), target);
    const output = await runner.probe(target, ["/d", "/c", "echo", "spaced-exe-ok"], spaced);
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("spaced-exe-ok");
    // If the path were split at its first space, Windows would report the
    // truncated "shell" as not found rather than actually running it.
    expect(output.stderr).not.toMatch(/is not recognized/i);
  }, 15_000);

  it("(C) preserves arguments containing spaces as individual arguments through a spaced .cmd launcher", async () => {
    const { runner } = makeRunner();
    const spaced = makeSpacedFixtureDir();
    const script = path.join(spaced, "print-argv.mjs");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));");
    const cmd = path.join(spaced, "wrapper.cmd");
    writeFileSync(cmd, `@echo off\r\nnode "${script}" %*\r\n`);
    const output = await runner.probe(cmd, ["arg one", 'arg"two', "plain", "tail\\"], spaced);
    expect(output.exitCode).toBe(0);
    expect(JSON.parse(output.stdout.trim())).toEqual(["arg one", 'arg"two', "plain", "tail\\"]);
  });

  it("(D) invokes a Program-Files-style .cmd launcher through a spaced path without truncating it to C:\\Program", async () => {
    const { runner } = makeRunner();
    // Mirrors the real "C:\Program Files\nodejs\npm.cmd" shape via a
    // deterministic fixture rather than depending on the Owner's actual
    // npm install.
    const programFilesLike = mkdtempSync(path.join(os.tmpdir(), "Program Files "));
    dirs.push(programFilesLike);
    const script = path.join(programFilesLike, "print-version.mjs");
    writeFileSync(script, "console.log('9.9.9-stub');");
    const npmStub = path.join(programFilesLike, "npm.cmd");
    writeFileSync(npmStub, `@echo off\r\nnode "${script}"\r\n`);
    const output = await runner.probe(npmStub, ["--version"], programFilesLike);
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("9.9.9-stub");
    expect(output.stderr).not.toMatch(/'?C:\\Program'?\s+is not recognized/i);
  });

  it("(E) a genuine executable failure still fails closed (non-zero exit, no false success)", async () => {
    const { runner } = makeRunner();
    const output = await runner.probe("cmd.exe", ["/d", "/c", "exit", "7"], process.cwd());
    expect(output.exitCode).toBe(7);
    expect(output.exitCode).not.toBe(0);
  });

  it("(D+E integration) dependencyPreflight fails closed, with evidence, when the resolved npm launcher genuinely fails, through the real spawn boundary", async () => {
    const { runner } = makeRunner();
    const workspace = makeSpacedFixtureDir();
    writeFileSync(path.join(workspace, "package.json"), "{}");
    // Point PATH at a spaced fixture directory whose npm.cmd deterministically fails,
    // so dependencyPreflight's `runner.probe("npm", ...)` resolves through it.
    const npmDir = mkdtempSync(path.join(os.tmpdir(), "Program Files bin "));
    dirs.push(npmDir);
    writeFileSync(path.join(npmDir, "npm.cmd"), "@echo off\r\necho simulated npm failure 1>&2\r\nexit /b 1\r\n");
    const originalPath = process.env.PATH;
    process.env.PATH = `${npmDir}${path.delimiter}${originalPath}`;
    try {
      const result = await dependencyPreflight(runner, workspace);
      expect(result.ready).toBe(false);
      expect(result.reason).toMatch(/^DEPENDENCY_PREFLIGHT_FAILED/);
      expect(result.evidence).toHaveLength(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
