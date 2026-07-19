export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function appTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TZ?.trim();
  if (configured && isValidTimeZone(configured)) return configured;
  const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return systemTimeZone && isValidTimeZone(systemTimeZone) ? systemTimeZone : "UTC";
}

export function appLocale(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHATKJB_LOCALE?.trim() || "ko-KR";
}
