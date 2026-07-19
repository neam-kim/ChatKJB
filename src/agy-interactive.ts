export interface AgyInteractiveTurnResult {
  response: string;
  conversationId: string | null;
}

export interface AgyLiveStatus {
  isIdle: boolean | null;
  turnCount: number | null;
  conversationId: string | null;
}

export function normalizeAgyResponse(text: string): string {
  const clean = text.trim();
  if (clean.length % 2 === 0) {
    const midpoint = clean.length / 2;
    if (clean.slice(0, midpoint) === clean.slice(midpoint)) {
      return clean.slice(0, midpoint).trim();
    }
  }
  return clean;
}
