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
export function defaultResultSearchRoots(home?: string, volumesPath?: string): string[];
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
export function scanEmittedResultHashes(directories?: string[]): Set<string>;
export function dumpResultLogs(options?: { roots?: string[]; files?: string[] }): {
  files: number;
  newEntries: number;
  dest: string | null;
  dryRun?: boolean;
};
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
export function hasProviderSourceIdentifier(
  session: Record<string, unknown>
): boolean;
export function hasRecoveredTranscriptDump(
  session: Record<string, unknown>,
  previous: unknown,
  existingSessions?: Record<string, unknown>
): boolean;
export function ignoredMissingSourceReason(
  session: Record<string, unknown>,
  previous: unknown,
  existingSessions?: Record<string, unknown>
): "no-source-identifier" | "already-dumped" | null;
/** grok의 ChatKJB 오케스트레이션 턴 래퍼([CHATKJB_ORCHESTRATED_TURN]/[USER_REQUEST])를 걷어낸다. */
export function stripChatKjbTurnWrapper(text: unknown): string;
/** grok session_docs의 평문 1행을 단일 assistant 턴으로 만든다(빈 문서는 []). */
export function parseGrokDoc(content: unknown): TranscriptTurn[];
/** cline CLI의 `<user_input mode="...">`·`<mode_notice>` 래퍼를 걷어낸다. */
export function stripClineUserWrapper(text: unknown): string;
/** cline `<id>.messages.json` 문서를 사람 대화 턴으로 변환한다(도구 블록 제외). */
export function parseClineMessages(doc: unknown): TranscriptTurn[];
/** LLM-Wiki /compile의 전처리 추출기·드라이버 세션이면 true(덤프 제외 대상). */
export function isPipelineInternalSession(text: unknown): boolean;
