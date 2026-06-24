export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  ts?: string;
}

export interface TranscriptChunk {
  turns: TranscriptTurn[];
  start: number;
  end: number;
  hash: string;
}

export function normalizeFingerprintText(text: string): string;
export function fingerprintTurns(turns: TranscriptTurn[]): string;
export function chunkTurns(turns: TranscriptTurn[]): TranscriptChunk[];
export function collectResultFiles(roots?: string[]): string[];
export function parseResultEntries(text: string): string[];
export function collectMergedResultEntries(
  roots?: string[],
  files?: string[]
): {
  sources: Array<{
    file: string;
    projectDirectory: string;
    relativePath: string;
    root: string;
    entries: Array<{ text: string; hash: string }>;
  }>;
  hashes: string[];
};
export function buildMergedResultsMarkdown(
  merged: ReturnType<typeof collectMergedResultEntries>,
  generatedAt?: Date
): string;
export function buildMarkdown(
  session: Record<string, unknown>,
  chunks: TranscriptChunk[],
  part: number
): string;
export function readFrontmatter(file: string): Record<string, string> | null;
export function scanExistingTranscriptSources(directories?: string[]): {
  sessions: Record<string, { maxTurnEnd: number; maxPart: number }>;
  emittedChunkHashes: Record<string, string>;
};
