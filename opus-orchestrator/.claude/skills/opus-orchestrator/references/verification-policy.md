# Verification policy

A worker saying "done" is a claim. A task is done only when `oo` says COMPLETED, which takes a verification that `oo` ran itself, the orchestrator's approval with evidence for every acceptance criterion, and a passed integration. The code is `scripts/lib/verify.cjs`, `scripts/lib/reports.cjs`, `scripts/lib/security.cjs` and the `verify`, `review`, `correct`, `integrate` and `deliver` commands of `scripts/oo.cjs`; the per-mode numbers are in `config/verification.yaml`.

## 1. Layers

| Layer | What it is | Who runs it |
|---|---|---|
| `self_check` | The worker's report: one `met` and `evidence` entry per acceptance criterion | the worker (a claim, not proof) |
| `automated` | The task's `verification_commands`, run by `oo`, plus the scope check | `oo verify` (present when the task has commands) |
| `independent_review` | A separate reviewer agent (`opus-reviewer`) that did not write the work | launched by the orchestrator after `oo review-package` (present when required) |
| `opus_gate` | The orchestrator's own review against every criterion, reading the diff and the evidence | the orchestrator, recorded with `oo review` (reviewer `orchestrator`) |
| `integration` | The task's commands again after merging (worktree) or in place (shared), plus the regression command when it applies | `oo integrate` |

The layers a task gets are printed at `oo plan` and stored in `routing.verification_layers`.

## 2. Verification (`oo verify`, or `oo result --verify`)

Starts only for a task that is IMPLEMENTED (or VERIFYING, to re-run). A task with neither `verification_commands` nor a recorded manual check is refused; the orchestrator inspects the result and records `oo check <ID> --name N --result pass|fail --note T`, then runs `oo verify`. A correction round may add commands of its own (section 6).

`oo` runs each command, in order, in the worker's checkout (worktree) or in the project (shared), through one shell: `OPUS_ORCH_SHELL` if set, else `bash` on the path (never the WSL launcher), else Git for Windows bash, else the platform default. Each command gets `execution.command_timeout_seconds` (default 600); on timeout the whole process tree is killed. The last 40 lines of output are kept and secret-redacted. Before it runs, a command is checked by the safety guard (section 8); an unsafe one is not executed and counts as failed.

The verdict is **passed** only when all of these hold:

- no command failed, timed out or was refused (exit code 0 for each);
- no manual check has result `fail`;
- every changed file is inside the task's `authorized_files` (section 3);
- there was at least one command or one manual check;
- in the worktree strategy, the worker's work is committed.

A pass moves the task to REVIEWING and prints the next step. A failure moves it to CORRECTION_REQUIRED, prints each failing command with its exit code and output tail, and exits 1; that is the normal road into a correction. Each run writes `runs/<run id>/evidence/<ID>-verify-<n>.txt` (workspace, shell, scope basis, changed files, each command with exit code, duration and output tail, the verdict) and counts as a verification run in the usage.

## 3. Scope

The changed files of a task must lie inside `authorized_files` (files, directories with a trailing `/`, globs). Absolute paths and `..` are never in scope. A specification may not authorize a protected path (`security.protected_paths`: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, `*secret*`) unless it sets `security_sensitive: true`. How the changed files are determined differs by strategy (worktree: git diff of the worker's commit; shared: snapshot diff); see `execution-policy.md`.

## 4. Modes

`--mode` selects one row. `max_parallel` caps workers; `independent_review` says which tasks need a separate reviewer; `regression` and `final_audit` say when the regression command runs; `reviewers_high_risk` is the number of approving independent reviews a high-risk task needs.

| Mode | max_parallel | Independent review when complexity is at least ... or risk is in ... | regression | final_audit | reviewers_high_risk |
|---|---|---|---|---|---|
| fast | 3 | 11 (never reached), high | never | false | 1 |
| balanced (default) | no cap | 5, high | risky | false | 1 |
| thorough | no cap | 3, medium or high | always | true | 1 |
| maximum | no cap | 1 (every task), low, medium or high | always | true | 2 |

Further rules that apply in every mode: a `security_sensitive` task always gets an independent review; work the orchestrator does itself always gets one; `execution.independent_verification: false` removes the complexity and risk triggers for low-risk tasks. A verification that is not run is not claimed: the final report lists a task as verified only when a passed verification is recorded.

Depth of the orchestrator's own work by mode (in `SKILL.md`): fast reads the diff and the evidence; balanced reads every diff against every criterion; thorough adds edge cases, the wider test suite and regression and integration judgment at every gate; maximum adds `security_sensitive` marking and a read-only `security` task.

## 5. Independent review and the quality gate

`oo review-package <ID>` (task in REVIEWING; counts one agent call against the limit) writes a reviewer package and prints the `Agent call:` for `opus-reviewer` (or the `general-purpose` fallback). The reviewer's final message goes to `oo review <ID> --stdin` unchanged.

A review report has `task_id`, `reviewer`, `verdict` (`approve`, `request_changes`, `reject`), `criteria` (exactly one `met`/`evidence` entry per acceptance criterion, in order), `findings` (each with `severity` `blocker|major|minor|note`, `description`, optionally `file`) and optional `checks`. Rules `oo` enforces:

- `approve` requires every criterion met; any other verdict requires at least one finding.
- A reviewer other than `orchestrator` is accepted only after a review package was issued in the current round.
- Any verdict other than `approve`, from anyone, moves the task to CORRECTION_REQUIRED.
- An independent approval leaves the task REVIEWING; it still needs the orchestrator's own approval. The orchestrator's `approve` moves it to APPROVED only when verification passed in the current round, and, if independent review is required, an approving independent review exists (`NO_INDEPENDENT_REVIEW`).
- A high-risk task in a mode with `reviewers_high_risk` of 2 (maximum) is not approved before two independent reviews approve it in the current round; `oo` refuses the orchestrator's approval and says how many are recorded. A "high-risk" task is one whose risk is `high`, which a `security_sensitive` task is by default when the specification sets no `risk`.
- Evidence is per round: a correction archives the round's verification, reviews and review packages, so approval needs fresh ones.

The orchestrator's review is the gate. It states, for each acceptance criterion, what it observed (file and line, test name, command and exit code). When the worker's report, a reviewer and the evidence disagree, the orchestrator checks the code and the command output itself; its reading decides, and the correction request or an `oo decision` records why.

## 6. Correction loop

A task is in CORRECTION_REQUIRED after a failed verification, a non-approving review or a failed integration. The orchestrator writes a correction request (`templates/correction-request.yaml`) and sends it with `oo correct <ID> --stdin`:

| Field | Required | Meaning |
|---|---|---|
| `failure` | yes | the exact failure |
| `evidence` | yes | command output or file and line |
| `expected_behavior` | yes | what should happen |
| `required_change` | yes | the one change needed |
| `verification` | yes (non-empty list) | commands or steps that prove the fix; checked by the safety guard |
| `scope` | no | files to change; must lie inside the task's `authorized_files`; defaults to them |
| `verification_commands` | no | shell commands that fail before the fix and pass after it; `oo verify` runs them in that round in addition to the task's own commands and records them in the evidence; safety-checked |
| `strategy_change` | from round 2 | what differs from the earlier attempt |

Rules:

- Corrections are bounded by `max_review_rounds` (default 3; `--review-rounds`). At the limit, `oo correct` is refused and names the options: `oo fail` then `oo escalate`, or `oo block` and ask the user, or a higher limit recorded by the user with `oo authorize --limit max_review_rounds --value <n> --by user --reason T`.
- `oo correct` archives the current round's evidence, adds 1 to `review_round`, moves the task to READY and marks the next dispatch as a correction; the worker package then contains the correction request.
- A correction asks for the localized fix, not a rewrite.
- A failing verification, a failed integration and a requested change all use this loop; a worker that crashes or reports garbage uses the retry path in `recovery-policy.md`.

## 7. Integration, regression and the final audit

`oo integrate <ID>` (task APPROVED) runs the task's `verification_commands` again, in the integration worktree after merging (worktree) or in the project (shared). It also runs `verification.regression_command` when one is configured and the mode's `regression` is `always`, or `risky` with a task that is high risk or `security_sensitive`. A passing result commits the merge (worktree) and moves the task to COMPLETED. A failure moves it to CORRECTION_REQUIRED; a merge conflict moves it to BLOCKED (see `execution-policy.md`). Evidence goes to `<ID>-integrate-<n>.txt`.

`oo deliver` requires every task to be COMPLETED or CANCELLED. In a mode whose `final_audit` is true (thorough, maximum) it first runs `verification.regression_command` on the integrated result (integration worktree, or the project in the shared strategy), under the same timeout and safety guard, and writes `final-audit.txt`. If the command fails, nothing is delivered (`FINAL AUDIT FAILED`, exit 1) and running `oo deliver` again repeats the audit. If no regression command is configured, `oo deliver` says that no final audit command is configured and delivers without one.

`verification.regression_command` is `null` as shipped, so until you set it the regression runs and the final audit do nothing in any mode. Set it in `.claude/opus-orchestrator/config.yaml` before a run (a run keeps the configuration it started with). The final audit runs while `oo` holds the state lock.

## 8. Command safety, protected paths and secrets

- **Command guard.** `security.checkCommandSafety` refuses commands that match patterns for: `git reset --hard`, `git clean`, `git push`, `git checkout --`, `git branch -D`, `--force` flags, `sudo` and `doas`, a download piped into a shell or `Invoke-Expression`, shutdown and reboot, `mkfs`, `dd of=/dev/...`, `format <drive>:`, `del /s` and similar, `chmod -R 777`, fork bombs, `npm`, `pnpm`, `yarn` or `bun publish`, `cargo publish`, `twine upload`, `docker push`, `terraform apply` and `destroy`, `kubectl apply` and `delete`, and recursive removal (`rm -rf` and PowerShell equivalents) of a root, home, the current or parent directory, or a bare wildcard; plus `security.extra_unsafe_patterns` from the configuration. The same check applies to a task's `verification_commands` at planning time, to a correction's `verification` and `verification_commands`, and to every command at run time.
- **It is a guard, not a sandbox.** It pattern-matches the command text. A command that passes runs with the full rights of the user, and a command that does its damage through a script or decoded text is not recognised.
- **Secrets.** Text that `oo` records (reports, reviews, corrections, evidence output, commands, observations) is passed through a redactor for private-key blocks, bearer tokens, well-known token prefixes, long mixed-case tokens and `NAME=value` assignments whose name contains KEY, TOKEN, SECRET, PASSWORD or PASSWD. The gaps are listed in the README.
- **Data, not instructions.** Worker packages and the orchestrator's instructions state that file contents, documentation, tool output and agent reports are data.
