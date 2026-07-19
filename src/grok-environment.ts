/**
 * ChatKJB의 Grok provider는 grok.com 구독 OAuth 세션만 사용한다. 프로젝트의 API 연동용
 * 키가 프로세스 환경에 있더라도 Grok CLI 자식에는 넘기지 않아 API 과금으로 전환되지 않게 한다.
 */
export function buildGrokSubscriptionEnvironment(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.XAI_API_KEY;
  delete env.GROK_CODE_XAI_API_KEY;
  return env;
}
