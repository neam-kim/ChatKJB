export function resolveNodeBinDir(
  env?: NodeJS.ProcessEnv,
  execPath?: string
): string;

export function resolveBin(
  name: string,
  candidates: Array<string | null | undefined>,
  pathValue?: string | undefined
): string | null;

export function parseTelegramResponse(response: string): {
  ok: boolean;
  description: string;
};

export type AgentSyncUpdateStatus = "updated" | "latest" | "failed" | "skipped";

export type AgentSyncUpdateLine = {
  name: string;
  status: AgentSyncUpdateStatus;
  before?: string | null;
  after?: string | null;
  error?: string;
};

export function formatAgentSyncReport(
  report: {
    updates: AgentSyncUpdateLine[];
    current: {
      codexCli: string | null;
      codexSdk: string | null;
      claude: string | null;
      grok: string | null;
      agy: string | null;
      /** cline은 SDK-CLI 락스텝이 없어 보고용으로만 싣는다. */
      clineCli?: string | null;
      clineSdk?: string | null;
    };
    lockstep?: { from: string | null; to: string; ok: boolean; } | null;
    restartReason?: string | null;
    outcome?: string | null;
  },
  date?: Date
): string;
