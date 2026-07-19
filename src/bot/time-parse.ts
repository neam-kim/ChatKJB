import type { ReservedTaskStartOptions } from "../types.js";
import type { PendingStartOptions } from "./pending-keys.js";

export const MAX_RESERVE_TIMEOUT_MS = 2_147_000_000;

interface ParsedReserveCommand {
  projectIdentifier: string;
  dueAt: number;
  prompt: string;
}

export function makeLocalDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): Date | null {
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
  ) {
    return null;
  }
  return date;
}

export function parseKoreanHour(period: string | undefined, rawHour: string): number | null {
  const hour = Number.parseInt(rawHour, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!period) return hour;
  if (hour < 1 || hour > 12) return null;
  if (period === "오전") return hour === 12 ? 0 : hour;
  if (period === "오후") return hour === 12 ? 12 : hour + 12;
  return null;
}

export function parseReserveTime(input: string, now = new Date()): { dueAt: number; prompt: string } | null {
  const text = input.trim().replace(/\s+/g, " ");
  let match = /^(\d+)\s*(분|시간)\s*(?:뒤|후)\s+(.+)$/.exec(text);
  if (match) {
    const amount = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(amount) || amount <= 0) return null;
    const unitMs = match[2] === "시간" ? 3_600_000 : 60_000;
    return { dueAt: now.getTime() + amount * unitMs, prompt: match[3]!.trim() };
  }

  match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s+(.+)$/.exec(text);
  if (match) {
    const date = makeLocalDate(
      Number.parseInt(match[1]!, 10),
      Number.parseInt(match[2]!, 10),
      Number.parseInt(match[3]!, 10),
      Number.parseInt(match[4]!, 10),
      Number.parseInt(match[5]!, 10)
    );
    return date ? { dueAt: date.getTime(), prompt: match[6]!.trim() } : null;
  }

  match = /^(오늘|내일)\s+(오전|오후)?\s*(\d{1,2})(?:시(?:에)?)?(?:\s*(\d{1,2})분|:(\d{2}))?\s+(.+)$/.exec(text);
  if (match) {
    const hour = parseKoreanHour(match[2], match[3]!);
    const minute = Number.parseInt(match[4] ?? match[5] ?? "0", 10);
    if (hour === null || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    const date = new Date(now);
    if (match[1] === "내일") date.setDate(date.getDate() + 1);
    const due = makeLocalDate(date.getFullYear(), date.getMonth() + 1, date.getDate(), hour, minute);
    return due ? { dueAt: due.getTime(), prompt: match[6]!.trim() } : null;
  }

  match = /^(오전|오후)?\s*(\d{1,2})(?:시(?:에)?)?(?:\s*(\d{1,2})분|:(\d{2}))?\s+(.+)$/.exec(text);
  if (match) {
    const hour = parseKoreanHour(match[1], match[2]!);
    const minute = Number.parseInt(match[3] ?? match[4] ?? "0", 10);
    if (hour === null || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    const due = makeLocalDate(now.getFullYear(), now.getMonth() + 1, now.getDate(), hour, minute);
    if (!due) return null;
    if (due.getTime() <= now.getTime()) due.setDate(due.getDate() + 1);
    return { dueAt: due.getTime(), prompt: match[5]!.trim() };
  }

  return null;
}

export function cleanReservedTaskStartOptions(fields: Partial<PendingStartOptions>): ReservedTaskStartOptions {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as ReservedTaskStartOptions;
}

export function parseReserveCommand(input: string, now = new Date()): ParsedReserveCommand | null {
  const trimmed = input.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace <= 0) return null;
  const projectIdentifier = trimmed.slice(0, firstSpace);
  const parsed = parseReserveTime(trimmed.slice(firstSpace + 1), now);
  if (!parsed || !parsed.prompt) return null;
  return { projectIdentifier, ...parsed };
}
