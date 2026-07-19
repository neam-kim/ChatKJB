---
name: ralplan
description: Produce a consensus implementation plan through planner, architect, and critic passes, reconcile assumptions with the user, persist review evidence, and stop at an explicit execution approval gate. Use for /ralplan, "랄플랜", consensus planning, architecture-heavy work, reviewed plans, or when deep-interview hands off a specification.
---

# Ralplan

Create an implementation-ready plan through an adversarial review loop. Remain planning-only until the user explicitly approves a downstream execution workflow.

## ChatKJB contract

- Use the exact `State root` supplied by ChatKJB. If absent, use `.chatkjb/workflows/ralplan-<timestamp>-<slug>`.
- Preserve the user's language and requested formality.
- Inspect the repository and relevant prior `.chatkjb/workflows/` specifications before planning.
- Do not edit product files, run mutation-oriented commands, commit, push, open external changes, or invoke implementation workers before approval.
- Use ChatKJB's selection UI protocol for user decisions. Ask one unresolved decision at a time during reconciliation.
- Use no more than three concurrent subagents, never allow recursive fan-out, and keep external MCP work with the main agent.
- Do not change ChatKJB provider, model, session, goal, memory, or permission settings.

## Inputs and modes

Accept a task description or a `deep-interview` `spec.md` path. Treat the user's explicit `/ralplan` invocation as approval to plan, never as approval to implement.

Enable deliberate mode when `--deliberate` is present or when work includes authentication, security, migration, destructive operations, incident response, compliance, personal data, or public API breakage. Deliberate mode must add a three-scenario pre-mortem and expanded unit, integration, end-to-end, rollback, and observability verification.

If the request is too vague to define acceptance criteria or system boundaries, hand off to `deep-interview` and stop. Do not manufacture a plan from missing intent.

## Persist the run

Create the state root and keep:

- `run.json` — run id, input, mode, iteration, status, current plan path, review verdicts, timestamps;
- `index.jsonl` — append-only artifact receipts with stage, iteration, path, and SHA-256 when available;
- `stage-<NN>-planner.md`, `stage-<NN>-architect.md`, `stage-<NN>-critic.md`, and revision artifacts;
- `pending-approval.md` — the final consensus plan.

Do not store secrets or hidden reasoning. Store decisions, evidence, tradeoffs, verdicts, and concise rationale only. Obey permission mode if it forbids artifact writes and disclose the resulting lack of durable resume.

## Consensus loop

1. Inspect relevant code, tests, configuration, docs, git diff, and prior specs. Preserve existing user changes.
2. Run one planner pass. Prefer a bounded read-only planner subagent when available; otherwise make an explicitly labeled main-agent planner pass.
3. Persist an initial plan containing:
   - objective and non-goals;
   - three to five principles;
   - top three decision drivers;
   - at least two viable options with bounded pros and cons, or explicit reasons alternatives are invalid;
   - chosen approach, ordered steps, affected surfaces, dependencies, risks, rollback, acceptance criteria, and verification.
4. Freeze that planner artifact for the current iteration.
5. Review the same frozen artifact through two independent lanes:
   - Architect: boundaries, data/control flow, operational risk, compatibility, and tradeoffs. Return `CLEAR`, `WATCH`, or `BLOCK`, plus `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`.
   - Critic: intent coverage, option consistency, missing scope, actionability, acceptance criteria, and test quality. Return `OKAY`, `ITERATE`, or `REJECT`.
6. Architect and Critic may run concurrently only when both read the same planner artifact and Critic does not depend on Architect output. Otherwise run them sequentially.
7. Join both verdicts. Finalize only when Architect is `CLEAR` and `APPROVE`, and Critic is `OKAY`, for the same plan iteration.
8. On any other verdict, consolidate concrete feedback, revise the plan, persist a new iteration, and re-run both reviews. Stop after five review iterations and present the best version with unresolved review blockers.

The main agent owns artifact integration and verification. Subagents return evidence and may not edit product files or workflow state directly.

## Intent reconciliation

After clean review, compare the plan against the user request, deep-interview spec, and relevant prior plan artifacts. Collect:

- assumptions made without user confirmation;
- scope expansions or weakened constraints;
- conflicts with prior decisions or non-goals;
- user choices that materially change architecture, risk, or acceptance criteria.

If any exist, ask the highest-impact item through ChatKJB's selection UI, one at a time. Feed corrections back into a planner revision and re-run both review lanes. Do not ask the user for repository facts already discoverable from code.

## Final plan

Write `pending-approval.md` only after the review join and reconciliation gates. Include:

- status `pending approval`;
- objective, scope, non-goals, and acceptance criteria;
- repository evidence and affected files/surfaces;
- selected approach and ordered implementation steps;
- decision record: decision, drivers, alternatives, why chosen, consequences, and follow-ups;
- risks, rollback, migration, observability, and test plan as applicable;
- Architect and Critic verdicts with artifact receipts;
- intent reconciliation decisions and unresolved blockers.

Update `run.json.status` to `pending_approval`. Planning completion is not implementation completion.

## Approval gate

Always present a structured final choice:

- `Ultragoal로 실행 (권장)` — load the shared `ultragoal` skill with `pending-approval.md`.
- `계획 수정` — return feedback to the consensus loop.
- `여기서 중지` — preserve the plan as pending approval.

Only load `ultragoal` after the user explicitly chooses execution. Do not implement directly from Ralplan.

## Resume and recovery

On reinvocation, read `run.json`, `index.jsonl`, and the latest stage artifacts. Resume the incomplete iteration and do not redo clean completed stages. If state is corrupt, preserve the bad file with a timestamp before reseeding when writes are allowed.

## Provenance

This ChatKJB adaptation is based on Gajae-Code's `ralplan` workflow at commit `7dc297145f333a00b7e913ce7c8cd5dedeb3fd34`, licensed under MIT by Yeachan-Heo and Gajae Code contributors. It replaces Gajae-specific role receipts and `gjc ralplan` state commands with provider-native subagents, project-local receipts, and ChatKJB approval UI.
