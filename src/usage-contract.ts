/** 사용량 스트립의 한 칸(창). utilization은 0~100 퍼센트, 알 수 없는 값은 null이고 칸은 "—"로 표시한다. */
export interface GuiUsageWindowDto {
  utilization: number | null;
  resetsAt: string | null;
}

/** Claude는 라이브 엔드포인트가 없어 마지막 세션 스냅샷만 보여 준다. */
export interface GuiClaudeUsageDto {
  fiveHour: GuiUsageWindowDto | null;
  sevenDay: GuiUsageWindowDto | null;
  /** capturedAt이 stale 임계를 넘으면 true — 프론트는 "대화 전 갱신" 주석을 단다. */
  stale: boolean;
  capturedAt: number | null;
}

/**
 * Codex는 여러 ChatGPT 구독 계정(CODEX_ACCOUNT_HOMES)을 동시에 쓸 수 있어 계정마다
 * 별도 창을 가진다. label은 표시용 계정 이름(예: 홈 디렉터리 basename), fiveHour/sevenDay는
 * 그 계정의 rate-limit 창이다. 단일 계정이면 원소 1개짜리 배열이 된다.
 */
export interface GuiCodexAccountUsageDto {
  label: string;
  fiveHour: GuiUsageWindowDto | null;
  sevenDay: GuiUsageWindowDto | null;
}

export interface GuiCodexUsageDto {
  accounts: GuiCodexAccountUsageDto[];
}

/**
 * Grok 과금 API는 한 번에 하나의 periodType만 돌려주므로, 칸(주간/월간)마다
 * 마지막으로 받은 값을 유지한다. 한 번도 못 받은 칸은 received=false("미수신").
 */
export interface GuiGrokUsageDto {
  weekly: GuiUsageWindowDto | null;
  monthly: GuiUsageWindowDto | null;
  weeklyReceived: boolean;
  monthlyReceived: boolean;
  loginRequired: boolean;
}

export interface GuiUsageDto {
  claude: GuiClaudeUsageDto;
  codex: GuiCodexUsageDto;
  grok: GuiGrokUsageDto;
}

/**
 * GUI 서버에 주입하는 사용량 소스. 구현은 fetch 실패를 예외로 던지지 않고
 * 값 부재(null 칸)로 돌려주어야 한다. 서버는 이 계약만 알고 fetch 방법은 모른다.
 */
export interface GuiUsageProvider {
  fetchClaudeUsage(): Promise<GuiClaudeUsageDto>;
  fetchCodexUsage(): Promise<GuiCodexUsageDto>;
  fetchGrokUsage(): Promise<GuiGrokUsageDto>;
}
