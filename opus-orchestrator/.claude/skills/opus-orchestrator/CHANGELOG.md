# Changelog

Improvement proposals that you approve and apply add their own entries below, with the change, the rationale, the evidence and the rollback command.

## 1.1.0 - 2026-11-22 - security and correctness repairs after the 1.0.0 audit

Every repair has regression tests that drive the real `oo` command line on temporary git repositories and worktrees (`tests/lock.test.cjs`, `tests/candidate.test.cjs`, `tests/review-fixes.test.cjs` and updated suites); the agents in them are simulated.

Critical

- State lock could be stolen. A lock older than 30 seconds was treated as stale, and every release deleted the lock without checking who held it. Now the lock holds a unique owner token, process id and host, published complete; only its holder releases it; it is taken over only when the owner is proven dead on the same host (never because of age); takeovers go through a guard chain that survives a crashed reaper; every state write first checks that the lock is still held (`LOCK_LOST`). `node manage_state.cjs lock` shows the owner; `lock --break --token T --confirm-owner-stopped` moves a lock aside after a person checked (`--pid-reused` when its process id now belongs to an unrelated program).
- Shared-workspace scope checks approved unauthorized edits: a change outside a task's scope was ignored when it fell inside another task's scope. Authorship is no longer inferred from scopes: a change outside the scope is a violation unless its content is exactly what another task's verified candidate recorded. Writing tasks in a shared workspace now run one at a time (`shared_serial`), because concurrent changes in one directory cannot be attributed. Unrelated edits are left in place; only the evidence is refused.

High

- Shared snapshots were size and modification time, skipped unreadable files and returned nothing for a missing directory. They are now content hashes with an explicit `complete` flag and error list, record symbolic links and junctions without following them, flag names a scope cannot match, include `.git/config` and `.git/hooks`, and an incomplete or old-format snapshot blocks verification. A task keeps the baseline of its first dispatch across retries and correction rounds (`oo rebaseline` resets it, with the user's authorization).
- `git status` failures read as a clean worktree. Status output is parsed strictly; a failed, denied, truncated or malformed status fails the check.
- A missing dispatch snapshot made verification trust the worker's own file list, and an isolated task without a worktree got an empty, passing scope. Missing evidence now blocks the task (`evidence_missing`); a task reporting no change in the worktree strategy is verified against the integration head it was given.
- `oo resume --requeue-running` requeued in-flight tasks on the guess that their agents were gone. Every dispatch now has an attempt id that its report must carry; late, duplicate, abandoned and foreign reports are refused; `--requeue-running` refuses and `oo reconcile <ID> --attempt <AID> --agent-gone --reason T` requeues one attempt explicitly. Interrupted verifications, integrations and deliveries are recorded as operations with an owner and are taken over only when that owner is dead (or with `--takeover <op id>`); results of superseded operations are discarded.
- Verification and delivery were not bound to an immutable candidate. A report no longer establishes worktree ownership: oo checks the worktree (this repository, not the main checkout or integration worktree, not bound to another attempt, not on the base or integration branch) and pins its HEAD commit and tree. Verification runs in a fresh, clean detached checkout of that commit; commands that change sources invalidate the evidence (explicit `verification.generated_artifacts` policy, git-ignored files allowed); `verification.setup_commands` run first and a failure stops the run. Integration merges exactly the verified and approved commit in a clean checkout, runs the checks on that merge commit and only then fast-forwards the integration branch to it (recoverable after a crash between the two). A dirty integration worktree, an unfinished git operation or an integration branch moved by someone else blocks integration. Delivery fast-forwards to exactly the integrated and audited commit and forces nothing. Changed git configuration, hooks or info files since `oo init` stop verification, integration and delivery (`oo repo-guard`).

Medium

- Independent reviews were not bound to a dispatch. Each review package is now a dispatch bound to task, attempt, round, perspective and verified candidate; the report carries its `review_id`; `oo review --agent-id <id>` records the host's agent id, and reviews from the worker's agent or a second report from the same agent are refused; `oo review-abandon` replaces a lost reviewer and refuses its late report.
- The reviewer agent had `Bash`. It now has Read, Glob and Grep only, and gets a pinned evidence file with the exact verified diff or content (protected paths listed without content).
- Verification commands inherited credential-like environment variables; they are now removed (names recorded in the evidence; `security.command_env_allow` to keep one). Verification commands stop at the first failure.
- The final audit ran while holding the state lock; slow commands now run outside it.
- Installer updates silently replaced files the user had changed in the installed skill (configuration, applied proposals, `VERSION`) and could copy run state found in the source folder. Changed files are now conflicts (replaced only with `--overwrite`, after a `.bak` copy), the source is validated first, run state is never copied, and the installer prints the version.
- The PreCompact hook wrote the checkpoint without the state lock.
- Configuration did not validate `execution.isolation`, `command_timeout_seconds`, `verification.regression_command` or the security lists.

Findings of the independent review of these repairs, also fixed: a reused process id made a stale lock or operation unrecoverable; a changed shared candidate at integration hit an invalid state transition; the repository guard was not re-checked before the fast-forwards that follow candidate commands; protected files appeared in the pinned diff; clean checkouts with only generated artifacts were left behind; `.git/info/exclude` was not guarded.

Behaviour changes: writing tasks in a shared workspace no longer run in parallel; worker reports need `attempt_id`; independent reviews need `review_id` and `--agent-id`; `oo result --branch` is informational only; `oo resume --requeue-running` refuses (use `oo reconcile`); runs created by an earlier version cannot be integrated or verified with the new evidence rules and should be finished by hand or restarted.

## 1.0.0 - 2026-11-16

First public release of the skill (release tag `opus-v1.0.0`). Earlier local drafts of this changelog labelled this release 2.0.0 after the "V2" design document; the published version is 1.0.0, and "V2" remains only the name of the architecture in `DESIGN.md`.

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

Changed during the 1.0.0 hardening, after the live run

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
