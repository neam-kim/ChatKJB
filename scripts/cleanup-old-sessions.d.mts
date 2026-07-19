export function isSessionEligibleForCleanup(
  session: { updated_at: number; status: string },
  cutoff: number
): boolean;

export function parseTelegramResponse(response: string): {
  ok: boolean;
  description: string;
};
