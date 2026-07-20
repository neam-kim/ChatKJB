#!/usr/bin/env node
// Generates RESUME.md from .fablize state so a fresh session can pick up
// interrupted work without re-reading the transcript.
// Usage: node scripts/fablize-resume.mjs [--check]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const goalsPath = join(repoRoot, '.fablize', 'goals.json');
const ledgerPath = join(repoRoot, '.fablize', 'ledger.jsonl');
const outPath = join(repoRoot, 'RESUME.md');
const checkOnly = process.argv.includes('--check');

if (!existsSync(goalsPath)) {
  console.error('No .fablize/goals.json — nothing in progress. Not writing RESUME.md.');
  process.exit(1);
}

const goals = JSON.parse(readFileSync(goalsPath, 'utf8'));

// Ledger is append-only; a truncated final line is expected after a kill.
const ledger = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      })
  : [];

const items = goals.goals ?? [];
const done = items.filter((g) => g.status === 'complete');
const pending = items.filter((g) => g.status !== 'complete');
const recent = ledger.slice(-8);

const md = `# RESUME

Generated from \`.fablize/\` state. A fresh session should read this first.

**Brief:** ${goals.brief ?? '(none recorded)'}

**Progress:** ${done.length}/${items.length} goals complete${pending.length ? ` — next: ${pending[0].id} ${pending[0].title}` : ' — all goals complete'}

## Completed

${done.length ? done.map((g) => `- **${g.id} ${g.title}** — ${g.evidence || 'no evidence recorded'}`).join('\n') : '_none_'}

## Remaining

${pending.length ? pending.map((g) => `- **${g.id} ${g.title}** (${g.status}) — ${g.objective ?? ''}`).join('\n') : '_none_'}

## Recent ledger events

${recent.length ? recent.map((e) => `- \`${e.ts}\` ${e.event} ${e.id ?? ''} ${e.status ?? ''}${e.verify_cmd ? ` (verify: \`${e.verify_cmd}\`)` : ''}`).join('\n') : '_none_'}

## How to continue

1. Read the remaining goals above.
2. Work the next goal incrementally; checkpoint to \`.fablize\` after each unit.
3. Verify with the recorded \`verify_cmd\` before marking complete.
4. Re-run \`node scripts/fablize-resume.mjs\` to refresh this file.

> Evidence lives on disk in \`.fablize/ledger.jsonl\`. Never rely on subagent return values or conversation context to know what finished.
`;

if (checkOnly) {
  console.log(md);
  process.exit(0);
}

writeFileSync(outPath, md);
console.log(`RESUME.md written: ${done.length}/${items.length} complete, ${pending.length} remaining.`);
