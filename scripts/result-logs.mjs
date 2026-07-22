import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const RESULT_LOG_HEADER = /^##\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00)\s*$/mu;
const REQUIRED_FIELDS = ["Request", "Decision", "Result"];

export function defaultResultSearchRoots(home = homedir(), volumesPath = "/Volumes") {
  const cloudStorage = join(home, "Library", "CloudStorage");
  const roots = [];
  const tryAdd = (candidate) => {
    try {
      const canonical = realpathSync(candidate);
      if (canonical !== "/" && statSync(canonical).isDirectory()) roots.push(canonical);
    } catch {
      // 사라졌거나 접근할 수 없는 저장소는 제외한다.
    }
  };
  try {
    for (const entry of readdirSync(cloudStorage, { withFileTypes: true })) {
      if (!entry.name.startsWith(".")) tryAdd(join(cloudStorage, entry.name));
    }
  } catch {
    // CloudStorage가 없을 수 있다.
  }
  try {
    for (const entry of readdirSync(volumesPath, { withFileTypes: true })) {
      if (!entry.name.startsWith(".")) tryAdd(join(volumesPath, entry.name));
    }
  } catch {
    // 외장 또는 네트워크 볼륨이 없을 수 있다.
  }
  return [...new Set([home, ...roots].map((root) => resolve(root)))];
}

export function resultSearchRootsFromEnvironment() {
  return process.env.RESULT_SEARCH_ROOTS
    ? process.env.RESULT_SEARCH_ROOTS.split(delimiter).filter(Boolean).map((root) => resolve(root))
    : defaultResultSearchRoots();
}

export function collectResultFiles(roots = resultSearchRootsFromEnvironment()) {
  const normalizedRoots = [...new Set(roots.map((root) => resolve(root)))];
  const rootSet = new Set(normalizedRoots);
  const found = new Set();

  const walk = (directory, activeRoot) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === ".result.md") {
        found.add(resolve(path));
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (
        entry.name.startsWith(".")
        || entry.name === "#recycle"
        || entry.name === "@eaDir"
        || /^node_modules(?:[._-].*)?$/iu.test(entry.name)
      ) continue;
      const resolvedPath = resolve(path);
      if (resolvedPath !== activeRoot && rootSet.has(resolvedPath)) continue;
      walk(resolvedPath, activeRoot);
    }
  };

  for (const root of normalizedRoots) {
    if (existsSync(root)) walk(root, root);
  }
  return [...found].sort();
}

export function isCanonicalResultTimestamp(value) {
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+09:00$/u
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return utc.getUTCFullYear() === year
    && utc.getUTCMonth() === month - 1
    && utc.getUTCDate() === day
    && utc.getUTCHours() === hour
    && utc.getUTCMinutes() === minute
    && utc.getUTCSeconds() === second;
}

function hasRequiredFields(text) {
  const lines = String(text)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === REQUIRED_FIELDS.length + 1
    && REQUIRED_FIELDS.every((field, index) =>
      new RegExp(`^- ${field}:\\s+\\S`, "u").test(lines[index + 1])
    );
}

export function parseResultLogBlocks(text) {
  const source = String(text);
  const headers = [...source.matchAll(/^##\s+.*$/gmu)];
  const blocks = [];
  let nonconforming = false;
  let cursor = 0;

  for (let index = 0; index < headers.length; index++) {
    const header = headers[index];
    const start = header.index ?? 0;
    const end = index + 1 < headers.length
      ? headers[index + 1].index ?? source.length
      : source.length;
    if (source.slice(cursor, start).trim()) nonconforming = true;
    cursor = end;

    const headerMatch = header[0].match(RESULT_LOG_HEADER);
    const raw = source.slice(start, end);
    if (!headerMatch || !isCanonicalResultTimestamp(headerMatch[1]) || !hasRequiredFields(raw)) {
      nonconforming = true;
      continue;
    }
    blocks.push({
      timestamp: headerMatch[1],
      start,
      end,
      text: raw.trim(),
    });
  }
  if (!headers.length && source.trim()) nonconforming = true;
  if (headers.length && source.slice(cursor).trim()) nonconforming = true;
  return { blocks, nonconforming };
}

export function parseResultEntries(text) {
  return parseResultLogBlocks(text).blocks.map((block) => block.text);
}

export function pruneExpiredResultBlocks(text, cutoff) {
  const source = String(text);
  const { blocks } = parseResultLogBlocks(source);
  const expired = blocks.filter((block) => Date.parse(block.timestamp) < cutoff);
  if (!expired.length) return { text: source, removed: 0 };

  let next = source;
  for (const block of [...expired].reverse()) {
    next = next.slice(0, block.start) + next.slice(block.end);
  }
  return { text: next.replace(/^\s+|\s+$/gu, "") + (next.trim() ? "\n" : ""), removed: expired.length };
}

export function isConformingResultLog(text) {
  const parsed = parseResultLogBlocks(text);
  return parsed.blocks.length > 0 && !parsed.nonconforming;
}
