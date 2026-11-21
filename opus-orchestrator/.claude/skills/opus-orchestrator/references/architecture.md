# Architecture

The skill is split between a model that decides and a command line that enforces. The model (the Opus session that was invoked with `/opus-orchestrator`) reads the request, writes task specifications, launches worker subagents and judges evidence. The command line, `oo` (`scripts/oo.cjs`), is the only thing that changes run state. It refuses any step that would break an invariant (exit 1, with the cause and a NEXT line) and rejects bad usage (exit 2).

## Parts

| Part | Where | Job |
|---|---|---|
| Orchestrator instructions | `SKILL.md` | The loop the model follows: start, intake, specify, plan, execute, finish. Frontmatter: `model: opus`, `effort: xhigh`, `disable-model-invocation: true`, and the `PreCompact` and `SessionStart` (matcher `compact`) hooks. |
| `oo` command line | `scripts/oo.cjs` | One command per step of the loop (`oo help` lists them). Takes the state lock, loads the run, applies the change through the state machine, saves, appends to `events.jsonl` and rewrites `checkpoint.yaml`. |
| State machine | `scripts/lib/statemachine.cjs` | The fourteen task states, the allowed transitions and the guards. Pure: no I/O. |
| Specifications | `scripts/lib/spec.cjs` | Validates a task specification, scores complexity, checks the plan (duplicates, unknown dependencies, cycles, overlapping scopes). |
| Routing | `scripts/lib/routing.cjs` | Chooses role, agent, model and verification layers; gives escalation advice. |
| Scheduler | `scripts/lib/scheduler.cjs` | Dependency-aware batch selection and the wave preview. |
| Reports | `scripts/lib/reports.cjs`, `scripts/lib/yaml.cjs` | Parses and validates worker results, reviews and correction requests, in the documented YAML subset. |
| Verification | `scripts/lib/verify.cjs`, `scripts/lib/workspace.cjs`, `scripts/lib/security.cjs` | Runs commands in a shell, checks scope, decides the verdict, guards commands, redacts secrets. |
| Git | `scripts/lib/gitops.cjs` | Non-destructive git helpers (forbidden operations are refused before anything runs) and the shared-workspace snapshots. |
| Budget, checkpoint, improvement | `scripts/lib/budget.cjs`, `scripts/lib/checkpoint.cjs`, `scripts/lib/improve.cjs` | Usage and limits, the resume summary and context advice, observations and proposals. |
| Store | `scripts/lib/store.cjs` | Atomic JSON files with `.bak` copies, the state lock, event log, integrity check. |
| Packages | `scripts/lib/packages.cjs` | Builds the worker and reviewer packages (task, scope, criteria, constraints, report format). |
| Worker agents | `agents/` | `opus-researcher`, `opus-implementer`, `opus-tester`, `opus-reviewer`, `opus-debugger`; all `model: haiku` by default. They must be installed in `.claude/agents/` or `~/.claude/agents/` (see `scripts/install.cjs`). |
| Hooks | `scripts/hooks/` | `pre_compact.cjs`, `session_start.cjs`, and the optional `statusline_bridge.cjs`. |
| Configuration | `config/*.yaml` | Defaults; a project overrides them in `.claude/opus-orchestrator/config.yaml`. |

Scripts are Node (`.cjs`, no dependencies) because Python is not installed on the build machine.

## Why a command line

Markdown instructions alone cannot schedule, monitor or persist anything. Every property the skill promises is therefore either enforced in code or labelled as the orchestrator's judgement:

- Enforced by `oo`: legal state transitions; no approval without a passed verification in the current round; the number of independent reviews; correction and retry limits; the agent-call, token and cost limits (the last two only once a measured figure is recorded); no retry of a task with external side effects; authorization of limit raises and of external side effects only `--by user`; scope checks; command safety; secret redaction of recorded text; atomic state.
- The orchestrator's judgement, recorded but not computed: the specifications, the complexity factors, whether each acceptance criterion is met (it must cite evidence), the diagnosis behind a correction or an escalation.

`oo` cannot launch an agent. It prints the `Agent call:` lines and prompts; the orchestrator issues them and reports back with `oo started` and `oo result`. If the orchestrator skips a step, `oo` refuses the next one that depends on it.

## One command's life

Every state-changing command: acquire the lock (`.claude/opus-orchestrator/.lock`; a lock older than 30 seconds or held by a dead process is treated as stale) -> load `run.json` and the task files -> change tasks through `statemachine.transition` (an illegal move is refused with its code, for example `INVALID_TRANSITION`) -> save changed tasks and the run -> append events -> rewrite `checkpoint.yaml` -> release the lock. Commands that run verification or integration commands release the lock while the commands run and take it again to record the result, and discard the result if the task moved meanwhile. `oo deliver` is different: its final audit runs while the lock is held.

## State layout

All state is under `.claude/opus-orchestrator/` of the project (override with `OPUS_ORCH_STATE_DIR`); the directory carries a `.gitignore` that ignores everything. The tree is in the README. Properties:

- JSON files are written atomically (temporary file, fsync, `.bak` copy of the previous version, rename). `oo resume` restores an unreadable file from its `.bak` and reports `INTEGRITY: restored`; a file with no usable backup gives `INTEGRITY: PROBLEMS` and exit 1.
- `events.jsonl` is append-only.
- `checkpoint.yaml` is a resume summary rebuilt after every change: objective, decisions, task statuses, next actions.
- Worker output and review reports are stored after secret redaction.
- The inbox `.opus-inbox/` (git-ignored) is where the orchestrator drafts specifications and corrections, because Claude Code's file tools cannot write below `.claude`.

## Task record

A task record holds the specification fields, the routing decision, `status`, counters (`attempts`, `retries`, `review_round`), `history` (every transition with time, reason and actor), `result` (the accepted worker report), `evidence` (`self_check`, `verification`, `reviews`, `review_packages`, `checks`, `integration` for the current round, and `rounds` for archived earlier rounds), `correction` and `corrections`, `failure` and `block` with their kinds, and `escalations`. When a correction, escalation, unblock or reopen starts a new round, the current round's evidence is archived into `evidence.rounds`, so a guard only ever sees evidence from the current round.

## Roles and agents

Ten logical roles map to five agents in `config/routing.yaml`:

| Role | Agent | Writes |
|---|---|---|
| research-worker, repository-worker | opus-researcher | no |
| implementation-worker, documentation-worker, integration-worker | opus-implementer | yes |
| test-worker, verification-worker | opus-tester | yes |
| review-worker, security-worker | opus-reviewer | no |
| debug-worker | opus-debugger | yes |

`orchestrator` is a further role that is not in the table: a task assigned to it is done by the orchestrator itself (`DO YOURSELF`) and always needs an independent review. Workers do not delegate further: none of the agent definitions lists a tool for launching subagents.

## Improvement proposals

The skill learns only through proposals that a person approves; it never edits its own instructions.

1. **Observe.** During a run the orchestrator may record patterns with `oo observe --category <c> --text "..."`; categories are `worker_outcome`, `routing`, `verification_failure`, `debugging_pattern`, `context_duplication`, `unnecessary_call`, `integration_conflict`, `retry_effectiveness`, `user_correction`. Observations go to `.claude/opus-orchestrator/observations.jsonl`.
2. **Learn.** `oo learn`, once at the end of a run, derives observations from the run's task records (worker outcome per task with model, complexity band, attempts and first-pass; verification and integration failures; retry effectiveness) and adds the ones not already on record for that run, category, task and text. When `improvement.collect_observations` is false it collects nothing from the run (proposals are still generated from observations already on record). When the rules count observations, those of the same category, run and task count once.
3. **Propose.** Two rules exist. Routing: for a model and complexity band with at least `improvement.min_samples` (default 5) observations and a first-pass rate below one half, it proposes raising `routing.heuristic_expected_attempts.<model>.<band>` to the observed mean attempts (a `config_set`), or, when the observed mean does not exceed the configured value, a manual proposal to review the routing. Retries: with at least that many retried tasks of which fewer than half recovered, a manual proposal to review `execution.max_retries` and the escalation path. With too little evidence nothing is proposed. A proposal identical in category, target and key to an open one is not generated again. Proposals are YAML files in `.claude/opus-orchestrator/proposals/` with ids like `IMP-20261116-001` (see `templates/improvement-proposal.yaml`).
4. **Review.** `oo proposals list`, `oo proposals show <ID>`. Statuses: `proposed`, `approved`, `rejected`, `applied`, `rolled_back`.
5. **Approve.** `oo proposals approve <ID> --by user`; only the user's approval counts, and the orchestrator records it only after the user said yes. `oo proposals reject <ID>` declines.
6. **Apply.** `oo proposals apply <ID>` can apply only a `config_set` proposal that is approved by the user, and only to one key of one file under `config/`. It backs the file up to `history/<old version>/config/<file>`, rewrites the file, raises the patch number in `VERSION` and appends to `CHANGELOG.md` with the rationale, evidence and the rollback command. If anything fails midway it restores the file, `VERSION` and `CHANGELOG.md`.
7. **Roll back.** `oo proposals rollback <ID>` restores the backed-up file byte for byte.

Never applied by the tool, always "must be changed by a person": any `manual` proposal; anything outside `config/`; security settings; `improvement.auto_modify_core_skill`; `execution.independent_verification`; any `verification.*` key except lowering an independent-review `min_complexity` (a raise is refused); `execution.max_review_rounds` and `execution.max_retries` above 10. `SKILL.md`, the agents and these references are never edited by the tool. Because `config/` is rewritten by the YAML serializer, comments in the previous version survive only in the backup. A change applies to runs started afterwards, because each run keeps the configuration it began with.

## Where the skill meets Claude Code

See `capability-audit.md` for each Claude Code capability the design depends on, its class and its source. In short: the skill frontmatter, the Agent tool with background parallel subagents, `isolation: worktree`, the `PreCompact` and `SessionStart` hooks and the status line are native; scheduling, state, checkpoints, resume, routing and verification are implemented by `oo`; reading context utilization, starting a compaction and reading dollar cost in-session are not possible and have fallbacks.
