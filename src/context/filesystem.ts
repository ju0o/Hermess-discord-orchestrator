import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export function readScopedFiles(workspace: string, scope: string[], maxBytes: number): Array<{ path: string; content: string }> {
  const root = path.resolve(workspace); const output: Array<{ path: string; content: string }> = []; let used = 0;
  for (const relative of scope) {
    const absolute = path.resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`FILE_SCOPE escapes workspace: ${relative}`);
    try {
      const stat = statSync(absolute); if (!stat.isFile() || stat.size > maxBytes - used) continue;
      const content = readFileSync(absolute, "utf8"); used += Buffer.byteLength(content);
      output.push({ path: path.relative(root, absolute), content });
    } catch { /* missing and binary files are omitted from prompt context */ }
  }
  return output;
}
