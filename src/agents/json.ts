export function parseJsonLines(output: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const line of output.split(/\r?\n/)) {
    try { const value = JSON.parse(line) as unknown; if (value && typeof value === "object") values.push(value as Record<string, unknown>); }
    catch { /* non-JSON progress is intentionally ignored */ }
  }
  return values;
}

export function findDeepString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.includes(key) && typeof child === "string" && child.trim()) return child;
    const nested = findDeepString(child, keys); if (nested) return nested;
  }
  return undefined;
}

export function findLastDeepString(values: unknown[], keys: string[]): string | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = findDeepString(values[index], keys);
    if (value) return value;
  }
  return undefined;
}
