---
name: deep-interview
description: Clarify vague or high-risk requests through a one-question-at-a-time Socratic interview, explicit ambiguity scoring, a durable specification, and a separate execution approval gate. Use for /deepinterview, "deep interview", "interview me", "do not assume", unclear scope or acceptance criteria, or when premature implementation would risk building the wrong thing.
---

# Deep Interview

Turn an ambiguous request into an approved, testable specification. Do not implement product changes while this workflow is active.

## ChatKJB contract

- Preserve the user's language and requested formality.
- Use the exact `State root` supplied by ChatKJB. If direct invocation supplies none, use `.chatkjb/workflows/deep-interview-<timestamp>-<slug>`.
- Treat the project-local workflow directory as state only. Do not edit product files, run mutation-oriented commands, commit, push, or start an execution workflow during the interview.
- Obey the current permission mode. If it forbids state-file writes, keep the same state in the conversation and disclose that durable resume is unavailable.
- Use ChatKJB's existing selection UI protocol for every option-bearing question. Ask exactly one substantive question per turn even though the transport can carry more.
- Inspect code, configuration, tests, and prior workflow artifacts before asking the user for repository facts. Ask the user only for decisions, preferences, scope, and tradeoffs.
- Do not change ChatKJB provider, model, session, goal, memory, or permission settings.

## Resolve interview mode

Parse an optional mode flag from the request and announce the result before the first question:

| Mode | Ambiguity threshold |
| --- | ---: |
| `--quick` | 0.60 |
| `--standard` | 0.50 |
| `--deep` | 0.35 |
| no flag | 0.05 |

Print `Deep Interview threshold: <percent>% (source: <mode or default>)` exactly once. Store the numeric threshold and source in state.

## Initialize durable state

Create `state.json` only after resolving the threshold. Preserve existing valid state for resume. Use this minimum shape and extend it only when needed:

```json
{
  "schemaVersion": 1,
  "status": "interviewing",
  "initialIdea": "...",
  "projectType": "greenfield",
  "threshold": 0.05,
  "thresholdSource": "default",
  "topology": [],
  "rounds": [],
  "establishedFacts": [],
  "currentAmbiguity": 1,
  "restatedGoal": null,
  "specPath": null,
  "updatedAt": "ISO-8601"
}
```

For brownfield work, record cited paths and symbols under `codebaseContext`. Never store secrets, raw oversized logs, or hidden reasoning. Summarize oversized input before persisting it.

## Run the interview

1. Determine greenfield versus brownfield from the request and repository.
2. Enumerate one to six top-level outcomes that can succeed or fail independently.
3. Ask a Round 0 topology question: confirm, add/remove/merge, or defer components. Do not score ambiguity before topology is confirmed.
4. After each answer, update confirmed facts and score every active component on:
   - goal clarity;
   - constraint and non-goal clarity;
   - testable success criteria;
   - brownfield context clarity.
5. Use these formulas:
   - Greenfield: `1 - (goal*0.40 + constraints*0.30 + criteria*0.30)`.
   - Brownfield: `1 - (goal*0.35 + constraints*0.25 + criteria*0.25 + context*0.15)`.
   - Use the weakest or coverage-weighted minimum component score so one detailed component cannot hide unclear siblings.
6. Report the updated scores, ambiguity, remaining gap, and next component/dimension target concisely.
7. Ask the next question at the weakest component/dimension pair. Rotate tied weak components.

Treat ambiguity as bidirectional. Contradictions, evasive answers, internal inconsistency, or scope expansion may lower a dimension score and raise ambiguity. Preserve contradicted facts as disputed and record the superseding decision instead of deleting history.

Structure reasoning-rich free-text answers into Decision, Reasoning, Constraints, Non-goals, and Verified codebase context. Ask the user to confirm that interpretation before scoring it. Skip this extra confirmation for short unambiguous answers.

After ten rounds, offer continue, crystallize with known gaps, or stop. Stop immediately on cancel. Early crystallization above threshold must list unresolved gaps and obtain explicit confirmation.

## Close and crystallize

When the score reaches the threshold, perform two gates:

1. Audit every active topology component for a clear goal, boundaries, acceptance criteria, and no unresolved contradiction. If math says ready but a material gap remains, say so and continue interviewing.
2. Restate the complete goal in one sentence and ask whether that sentence would lead another implementer to the same outcome.

After confirmation, write `spec.md` under the state root with:

- metadata, threshold, rounds, status, and final ambiguity;
- confirmed topology and explicit deferrals;
- one-sentence goal;
- requirements, constraints, non-goals, and assumptions;
- testable acceptance criteria;
- brownfield technical context with cited paths and symbols;
- established and superseded facts;
- concise Q&A transcript and unresolved risks.

Set `state.json.status` to `pending_approval` and `specPath` to the created file. Do not claim execution approval.

## Handoff gate

Present one structured choice:

- `Ralplan 검토 (권장)` — load the shared `ralplan` skill with `spec.md`; refine the plan and stop at a separate execution approval.
- `Ultragoal 실행` — only for a small, implementation-ready spec; load `ultragoal` with the spec path.
- `인터뷰 계속` — return to the weakest unresolved dimension.
- `여기서 중지` — preserve the pending specification without implementation.

Only load the selected downstream skill after the user's answer. A request mentioning “implementation” or “implementation plan” describes the eventual target; it is not permission to implement during deep-interview.

## Resume

On reinvocation, read `state.json` and `spec.md` if present. Summarize the last confirmed decision, current ambiguity, and next gap, then continue without re-asking settled questions. If state is corrupt, preserve it as `state.corrupt.<timestamp>.json` when allowed and start a new state file; never silently discard it.

## Provenance

This ChatKJB adaptation is based on Gajae-Code's `deep-interview` workflow at commit `7dc297145f333a00b7e913ce7c8cd5dedeb3fd34`, licensed under MIT by Yeachan-Heo and Gajae Code contributors. It replaces Gajae-specific `gjc state`, `.gjc`, and `ask` surfaces with ChatKJB's shared-skill, project-state, and Telegram selection protocols.
