import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function launchAgentLogDir(projectDir, label) {
  const dotenv = loadDotEnv(join(projectDir, ".env"));
  const configured = (
    process.env.CHATKJB_LOG_ROOT
    || dotenv.CHATKJB_LOG_ROOT
    || ""
  ).trim();
  if (!configured) return join(homedir(), "Library", "Logs", label);

  const expanded = configured === "~"
    ? homedir()
    : configured.startsWith("~/")
      ? join(homedir(), configured.slice(2))
      : configured;
  const root = isAbsolute(expanded) ? expanded : resolve(projectDir, expanded);
  return join(root, label);
}

export function launchAgentConfig(projectDir, label, nodePath, programArguments) {
  const logDir = launchAgentLogDir(projectDir, label);
  const stdoutLog = join(logDir, "stdout.log");
  const stderrLog = join(logDir, "stderr.log");
  const defaultLogDir = join(homedir(), "Library", "Logs", label);

  if (logDir === defaultLogDir) {
    return {
      logDir,
      programArguments,
      stdoutPath: stdoutLog,
      stderrPath: stderrLog
    };
  }

  return {
    logDir,
    programArguments: [
      nodePath,
      join(projectDir, "scripts", "run-launch-agent-with-logs.mjs"),
      stdoutLog,
      stderrLog,
      "--",
      ...programArguments
    ],
    stdoutPath: "/dev/null",
    stderrPath: "/dev/null"
  };
}
