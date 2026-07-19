import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type EvidenceKind = "ripgrep" | "typecheck" | "test";

export interface Evidence {
  kind: EvidenceKind;
  pointer: string;
  summary: string;
}

export function parseRipgrep(output: string): Evidence[] {
  const lines = output.split("\n");
  const evidences: Evidence[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const path = parts[0];
    const lineNum = parts[1];
    if (path === undefined || lineNum === undefined) continue;
    if (!/^\d+$/.test(lineNum)) continue;
    const pointer = `${path}:${lineNum}`;
    const summary = parts.slice(2).join(":").trim();
    evidences.push({ kind: "ripgrep", pointer, summary });
  }
  return evidences;
}

export interface ToolEvidence {
  passed: boolean;
  evidence: Evidence[];
}

export function parseTypecheck(output: string): ToolEvidence {
  const lines = output.split("\n");
  const evidences: Evidence[] = [];
  let passed = true;
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^(.*?)(\(\d+,\d+\)): error TS\d+: (.*)$/);
    if (match) {
      passed = false;
      const path = match[1];
      const pos = match[2];
      const summary = match[3];
      if (path === undefined || pos === undefined || summary === undefined) continue;
      const pointer = `${path}${pos}`;
      evidences.push({ kind: "typecheck", pointer, summary });
    } else {
      // If we can't parse it, treat as a general error
      const parts = line.split(": ");
      if (parts.length >= 2 && parts[0] !== undefined && parts[0].endsWith("error")) {
        passed = false;
        const rawPointer = line.split(":")[0];
        const pointer = rawPointer ?? line;
        const summary = line.substring(line.indexOf(": ") + 2);
        evidences.push({ kind: "typecheck", pointer, summary });
      }
    }
  }
  return { passed, evidence: evidences };
}

export function parseVitest(output: string): ToolEvidence {
  const lines = output.split("\n");
  const evidences: Evidence[] = [];
  let passed = true;
  for (const line of lines) {
    if (line.trim().startsWith("FAIL ")) {
      passed = false;
      const fullTrimmed = line.trim();
      const afterFail = fullTrimmed.substring(5);
      let pointer = "";
      const tokens = afterFail.split(/\s+/);
      for (const token of tokens) {
        if (token.includes("/") || token.includes(".")) {
          pointer = token;
          break;
        }
      }
      if (!pointer) pointer = afterFail;
      evidences.push({ kind: "test", pointer, summary: fullTrimmed });
    }
  }

  // Check for overall pass/fail
  if (output.includes(" failed")) passed = false;
  if (output.includes("Tests") && !output.includes(" failed")) {
    // If there's a Tests line and no failed, it's a pass
    passed = true;
  }

  return { passed, evidence: evidences };
}

export async function runRipgrep(pattern: string, cwd: string, timeoutMs = 30000): Promise<Evidence[]> {
  try {
    const cmd = `rg --line-number --no-heading --color=never ${JSON.stringify(pattern)} .`;
    const { stdout } = await execAsync(cmd, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return parseRipgrep(stdout);
  } catch (e) {
    // Non-zero exit is expected when no matches
    if ((e as any).code !== 0) return [];
    throw e;
  }
}

export async function runTypecheck(cwd: string, timeoutMs = 180000): Promise<ToolEvidence> {
  try {
    const { stdout, stderr } = await execAsync("npx tsc -p tsconfig.json --noEmit", { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return parseTypecheck(stdout + stderr);
  } catch (e) {
    // Non-zero exit is expected when there are errors
    const error = e as any;
    if (error.stdout || error.stderr) {
      return parseTypecheck((error.stdout || "") + (error.stderr || ""));
    }
    throw e;
  }
}

export async function runTests(cwd: string, timeoutMs = 300000): Promise<ToolEvidence> {
  try {
    const { stdout, stderr } = await execAsync("npx vitest run", { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return parseVitest(stdout + stderr);
  } catch (e) {
    // Non-zero exit is expected when there are failures
    const error = e as any;
    if (error.stdout || error.stderr) {
      return parseVitest((error.stdout || "") + (error.stderr || ""));
    }
    throw e;
  }
}

export interface Tier0Report {
  ripgrep: Evidence[];
  typecheck: ToolEvidence;
  test: ToolEvidence;
  allPassed: boolean;
}

export async function collectTier0Evidence(cwd: string, ripgrepPattern?: string): Promise<Tier0Report> {
  const [ripgrep, typecheck, test] = await Promise.all([
    ripgrepPattern ? runRipgrep(ripgrepPattern, cwd) : Promise.resolve([]),
    runTypecheck(cwd),
    runTests(cwd)
  ]);
  return {
    ripgrep,
    typecheck,
    test,
    allPassed: typecheck.passed && test.passed
  };
}
