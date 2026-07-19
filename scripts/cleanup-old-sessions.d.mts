export function isSessionEligibleForCleanup(
  session: { updated_at: number; status: string },
  cutoff: number
): boolean;

export function enumerateDesktopFiles(
  ownedClaude: ReadonlySet<string>,
  ownedCodex: ReadonlySet<string>
): Array<{
  id: string;
  provider: "claude" | "codex" | "grok";
  file: string;
  directory?: boolean;
  mtimeMs: number;
}>;

export function parseTelegramResponse(response: string): {
  ok: boolean;
  description: string;
};
