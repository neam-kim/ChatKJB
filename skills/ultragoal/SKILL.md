---
name: ultragoal
description: Execute an approved plan as durable sequential goals with a canonical goals file, append-only evidence ledger, autonomous blocker handling, delegated implementation when scope is large, and strict verification before completion. Use for /ultragoal, "울트라고울", "울트라골", durable multi-goal execution, or an approved Ralplan handoff.
---

# Ultragoal

Drive an approved plan to verified completion while preserving goal identity, status, evidence, blockers, steering, and review receipts on disk.

## ChatKJB contract

- Use the exact `State root` supplied by ChatKJB. If absent, use `.chatkjb/workflows/ultragoal-<timestamp>-<slug>`.
- Preserve the user's language and requested formality.
- Treat an explicit `/ultragoal <approved plan or concrete task>` invocation as execution approval only for the named scope. It does not authorize destructive operations, external publication, secrets, permission expansion, or unrelated cleanup.
- If no approved plan/spec exists and the request lacks concrete scope plus acceptance criteria, load `ralplan` first and stop. Do not execute an improvised scope.
- Do not change ChatKJB provider, model, session, native `/goal`, memory, or permission settings. Ultragoal's durable files are the workflow source of truth.
- While a run is active, avoid user questions for resolvable blockers. Ask only for a genuinely human-only dependency after recording it durably.

## Durable artifacts

Create under the state root:

- `brief.md` — approved input and global constraints;
- `goals.json` — canonical goal identity, order, objective, acceptance criteria, dependency, and status;
- `ledger.jsonl` — append-only event and evidence stream;
- `quality-gate.json` — latest final verification and review summary.

Use this minimum `goals.json` shape:

```json
{
  "schemaVersion": 1,
  "runId": "...",
  "status": "active",
  "briefPath": "brief.md",
  "goals": [
    {
      "id": "G001",
      "title": "...",
      "objective": "...",
      "acceptanceCriteria": ["..."],
      "dependencies": [],
      "status": "pending",
      "evidence": []
    }
  ],
  "updatedAt": "ISO-8601"
}
```

Allowed goal statuses are `pending`, `active`, `blocked`, `failed`, `superseded`, and `complete`. Every status transition must append a ledger event with timestamp, goal id, evidence, and concise rationale. Never delete ledger history or mark work complete from `goals.json` alone.

Obey the current permission mode. If it forbids workflow writes or implementation, stop and report the exact limitation; this skill does not override it.

## Create goals

1. Read the approved plan/spec and inspect the current repository state and diff.
2. Preserve shared constraints in `brief.md`.
3. Split independent outcomes with `@goal:` blocks when the input already uses them; otherwise derive the smallest verifiable goals.
4. Assign `G001`, `G002`, and so on in dependency order.
5. Merge stories that share the same implementation, acceptance, red-team, or final review boundary. Use delegated slices inside one goal instead of creating artificially thin goals.
6. Persist `goals.json` and append a `run_created` ledger event before product mutation.

Do not create placeholder goals. Each goal needs a concrete objective and at least one testable acceptance criterion.

## Execute goals

Process dependency-ready goals sequentially unless the approved plan proves disjoint files and independent verification.

For each goal:

1. Set it to `active` and append `goal_started`.
2. Re-read its objective, acceptance criteria, relevant prior evidence, current diff, and user-owned changes.
3. Implement only the current goal. Use the leanest sufficient existing platform or dependency.
4. Delegate bounded implementation to executor subagents when any condition holds:
   - three or more files or two separable surfaces;
   - roughly 200 or more net implementation lines;
   - independent slices can proceed without shared-file contention;
   - two inline edit passes have not completed the goal.
5. Give each worker explicit target files, acceptance criteria, independence assumptions, conflict rules, and required evidence. Workers must not edit Ultragoal state or decide completion.
6. Integrate worker output in the main agent, preserve unrelated edits, and resolve conflicts.
7. Run targeted verification, then inspect the diff for duplication, dead code, needless abstraction, unsafe fallback behavior, boundary violations, missing tests, and user-visible regressions.
8. Re-run verification after cleanup.
9. For nontrivial work, run independent architecture/product/code review and adversarial QA lanes on the same frozen change set. These lanes may run concurrently only if neither changes code and both review identical evidence.
10. Fix every blocking finding and repeat the full relevant gate. Do not paper over plan/code mismatches.
11. Append a `goal_checkpointed` event with real commands, outputs or artifact paths, reviewer verdicts, and remaining advisories.
12. Set the goal `complete` only when all criteria are proven and no blocker remains.

Use live evidence appropriate to the shipped surface: CLI invocation for CLI behavior, API/consumer tests for packages, browser or app automation for GUI, and property/boundary cases for algorithms. A prose claim alone is not verification.

## Blockers and steering

Classify blockers before stopping:

- `resolvable` — failures, missing implementation, investigation, or inferable ambiguity. Continue autonomously, add a bounded investigation goal if useful, or checkpoint failure and schedule the next safe goal.
- `human_blocked` — only the user can supply credentials, access, a physical action, external approval, or a non-inferable product decision. Append `blocker_classified`, set the goal `blocked`, then request the minimum necessary input.

When evidence changes the decomposition without changing the approved aggregate objective, append a steering event before updating `goals.json`. Allowed steering is adding a subgoal, splitting a pending goal, reordering pending goals, clarifying pending wording, annotating evidence, or superseding obsolete blocked work. Never weaken acceptance criteria, delete history, or silently change the aggregate objective.

## Completion gate

After all required goals are complete:

1. Verify `goals.json` contains no pending, active, failed, or unsuperseded blocked goal.
2. Run the aggregate test/build/type/lint checks appropriate to the repository.
3. Review the entire scoped diff against the approved brief and acceptance criteria.
4. Write `quality-gate.json` with commands, exit results, tested surfaces, adversarial cases, review verdicts, artifact references, and an empty blockers list.
5. Append `run_completed` referencing the fresh quality gate, then set the run status to `complete`.

If any final check fails, append `run_completion_rejected`, create or reactivate blocker work, and continue. Never claim completion because the token budget, time window, or conversation turn is ending.

## Resume and recovery

On reinvocation, read `goals.json` and the tail of `ledger.jsonl`. Validate that ledger evidence supports every completed goal. Resume the active goal or first dependency-ready pending goal without recreating ids. If a state file is corrupt, preserve it with a timestamp before repair when permitted; never erase the ledger silently.

## Provenance

This ChatKJB adaptation is based on Gajae-Code's `ultragoal` workflow at commit `7dc297145f333a00b7e913ce7c8cd5dedeb3fd34`, licensed under MIT by Yeachan-Heo and Gajae Code contributors. It preserves the canonical goals plus append-only evidence design while replacing `gjc ultragoal`, `.gjc`, and inline goal-tool coupling with ChatKJB project state and provider-native execution.
