const REDACTED = "[REDACTED]";

const secretPatterns: RegExp[] = [
  /\bsk-ant-oat01-[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /\b((?:OPENAI|ANTHROPIC|CODEX|CLAUDE|TELEGRAM)?_?(?:API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|BOT_?TOKEN|PASSWORD|SECRET))\s*[:=]\s*([^\s"'`,;]+)/gi
];

export function redactSensitiveText(value: string): string {
  return secretPatterns.reduce((text, pattern) =>
    text.replace(pattern, (_match, name: unknown) =>
      typeof name === "string" ? `${name}=${REDACTED}` : REDACTED
    ), value);
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, redactSensitiveValue(item)])
    );
  }
  return value;
}
