# Execution policy

## Modes

`--mode` changes what `fo` enforces and how deep the orchestrator should go.

| | fast | balanced (default) | thorough | maximum |
|---|---|---|---|---|
| Parallel workers | at most 3 | up to `max_workers` | up to `max_workers` | up to `max_workers` |
| Independent review | high-risk only | high-risk or complexity 7+ | complexity 5+ or risk above low | every change; two perspectives when high-risk |
| Project regression command at integration | never | for tasks above low risk | every integration | every integration |
| Final audit before delivery | none | none | regression command on the integrated result | regression command on the integrated result |
| Contracts (orchestrator) | objective, criteria, scope, one command | full contract | add inputs, outputs and edge cases to criteria | add failure paths and security criteria explicitly |
| Review (orchestrator) | criteria against evidence | criteria, diff, regressions | plus tests-would-fail check and neighbouring callers | all ten questions answered in `checks` |

The regression command is `integration.regression_command` in the configuration (for example `npm test`). Without one, integration re-runs each task's own verification commands on the merged result, in every mode.

No mode lifts a limit. Maximum means stronger verification, never unbounded agent calls or review loops.

## Concurrency

`fo next` dispatches a task only when all of these hold:

- its dependencies are COMPLETED, meaning merged into the integration branch and checked there;
- its `file_scope` does not overlap the scope of any task that is in flight or still owns unfinished work (awaiting verification, review, correction or integration);
- a worker slot is free: `min(--max-workers, mode cap)` minus tasks dispatched or running;
- the agent-call budget is not exhausted;
- no `exclusive: true` task is in flight, and an exclusive task runs alone.

One ready task means one worker; three independent tasks mean three; ten mean five at a time. Candidates are ordered by priority, then by how many tasks depend on them, then by id.

Scope overlap is judged conservatively: a directory overlaps everything under it, and a glob overlaps whatever it could match. Narrow scopes are the lever for more parallelism. `fo plan` warns about unrelated tasks that will be serialized.

## Workspaces

| Strategy | When | How a task is isolated |
|---|---|---|
| `native` | default in a git repository with at least one commit | the Agent call carries `isolation: worktree`; Claude Code gives the worker its own worktree and branch |
| `managed` | `isolation.strategy: managed`, and always for tasks the orchestrator implements | `fo` creates the worktree and branch and the prompt names the directory |
| `shared` | no git, no commits, or configured | no isolation; overlapping scopes are serialized; changes land in place |

In git workspaces:

1. At the first dispatch `fo` creates branch `fable/<run>/integration` in a worktree of its own, from your current HEAD. Your checkout is not touched during the run.
2. Each task prompt starts with `git merge --no-edit <commit>` for the integration tip (and the previous attempt, on a correction). Claude Code branches agent worktrees from the default branch, so this step is what guarantees a dependent task sees its dependencies' integrated work.
3. The worker commits on its own branch and reports the commit. If it leaves changes uncommitted, `fo` commits them on that branch so that what was verified is what gets merged.
4. Verification runs in the worker's worktree, or in a detached checkout of the reported commit if that worktree is gone.
5. `fo integrate` merges the commit into the integration worktree with `--no-commit`, runs the integration commands on the merged tree, then commits the merge or aborts it. A conflict or a failed check leaves the integration branch exactly as it was.
6. `fo deliver` fast-forwards your branch to the integration branch. Git refuses a fast-forward that would overwrite local modifications, and `fo` never forces it: when it cannot deliver it reports the branch name and stops.
7. `fo cleanup` removes checkouts `fo` created, removes worker worktrees only when they are clean, and deletes only branches that are merged.

Uncommitted changes in your checkout stay where they are. They are not visible to workers; `fo` warns when they fall inside a task's scope.

In the shared workspace `fo` fingerprints the tree at dispatch and again at report, attributes changed files to the task whose scope contains them, and treats a changed file that belongs to no in-flight task as a scope violation.

## Budget

| Setting | Enforced how |
|---|---|
| `budget.agent_call_limit` | Hard. `fo next` stops dispatching when reached; workers and reviewers both count, as do delegations a lead reports. |
| `budget.token_limit` | Against the worker token counts passed to `fo report --tokens`. The orchestrator's own usage is not visible from inside a session. |
| `budget.cost_limit_usd` | Not enforceable in-session. Headless runs can use `claude -p --max-budget-usd`. |
| `budget.warn_at_percent` | Warning printed by `fo next` and `fo status`. |

`null` means you set no limit; account and provider limits still apply and are never bypassed. Limits rise only through `fo authorize ... --by user`, after the user was actually asked.

## Context packages

`fo next` builds each worker prompt from the contract: objective, acceptance criteria, file scope, inputs and outputs, one-line summaries of completed dependencies, the contract's `context`, the last six recorded decisions, verification steps, workspace rules, the correction request when there is one, and the report format. No conversation history and no repository dump. If a worker needs more, the fix is a better `context` field, not a longer prompt.

## Cancellation

`fo cancel <ID> --reason "..."` or `fo cancel --all --reason "..."`. A cancelled task is terminal: nothing re-dispatches it, a late report for it is refused, and reopening needs `--user-authorized`. Stop a still-running agent yourself when you cancel its task.
