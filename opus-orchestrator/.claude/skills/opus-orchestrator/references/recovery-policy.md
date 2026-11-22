# Recovery policy

What happens when something goes wrong, what `oo` does by itself, what it leaves to the orchestrator or the user, and how a run resumes. The code is the `worker-failed`, `result`, `escalate`, `unblock`, `resume`, `authorize` and `context` commands of `scripts/oo.cjs`, plus `scripts/lib/store.cjs` and `scripts/lib/checkpoint.cjs`.

Principles, as enforced: a failure is recorded in the task (kind, reason, time, attempt) before anything else happens; a task with external side effects is never retried automatically; an unchanged strategy is never repeated; limits are raised only on the user's word; and state on disk, not the conversation, says where the run stands.

Evidence of recovery behaviour is in the automated tests (including `tests/oo-failures.test.cjs`, `tests/oo-recovery.test.cjs`) and the simulated demo. Resume across two real sessions, escalation to Opus workers in a live session and budget limits in a live session were not tested live.

## 1. Failure categories

Worker failures are recorded with `oo worker-failed <ID> --kind <kind> --reason T` for a task that is DISPATCHED or RUNNING (any other state is refused). The kinds:

| Kind | Meaning | Outcome |
|---|---|---|
| `crash` | the agent died or returned nothing usable | retry |
| `invalid_output` | the report is not valid, or cannot be parsed after a resend | retry |
| `rate_limit` | the provider limited the agent | retry |
| `context` | the agent ran out of context | retry |
| `timeout` | the agent took too long | retry |
| `tool` | a tool failed | retry |
| `permission` | a tool was denied | BLOCKED, for the user |
| `budget` | a limit stopped the agent | BLOCKED, for the user |

"Retry" means: if the task has external side effects, it becomes FAILED and is never retried automatically (`failed_external`); otherwise, if `retries` is below `max_retries` (default 2), it returns to READY, the next dispatch is marked as a retry and `retries` goes up by one; otherwise it becomes FAILED (`retry limit reached`). `oo` prints advice with every outcome (section 4).

A worker's own report can also end a task's attempt (`oo result`): status `failed` is handled like a retryable failure; `blocked` leaves the task BLOCKED; `needs_decomposition` leaves it BLOCKED with the proposed subtasks printed (plan them as new specifications, then cancel or amend the parent).

An unparsable or invalid report is refused and the task stays as it was (`result for <ID> rejected; task state unchanged`). When the report block is not valid YAML, `oo` names the line and asks for a resend with every string, command and path in single quotes and forward slashes in paths. If the agent cannot resend, the orchestrator records `oo worker-failed <ID> --kind invalid_output`.

The other categories of the specification map to these mechanisms:

| Situation | Mechanism |
|---|---|
| Failing tests, a failed check, a scope violation | verification fails, task is CORRECTION_REQUIRED, correction loop (`verification-policy.md`) |
| Git conflict | `oo integrate` aborts the merge, leaves the integration branch unchanged and sets BLOCKED with kind `merge_conflict` (or `merge_failed` for other merge errors). `oo unblock <ID> --reason T` sends the task back to a worker, whose package merges the current integration head first |
| Partial integration | An integration that was interrupted leaves the task INTEGRATING. `oo integrate <ID>` again aborts any merge left in progress and starts over; `oo resume` lists it as a next action |
| Interrupted session or compaction | Resume (section 5) |
| Corrupted state | Backup restore and integrity report (section 5) |
| Budget exhaustion | Section 6 |
| Context exhaustion of the orchestrator | Checkpoint and resume; the orchestrator asks the user to run `/compact` (section 7) |
| Final audit failure | `oo deliver` delivers nothing and exits 1; fix it with a new task (`verification-policy.md`) |

## 2. Correction and escalation rules

- A failed verification, a non-approving review and a failed integration lead to CORRECTION_REQUIRED, then `oo correct` (six fields; `verification_commands` that fail before the fix and pass after it; `strategy_change` from round 2). The bound is `max_review_rounds` (default 3, `--review-rounds`, at most 10 by `oo authorize`).
- At the bound, `oo correct` is refused. The orchestrator diagnoses the root cause first: is the specification wrong (`oo amend`), does the worker lack context, was the task scored too low?
- Then either `oo fail <ID> --reason T` followed by `oo escalate <ID> --model <haiku|sonnet|opus> --reason T` or `--role <role>` (including `--role orchestrator`), or `oo block <ID> --reason T` and ask the user. `oo block` is the alternative to `oo fail`, not its next step: a FAILED task can only be escalated or cancelled (or reopened with the user's authorization), a BLOCKED task can be unblocked, escalated, failed or cancelled.
- `oo escalate` works on a FAILED or BLOCKED task and refuses an escalation that repeats the unchanged strategy (the same model and role), a weaker model, or a model that is not in `models.allowed`. It re-routes the task with the new model as a floor, archives the round's evidence and moves the task to READY (or PENDING when dependencies are open); the task's attempts and review rounds keep counting.
- `oo amend <ID> --file F --reason T` replaces a task's specification while the task is PENDING, READY, CORRECTION_REQUIRED, BLOCKED or FAILED, and re-routes it.
- A task the orchestrator does itself (`oo escalate <ID> --role orchestrator`) always needs an independent review: work is never self-approved.
- `oo cancel <ID> --reason T` (or `--all`) cancels; a cancelled task stays cancelled and a late result for it is refused. Only `oo reopen <ID> --reason T --user-authorized`, on the user's word, brings back a CANCELLED, COMPLETED or FAILED task.
- Other tasks that depend on a failed or blocked task stay PENDING; when nothing can be dispatched, `oo next` prints `NOTHING DISPATCHED` with the blocked or failed task ids.

## 3. Side effects and permissions

- A task with `side_effects: external` is held by `oo next` until the user authorizes it (`oo authorize --task <ID> --side-effects --by user --reason T`); the authorization covers one dispatch, and `oo` never retries such a task, requeues it on resume, or marks it failed and retries it. After a failure, the orchestrator checks what the worker already did before anything else.
- A `permission` failure is BLOCKED and goes to the user; the orchestrator does not route around a denied tool. The session's permission mode stands. Claude Code's file tools cannot write below `.claude`; that is the reason run state is written only by `oo`.
- `oo authorize` accepts only `--by user`, only for `agent_call_limit`, `token_limit`, `cost_limit_usd`, `max_review_rounds` or `max_retries`, and only a value higher than the current limit; a lower or equal value is refused, and so is a limit that has no value (there is nothing to raise). `max_review_rounds` and `max_retries` accept at most 10.

## 4. What `oo` advises after a failure

`oo worker-failed` and failing results print an "Escalation advice" line (see `routing-policy.md`, section 6): decompose, ask the user, retry the same model, escalate the model, or send a targeted correction. The advice is not an action; the orchestrator decides, within the bounds above.

## 5. Resume

`oo resume` (the same as `/opus-orchestrator --resume`, which `oo init --resume` forwards to it) does this:

1. Reads `current`, then checks `run.json` and every task file. A file that cannot be read is restored from its `.bak` copy, which holds the version before the last save, so a restored task's status may be one step old. Output `INTEGRITY: ok` or `INTEGRITY: restored` (each restored file named, with the advice to compare that task's status with its evidence).
2. If a file cannot be restored: `INTEGRITY: PROBLEMS`, each problem, the last checkpoint if it is readable, and exit 1. The orchestrator stops and shows the user the output; `node scripts/manage_state.cjs integrity` inspects, and state files are not edited by hand. If `run.json` itself is unreadable, resume refuses.
3. Records a `resume` event and prints the resume summary built from the state: objective, options, phase, task statuses and dependencies, active agents, decisions, modified files, verification evidence per task, known failures, pending corrections, usage and next actions (the shape of `templates/checkpoint.yaml`), limited to `context.max_resume_lines` (default 120).
4. Lists every DISPATCHED or RUNNING task with its attempt id, and every interrupted verification, integration or delivery with the state of its owner process (alive, dead, or unknown on another host). `oo` cannot know whether an agent still runs, so it requeues nothing by itself; `--requeue-running` refuses and names the reconcile commands.

Reconciling an attempt: `oo reconcile <ID> --attempt <attempt id> --agent-gone --reason T`, only for the current in-flight attempt, and only when the orchestrator knows its agent stopped. The task returns to READY without using a retry; the attempt is recorded as abandoned and a late report of it is refused. A task with external side effects is never reconciled: check what its agent did, then fail or block it. A finished result (IMPLEMENTED and later) is never touched by reconciliation.

Attempt identities: every dispatch has an attempt id (`<ID>-a<n>-<random>`) printed in the package's report template. `oo result` accepts only a report carrying the current attempt id; a report of an abandoned, already reported, superseded or never-dispatched attempt is refused with the reason, and the task is unchanged. `oo worker-failed --attempt <id>` refuses a failure notice of an earlier attempt.

Interrupted operations: verification, integration and delivery record an operation (id, process id, host, start time) before their commands run outside the state lock, and apply their result only if that operation is still current. Repeating the command takes over an operation whose process is gone on this host; an operation of another host, or one whose process id now belongs to an unrelated program, is taken over with `--takeover <op id>` after a person checked. An integration interrupted after it moved the integration branch to the checked merge commit is finalized by the next `oo integrate` without merging again.

State lock: commands hold it only for short state changes. A lock is taken over only when its owner process is proven dead on the same host, never because of its age; `node scripts/manage_state.cjs lock` shows the owner, and `lock --break --token T --confirm-owner-stopped` (plus `--pid-reused` when the process id now belongs to an unrelated program) moves a lock aside, kept as evidence, after a person checked.

The orchestrator runs `oo resume` before anything else after a compaction or an interruption, and continues at the step the next actions name. In a new session the user starts with `/opus-orchestrator --resume`. `oo status` shows the same facts without changing anything; `node scripts/manage_state.cjs show`, `integrity` and `events` inspect the files.

What persists: every file in the run directory, written atomically with a `.bak` copy; the event log; the checkpoint, rewritten after every change; the inbox drafts. What does not: the orchestrator's conversation, and the agents themselves. An agent that was running when the session ended is gone; its attempt is reconciled explicitly and the task dispatched again, not resumed.

Recovery of state from `.bak` and the integrity report are covered by tests with corrupted files. Resume in a second real Claude Code session was not tested live.

## 6. Budget

Limits (all optional; `null` means none is set by the skill): `budget.agent_call_limit`, `budget.token_limit`, `budget.cost_limit_usd`, warning at `budget.warning_threshold_percent` (default 80). Only the agent-call limit is always enforceable: every dispatch and every review package counts one call. Tokens count only after they are recorded (`oo result --tokens N`, `oo usage --tokens N`), and cost only after the user gives a measured figure (`oo usage --cost USD`); until then those limits are reported as not enforced.

When a limit is exceeded, `oo next` and `oo review-package` refuse; at a warning they print it. When the agent-call limit leaves fewer calls than free slots, the deferred tasks are marked `budget`. The orchestrator stops dispatching, gives the user the numbers from `oo status`, and continues only after the user raises the limit (`oo authorize`). Retries and review rounds are bounded separately (section 2).

## 7. Context and compaction

A skill cannot read context utilization or start a compaction. What exists:

- `oo checkpoint` writes `checkpoint.yaml` on demand (every state-changing command also writes it).
- The `PreCompact` hook writes a fresh checkpoint when a run has unfinished tasks (if `context.checkpoint_before_compaction` is true) and prints instructions that Claude Code adds to the compaction summary: keep the run id, the state is on disk, run `oo resume` afterwards.
- The `SessionStart` hook (matcher `compact`) prints the resume summary after a compaction.
- `oo context` reports `unknown`, `ok` or `over_target`. A figure comes from the status-line bridge (`scripts/hooks/statusline_bridge.cjs`, recorded with source `statusline`) or from `oo context --utilization <fraction or percent>` (source `user`); a reading older than `context.utilization_max_age_seconds` (600) is ignored. The target is 0.40 (`aggressive`), 0.60 (`balanced`) or `context.target_utilization` (`custom`).
- Over the target, the orchestrator reaches a safe point (no worker mid-flight), runs `oo checkpoint` and asks the user to run `/compact`.

The hooks fire in the session where the skill was invoked, for the rest of that session. They have been tested with simulated hook input only; a real compaction was not observed.

## 8. Reporting after a failure

`oo final-report` writes `final-report.md` from recorded state only: overall COMPLETE (every task COMPLETED), PARTIAL or FAILED (no task COMPLETED); tasks by outcome; files modified; commands with exit codes; verification outcomes; limitations; risks; usage. Tokens and cost say "not measured" unless recorded. Blocked, failed, cancelled and unverified work is reported as exactly that, and partial work is never described as verified.
