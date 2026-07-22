export function isSessionEligibleForCleanup(
  session: { updated_at: number; status: string },
  cutoff: number
): boolean;

export function cleanupResultLogs(
  cutoff: number,
  options?: { roots?: string[]; files?: string[] }
): {
  filesScanned: number;
  blocksDeleted: number;
  filesDeleted: number;
  legacyFilesDeleted: number;
  dumpEntries: number;
  dumpSkipped: boolean;
};

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
