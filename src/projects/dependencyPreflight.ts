import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProcessRunner } from "../runtime/processRunner.js";

export interface DependencyPreflightResult { ready: boolean; reason: string; evidence: string[]; }

const INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Deterministic Company-owned preflight for a Product worktree: verifies (and,
 * when possible, establishes) that the assigned workspace is execution-ready
 * before a Worker is ever dispatched into it. A fresh isolated `git worktree`
 * checks out tracked source but never brings along the gitignored
 * `node_modules` tree, so a freshly created worktree has no usable
 * dependencies and standard validation (typecheck/test/build) cannot run.
 *
 * This runs the install itself via the existing ProcessRunner primitive
 * (deterministic, bounded, non-interactive) rather than granting the Worker
 * arbitrary package-install authority mid-execution -- a Worker hitting a
 * missing-dependency wall has no lawful way to fix it under policy, and
 * cannot be relied on to fail closed when it tries anyway.
 */
export async function dependencyPreflight(runner: ProcessRunner, workspace: string): Promise<DependencyPreflightResult> {
  const manifest = path.join(workspace, "package.json");
  if (!existsSync(manifest)) return { ready: true, reason: "NOT_A_NODE_PROJECT", evidence: [] };
  const modules = path.join(workspace, "node_modules");
  if (existsSync(modules)) return { ready: true, reason: "DEPENDENCIES_PRESENT", evidence: [] };
  const lockfile = existsSync(path.join(workspace, "package-lock.json"));
  const args = [...(lockfile ? ["ci"] : ["install"]), "--no-audit", "--no-fund"];
  const output = await runner.probe("npm", args, workspace, INSTALL_TIMEOUT_MS);
  if (output.exitCode === 0 && existsSync(modules)) return { ready: true, reason: "DEPENDENCIES_INSTALLED", evidence: [output.logPath] };
  return { ready: false, reason: `DEPENDENCY_PREFLIGHT_FAILED:exit=${output.exitCode}`, evidence: [output.logPath] };
}

const NEXT_BUILD_TIMEOUT_MS = 5 * 60_000;

function isNextProject(workspace: string, manifest: string): boolean {
  if (["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"].some((f) => existsSync(path.join(workspace, f)))) return true;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return Boolean(pkg.dependencies?.next || pkg.devDependencies?.next);
  } catch { return false; }
}

/**
 * Deterministic Company-owned preflight for a Next.js Product worktree,
 * mirroring dependencyPreflight above: Next generates `.next/types` (and the
 * `next-env.d.ts` that carries an explicit, non-glob triple-slash reference
 * into it) as a side effect of `next dev`/`next build`, and both are
 * gitignored -- exactly like node_modules, a fresh isolated `git worktree`
 * never brings them along.
 *
 * The failure this produces is easy to misdiagnose as a real revision
 * defect: TypeScript treats a missing *glob* `include` entry (e.g.
 * `.next/types/**\/*.ts`) as a silent no-op, but a missing *explicit*
 * reference target (the `/// <reference path="./.next/types/routes.d.ts" />`
 * line `next-env.d.ts` itself carries) is a hard TS6053 "File not found"
 * failure -- reproduced directly against `tsc` while diagnosing this fix:
 * a project whose entrypoint carries such a reference fails with exit code
 * 2 before a single line of real Product code is type-checked, regardless
 * of whether that code is correct.
 *
 * Whether this artifact happens to already exist is an accident of which
 * workspace a Task lands in (a long-lived checkout an Owner has previously
 * built in vs. a freshly created revision worktree) -- not a property of
 * the Product state being validated. Authoritative validation must not
 * pass or fail on that accident, so this generates the prerequisite the
 * same way dependencyPreflight generates node_modules: deterministically,
 * via the Product's own `build` script (the same command already run later
 * as the authoritative build gate) through the existing ProcessRunner
 * primitive -- Company-run and bounded, never delegated to the Worker.
 */
export async function nextTypesPreflight(runner: ProcessRunner, workspace: string): Promise<DependencyPreflightResult> {
  const manifest = path.join(workspace, "package.json");
  if (!existsSync(manifest) || !isNextProject(workspace, manifest)) return { ready: true, reason: "NOT_A_NEXT_PROJECT", evidence: [] };
  const typesDir = path.join(workspace, ".next", "types");
  if (existsSync(typesDir)) return { ready: true, reason: "NEXT_TYPES_PRESENT", evidence: [] };
  const output = await runner.probe("npm", ["run", "build"], workspace, NEXT_BUILD_TIMEOUT_MS);
  if (output.exitCode === 0 && existsSync(typesDir)) return { ready: true, reason: "NEXT_TYPES_GENERATED", evidence: [output.logPath] };
  return { ready: false, reason: `NEXT_TYPES_PREFLIGHT_FAILED:exit=${output.exitCode}`, evidence: [output.logPath] };
}
