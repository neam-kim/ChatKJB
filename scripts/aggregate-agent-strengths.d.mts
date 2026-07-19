export type ProviderKind = "claude" | "codex" | "agy";
export type TaskType =
  | "coding"
  | "multimodal"
  | "research"
  | "writing"
  | "automation"
  | "integration"
  | "other";
export type Outcome = "success" | "hold" | "failure" | "unknown";

export interface TranscriptRecord {
  provider: ProviderKind;
  model: string;
  topic: string;
  turns: number;
  taskType: TaskType;
  date: string;
}

export interface ProviderStat {
  sessions: number;
  totalTurns: number;
  taskTypes: Record<string, number>;
  topics: Record<string, number>;
  models: Record<string, number>;
  outcomes: Record<Outcome, number>;
  resultMentions: number;
}

export function classifyTaskType(text: string): TaskType;
export function classifyOutcome(text: string): Outcome;
export function providersMentioned(text: string): ProviderKind[];
export function collectTranscripts(directories?: string[]): TranscriptRecord[];
export function collectResultSnapshotFiles(directories?: string[]): string[];
export function collectResultEntries(directories?: string[]): string[];
export function aggregate(
  transcripts: readonly TranscriptRecord[],
  resultEntries: readonly string[]
): Record<ProviderKind, ProviderStat>;
export function buildMarkdown(
  byProvider: Record<ProviderKind, ProviderStat>,
  meta: { generatedAt: Date; transcriptCount: number; resultEntryCount: number }
): string;
export function deriveHints(byProvider: Record<ProviderKind, ProviderStat>): string[];
