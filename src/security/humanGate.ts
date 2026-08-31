const GATED = [
  /production\s+deploy/i,
  /credential|token|password|api\s*key/i,
  /paid\s+resource|purchase|billing/i,
  /drop\s+(database|table)|delete\s+production|destructive\s+data/i,
  /force\s+push|--force|history\s+rewrite|rebase\s+-i/i,
  /security\s+boundary|firewall|iam\s+policy/i,
  /privacy|irreversible|material\s+(?:product\s+)?goal\s+change/i,
];

export function requiresHumanGate(text: string): { required: boolean; reason?: string } {
  const match = GATED.find((pattern) => pattern.test(text));
  return match ? { required: true, reason: `Matched protected operation policy: ${match.source}` } : { required: false };
}
