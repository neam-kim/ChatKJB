const REDACTED = "[REDACTED]";

// Provider output occasionally includes credentials as structured snippets rather than
// KEY=value text. Keep these patterns narrowly scoped to unambiguous credential forms.
const pemPrivateKeyPattern =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g;
const serviceAccountJsonSecretPattern =
  /("(?:private_key|client_secret)"\s*:\s*")(?:(?:\\.)|[^"\\])*(")/gi;

const secretPatterns: RegExp[] = [
  /\bsk-ant-oat01-[A-Za-z0-9_-]+\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /\b((?:(?:OPENAI|ANTHROPIC|CODEX|CLAUDE|TELEGRAM|GEMINI|GOOGLE)_)?(?:API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|BOT_?TOKEN|PASSWORD|SECRET))\s*[:=]\s*([^\s"'`,;]+)/gi
];

export function redactSensitiveText(value: string): string {
  const structuredRedacted = value
    .replace(pemPrivateKeyPattern, REDACTED)
    .replace(serviceAccountJsonSecretPattern, `$1${REDACTED}$2`);
  return secretPatterns.reduce((text, pattern) =>
    text.replace(pattern, (_match, name: unknown) =>
      typeof name === "string" ? `${name}=${REDACTED}` : REDACTED
    ), structuredRedacted);
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
