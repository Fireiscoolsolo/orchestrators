# Changelog

Improvement proposals that you approve and apply add their own entries below, with the change, the rationale, the evidence and the rollback command.

## 2.0.0 - 2026-11-16

First release of the skill.

Added

- The `opus-orchestrator` skill (`SKILL.md`): invoked as `/opus-orchestrator` with the options `--mode fast|balanced|thorough|maximum`, `--max-workers`, `--review-rounds`, `--plan-only`, `--resume` and `--status`. Frontmatter `model: opus`, `effort: xhigh`, `disable-model-invocation: true`, and `PreCompact` and `SessionStart` (matcher `compact`) hooks.
- The `oo` command line (`scripts/oo.cjs`): the task state machine of fourteen states with guards, specification validation and complexity scoring, routing, dependency-aware scheduling, verification runs with scope checks, independent review and the orchestrator's quality gate, correction and escalation with bounds, integration, delivery, final report, budgets, usage, checkpoints and resume.
- Worker agents in `agents/`: `opus-researcher`, `opus-implementer`, `opus-tester`, `opus-reviewer`, `opus-debugger` (default model haiku), and `scripts/install.cjs` to install the skill and the agents at project or user level.
- Workspace strategies: worktree (integration branch, per-worker worktrees, fast-forward delivery, non-forcing cleanup) and shared (file snapshots), chosen at `oo init`.
- Configuration in `config/` (execution, models, routing, budgets, verification, compaction) with `scripts/validate_config.cjs`; project overrides in `.claude/opus-orchestrator/config.yaml`.
- Safety: a command guard (not a sandbox), protected paths, secret redaction of recorded text, destructive git refused, `side_effects: external` tasks held for the user's authorization and never retried automatically.
- Hooks `scripts/hooks/pre_compact.cjs` and `scripts/hooks/session_start.cjs`, and the optional status-line bridge `scripts/hooks/statusline_bridge.cjs`.
- Improvement proposals: observations, rule-based proposals from evidence, approval by the user only, application limited to one key in `config/` with backup, `VERSION` bump, changelog entry and rollback.
- Reports and templates (`templates/`), `scripts/manage_state.cjs`, `scripts/schedule_tasks.cjs`, `scripts/verify_results.cjs`.
- Tests and demonstration: 439 automated tests (`scripts/run_tests.cjs`), the simulated-agent demonstration `scripts/demo.cjs` (shared and `--git`), and the recorded live Claude Code run in `validation/live/`.
- Documentation: `README.md` and `references/` (architecture, routing, execution, verification and recovery policies, capability audit).

Changed during the 2.0.0 hardening, after the live run

- Unknown backslash escapes in double-quoted YAML strings are kept literally instead of being refused.
- Worker and reviewer packages ask for single-quoted strings and forward slashes. An unparsable report is refused with the line number and an instruction to resend it.
- A correction request can carry `verification_commands`, which `oo verify` runs in that round.
- Reported absolute paths are made project-relative.
- The worktree of a task the orchestrator implements itself is under `.opus-inbox/worktrees/`.
- In a mode with `final_audit: true`, `oo deliver` runs `verification.regression_command` first when one is configured.
- Approval of a high-risk task needs `reviewers_high_risk` approving independent reviews (two in `maximum`).
- `oo learn` does not duplicate observations; `oo context --utilization` records the source `user`.
- `oo authorize` refuses a value that is not higher than the current limit, and a limit that has no value.

Known limitations at this release

- Only one live Claude Code run was made. The worktree strategy with real agents, a real independent reviewer, the hooks on a real compaction, the status-line bridge and resume across sessions were not tested live. See "Verification status" in `README.md`.
- The final audit runs while `oo` holds the state lock; `oo next` still prints the worker model for a task the orchestrator does itself.
- `verification.regression_command` is unset by default, so the regression runs and the final audit need it configured.
- `scripts/schedule_tasks.cjs` does not accept a file that is one YAML list (documents separated by `---` work); `oo plan` accepts both.
- Cost is not measurable in a session; the only cost figures are the measured ones of the live run.
