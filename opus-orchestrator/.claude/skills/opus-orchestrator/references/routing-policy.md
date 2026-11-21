# Routing policy

Routing decides, for each task at `oo plan` (and again at `oo amend` and `oo escalate`), which role does the work, which agent and model run it, and which verification layers apply. The decision is saved in the task record (`routing`) with the reasons that produced it; `oo plan` prints them. The code is `scripts/lib/routing.cjs`; its inputs are the specification and `config/models.yaml`, `config/routing.yaml`, `config/verification.yaml`.

The routing weights in the configuration are unitless planning numbers and stated guesses. None of them is a price, a measured success rate or a promise of savings; `oo` never shows them as money.

## 1. Complexity and risk

A specification carries `complexity` (integer 1-10), or `complexity_factors`, eight integers 0-3: `technical_difficulty`, `components`, `architectural_impact`, `ambiguity`, `security_sensitivity`, `dependency_complexity`, `regression_risk`, `debugging_difficulty`. From factors, `oo` computes `clamp(1, 10, round(1 + 9 * sum / 24))` (missing factors count as 0). If both are given, the explicit `complexity` is used and a warning notes a difference. Either one is required.

Tier by complexity band: 1-2 `direct`, 3-4 `targeted`, 5-6 `reviewed`, 7-8 `oversight`, 9-10 `opus_led`. The tier is a label printed with the plan; the rules below act on the numbers.

`risk` (`low`, `medium`, `high`) can be set in the specification. When it is not, it is `high` for complexity 8 or more or a `security_sensitive` task, `medium` for complexity 5 to 7, and `low` below 5.

## 2. Role

`assigned_role` if it is not `auto`; otherwise the role of the task's `kind`:

| kind | role | agent | writes |
|---|---|---|---|
| implementation | implementation-worker | opus-implementer | yes |
| documentation | documentation-worker | opus-implementer | yes |
| integration | integration-worker | opus-implementer | yes |
| test | test-worker | opus-tester | yes |
| verification | verification-worker | opus-tester | yes |
| debug | debug-worker | opus-debugger | yes |
| research | research-worker | opus-researcher | no |
| repository | repository-worker | opus-researcher | no |
| review | review-worker | opus-reviewer | no |
| security | security-worker | opus-reviewer | no |

The role `orchestrator` (`assigned_role: orchestrator`, or `oo escalate --role orchestrator`) means the orchestrator does the task itself. A writing role needs at least one `authorized_files` entry; a non-writing role may have none. The brief injected into each worker's package is `routing.roles.<role>.brief`.

## 3. Model

1. **Floors.** The model can never be below the highest of:
   - an explicit `assigned_model` other than `auto` (it is a floor, not a fixed choice);
   - `opus` when complexity is 9 or more;
   - `opus` when the task is high risk and either `security_sensitive` is true or complexity is 7 or more;
   - `opus` when `complexity_factors.architectural_impact` is 3;
   - `models.worker_default` (default `haiku`). With `routing.prefer_haiku: false` the default floor is the cheapest allowed model that is not haiku.
2. **Candidates.** Allowed models (`models.allowed`, ordered haiku, sonnet, opus) at or above the floor. With `routing.allow_opus_escalation: false`, opus is removed unless the floor itself is opus.
3. **Choice.** With `routing.adaptive: false`, the floor. Otherwise the candidate with the lowest expected cost: `models.relative_cost[model] * expected attempts`. Expected attempts come from observed outcomes when at least `routing.min_observations` (5) tasks were observed for that model and complexity band (the mean attempts), otherwise from `routing.heuristic_expected_attempts`. A tie keeps the lower model.

With the shipped weights (haiku 1, sonnet 3, opus 5, and the heuristic attempts in `config/routing.yaml`) haiku has the lowest expected cost in every band where it is allowed, so the choice is the floor until observations raise haiku's observed attempts. The attempts figures are heuristics, not measurements. Observed statistics are read from `observations.jsonl` (the `worker_outcome` records that `oo learn` writes) at plan time.

The printed reasons name each rule that applied: `explicit_assigned_model`, `complexity_9_10`, `high_risk_sensitive`, `architectural_impact_3`, `default_floor`, `prefer_haiku_false`, `allow_opus_escalation_false`, `adaptive_cost`, `adaptive_false`, `haiku_outcompeted`.

The model is passed on each `Agent call:` line printed by `oo next`. The agent definitions' own `model: haiku` is only their default.

## 4. Verification layers and independent review

Each task gets the layers `self_check` (the worker's report), `automated` (only when it has `verification_commands`), `independent_review` (when required), `opus_gate` and `integration`. Independent review is required when any of these holds:

- the mode's `independent_review.min_complexity` is at most the task's complexity;
- the mode's `independent_review.risks` contains the task's risk;
- `security_sensitive` is true (always);
- the role is `orchestrator` (always).

`execution.independent_verification: false` removes the first two reasons for low-risk tasks. The per-mode numbers are in `verification-policy.md`: balanced reviews complexity 5 or more and high risk; thorough complexity 3 or more and medium or high risk; maximum every task; fast only high risk (its `min_complexity` of 11 can never be reached).

The independent reviewer for a task is routed as a `review` task (role `security-worker` for a security-sensitive task, else `review-worker`; agent `opus-reviewer`) with the worker's model as a floor, so it is at least as strong as the worker.

## 5. Scheduling inputs

`dependencies`, `authorized_files`, `priority` (`low`, `medium`, `high`, `critical`), `exclusive` and `side_effects` are read by the scheduler; see `execution-policy.md`.

## 6. Escalation advice

When a worker fails or a task fails, `oo` prints advice from `escalation()`; it advises and changes nothing.

| Condition | Advice |
|---|---|
| failure `needs_decomposition` | decompose: plan the proposed subtasks |
| failure `permission` or `budget` | ask the user |
| `rate_limit`, `timeout` or `crash`, retries below `max_retries` and fewer than 2 attempts | retry the same model |
| 2 or more attempts and the model is not opus and `allow_opus_escalation` is not false | escalate to `models.escalation` (default opus) |
| 2 or more attempts otherwise | ask the user |
| anything else | targeted correction |

The orchestrator decides. `oo escalate <ID> --model <haiku|sonnet|opus> | --role <role> --reason T` is accepted only for a FAILED or BLOCKED task and only if it changes the strategy: a stronger model (a weaker one is refused) or a different role. Repeating the unchanged strategy is refused, as is a model outside `models.allowed`. The task is re-routed with the new model or role as a floor, the current round's evidence is archived, and the task goes to READY (or PENDING if its dependencies are not completed). Escalation reasons are saved in the task's `escalations`. From the second correction round on, a correction request must also state a `strategy_change`.

## 7. Model substitution

The specification asked for "Opus 5.5 Extra" as orchestrator and "Haiku 5.5" as workers. No model or setting called Opus 5.5 Extra exists in Claude Code's documentation. The configuration only accepts the aliases `haiku`, `sonnet` and `opus` and rejects any other name; the orchestrator is `opus` at effort `xhigh`. See `capability-audit.md` for the sources.
