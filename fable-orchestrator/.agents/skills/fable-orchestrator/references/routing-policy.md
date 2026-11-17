# Routing policy

Routing is computed by `fo plan` from each contract. The rules are transparent heuristics. Nothing here is a measured success probability, and `fo` never prints one.

## Scoring complexity

Score each factor from 0 (none) to 3 (severe) in the contract's `complexity_factors`:

| Factor | Question |
|---|---|
| `components` | How many components does the change touch? |
| `architecture` | Does it change structure, interfaces or data flow? |
| `ambiguity` | How much of the requirement is open to interpretation? |
| `dependencies` | How tangled are the things it depends on? |
| `uncertainty` | Are there technical unknowns? |
| `regression_risk` | How easily could it break existing behaviour? |
| `security` | Does it touch a trust boundary, secrets, auth or user data? (2 or 3 marks the task security-sensitive) |
| `debugging` | How hard will failures be to diagnose? |

`score = clamp(1 + round(sum * 9 / 24), 1, 10)`. You may give `complexity_score` directly instead; when both are present the stated score is used and `fo` warns if it differs from the derived one by more than 2.

## From score to assignment

| Score | Tier | Agent | Model | Effort |
|---|---|---|---|---|
| 1-2 | light | the task's role (default implementation-worker) | haiku | default |
| 3-4 | standard | the task's role | sonnet | medium |
| 5-6 | capable | the task's role | sonnet | high |
| 7-8 | lead | opus-executor | opus | high |
| 9-10 | lead_oversight | opus-executor, with every review question answered by the orchestrator | opus | xhigh |

Models and effort per tier are configuration (`routing.tiers`). The aliases resolve to whatever the installed Claude Code maps them to.

Adjustments, applied in this order and listed in the plan output whenever they fire:

1. `risk_level: high` raises the tier by one.
2. `security_sensitive` sets a floor of capable, and of lead when the score is 5 or more.
3. `routing.prefer_lower_cost_models: false` sets a floor of standard.
4. Role floors: review-worker, debug-worker and integration-worker start at standard; opus-executor at lead.
5. Observed outcomes (below).
6. `preferred_model` is a floor. A stronger model than the tier asks for is honoured; a weaker one is overridden and the plan says so.

A role other than implementation-worker keeps its role at lead tiers and simply runs on the lead model.

## Why not always the cheapest model

A cheap worker that needs two corrections costs more than a capable one that passes first time, once the corrections, re-verification and review are counted. The table encodes that judgement as bands. `routing.cost_weights` holds relative cost units per model (seeded from list input prices cached on 2026-11-03: haiku 0.1, sonnet 2, opus 4, fable 8); they are used only to compare tiers once real outcome data exists.

## Observed outcomes

When a task finishes, `fo` records under `.claude/fable-orchestrator/learning/routing-stats.json`, keyed by the tier it was first routed to and its complexity band: tasks, completions, first-pass completions, dispatches, corrections, escalations.

Routing consults that data only when the tier has at least `routing.min_samples` tasks (default 5) for the band:

- first-pass rate below `routing.min_first_pass_rate` (default 0.5): route one tier up. The plan states the observed counts.
- otherwise, if the next tier also has enough samples, compare `cost weight x dispatches per completed task` and take the cheaper.

With fewer samples the heuristics stand alone, and the plan labels the basis (`heuristic`, `heuristic+observed`, `observed`).

## Escalation

Escalation changes something on record: the model, the decomposition, the context, or the strategy. Repeating the same attempt is not an escalation and `fo` refuses it.

```text
light -> standard -> capable -> lead -> lead_oversight -> orchestrator implements directly -> user
```

- Inside a correction: `strategy_change: {kind: model, detail: ...}` moves one tier up (or to a named model). Required in some form from the second correction round.
- For a blocked or failed task: `fo escalate <ID> --kind model|decomposition|context|strategy --reason "..."`, optionally `--model` or `--role`.
- A tier and model pair that was already tried is rejected (`NO_MEANINGFUL_CHANGE`).
- At the top of the ladder `fo` says so. The remaining options are the orchestrator implementing the task itself (`--role orchestrator`, always followed by an independent review) or asking the user.
- A new strategy gets its own retry allowance; correction rounds are never reset.

## Review requirements by mode

| Mode | Independent review-worker approvals required |
|---|---|
| fast | 1 when high-risk or security-sensitive, else 0 |
| balanced | 1 when high-risk, security-sensitive or score 7+, else 0 |
| thorough | 1 when score 5+ or risk above low, else 0 |
| maximum | 1 for every change; 2 with distinct perspectives (correctness, security) when high-risk or security-sensitive |

The orchestrator's own review is required in every mode. Work the orchestrator implemented itself always needs one independent approval. Read-only tasks need none.
