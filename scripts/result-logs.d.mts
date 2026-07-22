export interface ResultLogBlock {
  timestamp: string;
  start: number;
  end: number;
  text: string;
}

export function defaultResultSearchRoots(home?: string, volumesPath?: string): string[];
export function resultSearchRootsFromEnvironment(): string[];
export function collectResultFiles(roots?: string[]): string[];
export function isCanonicalResultTimestamp(value: unknown): boolean;
export function parseResultLogBlocks(text: unknown): {
  blocks: ResultLogBlock[];
  nonconforming: boolean;
};
export function parseResultEntries(text: unknown): string[];
export function pruneExpiredResultBlocks(text: unknown, cutoff: number): {
  text: string;
  removed: number;
};
export function isConformingResultLog(text: unknown): boolean;
