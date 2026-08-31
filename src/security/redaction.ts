const SECRET_PATTERNS: RegExp[] = [
  /\b(?:mfa\.)?[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|github_pat|xox[baprs]|sk-ant)-[A-Za-z0-9_-]{12,}\b/g,
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi,
  /("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*")[^"]+("?)/gi,
];

export function redact(input: unknown): string {
  let value = typeof input === "string" ? input : JSON.stringify(input);
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, (...args: string[]) => {
      if (args[1] && /[:=]/.test(args[1])) return `${args[1]}[REDACTED]${args[2] || ""}`;
      return "[REDACTED]";
    });
  }
  return value;
}

export function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
