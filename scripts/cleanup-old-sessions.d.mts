export function isSessionEligibleForCleanup(
  session: { updated_at: number; status: string },
  cutoff: number
): boolean;

export function enumerateDesktopFiles(
  ownedClaude: ReadonlySet<string>,
  ownedCodex: ReadonlySet<string>
): Array<{
  id: string;
  provider: "claude" | "codex" | "grok" | "cline";
  file: string;
  directory?: boolean;
  mtimeMs: number;
}>;

export function pruneClineRegistry(
  deletedIds: readonly string[],
  cutoff: number
): { rowsDeleted: number; queueRowsDeleted: number };

export function parseTelegramResponse(response: string): {
  ok: boolean;
  description: string;
};
