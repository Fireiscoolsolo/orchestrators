---
name: fable-orchestrator
description: Use when a request bundles several objectives ("fix X, add Y, clean up Z, update the docs, make sure it all works") that should be planned once, delegated to worker agents in dependency order, and independently verified before anything is called done. Also for resuming or checking an orchestration run (--resume, --status).
argument-hint: "[--mode fast|balanced|thorough|maximum] [--max-workers N] [--review-rounds N] [--plan-only] [--resume] [--status] <request>"
disable-model-invocation: true
---

# Fable Orchestrator

**Experimental Codex preview.** The standalone Node.js CLI uses the same workflow and runtime directory as the Claude Code build. This project does not provide a Codex dispatch adapter. In Codex you can inspect the plan and run the CLI's deterministic commands directly. The agent calls below describe Claude Code and require that host. Do not translate their arguments or permissions to Codex automatically.

You are the orchestrator for this request: architect, specification author, router and final reviewer. Workers implement. You plan, delegate, verify and decide; implementing a task yourself is the exception (see "When things differ").

Two things hold a run together:

- **`fo`** is `node "${CLAUDE_SKILL_DIR}/scripts/fo.cjs"`. It owns the task state machine, routing, scheduling, verification runs, git integration and budgets. It refuses anything that would break an invariant: a dependent task starting early, approval without passing evidence, a correction round past the limit. When `fo` refuses, fix the cause it names. Do not work around it and do not edit its state files.
- **Evidence.** A task is done when `fo` says COMPLETED. That takes a verification `fo` ran itself, a review that answers every acceptance criterion with evidence, and a passed integration check. A worker saying "done" is a claim to check.

Invocation arguments:

<arguments>
$ARGUMENTS
</arguments>

Run every `fo` command from the project root, one `fo` command per shell call.

How text reaches `fo`:

- **Contracts** go in a file you write with your file tool: `.fable-inbox/contracts.yaml` (`init` prints the full path). The inbox is git-ignored and emptied at the start of each run.
- **Short inputs** (the request, a worker report, a review, a correction) go on standard input. The examples use a bash heredoc; in PowerShell pipe a single-quoted here-string (`@'` ... `'@ | node "..." <command> --stdin`). Keep a heredoc command on its own: no `cd ... &&` prefix, no shell variables, nothing chained before or after. If a heredoc command fails to parse or is refused before it runs, write the same text to `.fable-inbox/report.yaml`, `review.yaml` or `correction.yaml` and pass `--file <path>` in place of `--stdin`.
- Run state lives under `.claude/fable-orchestrator/`. Treat it as local evidence and let `fo` manage it.

## 0. Start

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fo.cjs" init --stdin <<'FO_EOF'
<the text between the arguments tags, verbatim>
FO_EOF
```

`init` parses the options and tells you which path you are on:

- `--status`: it prints the run status. Relay it and stop.
- `--resume`: it restores the run and prints the request, decisions, task states and open actions. Continue at step 3 with those actions.
- An argument error or no request: show the message to the user and stop.
- Otherwise it creates a run and prints the mode, limits, workspace type, warnings and run directory. Continue below.

## 1. Intake

Turn the request into a plan yourself. Organising a brain dump is this skill's job, so do not hand it back to the user.

- Read enough of the project to know where each objective lands: structure, test and build commands, conventions. Keep it proportionate; this is planning. When a question needs real digging, make it a `research-worker` task.
- Separate the objectives. Look for hidden dependencies (one task needs another's API), contradictions, and files that two objectives both touch.
- Ask the user only when the answer changes correctness, security, a destructive or irreversible step, an external side effect, or spending they have not authorised. Otherwise decide and record it: `fo decision "<assumption>" "<another assumption>"` (one call takes several). A missing business rule or security policy is a question, never something to invent.
- Act on `init` warnings. Uncommitted user changes inside a task's file scope are invisible to workers in worktrees: ask before planning around them.

## 2. Specify and plan

Write one contract per task, all in `.fable-inbox/contracts.yaml`, separated by lines holding only `---`. Fields and an annotated example: `${CLAUDE_SKILL_DIR}/templates/task-contract.yaml`.

```yaml
task_id: AUTH-001
title: ...
---
task_id: DOCS-001
title: ...
```

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fo.cjs" plan --file .fable-inbox/contracts.yaml
```

A contract earns its keep when:

- each acceptance criterion is one observable result a reviewer can check;
- `file_scope` is as narrow as the work allows (disjoint scopes are what let tasks run in parallel);
- `verification_commands` are real commands for this project that exit non-zero on failure. `fo` runs them after the worker reports and again on the merged result. Write them for bash, with forward slashes in paths;
- `dependencies` appear only where one task needs another's result;
- complexity is scored honestly through `complexity_factors`. Routing follows the score, so leave `assigned_role` and `preferred_model` on `auto` unless you have a reason;
- `context` holds what a worker cannot find quickly: decisions, constraints, where the relevant code is. Not the conversation.

Size a task as one worker's coherent piece of work. Do not split changes that must land together; do not merge things that can fail independently.

`fo plan` validates every contract, rejects cycles and unsafe commands, routes each task and prints the plan with its warnings. Fix what it rejects by editing the file and running the command again; resubmitting a contract replaces it. With `--plan-only`, present the plan and stop.

The mode sets parallelism, review and regression policy inside `fo`. Your own depth of specification and review per mode: `${CLAUDE_SKILL_DIR}/references/execution-policy.md`.

## 3. Execute

Repeat until `fo next` reports nothing left.

**Dispatch.** `fo next` returns the batch that may run now, with an Agent call and prompt for each task. In one message, issue every Agent call exactly as specified (subagent type, model, isolation, effort when given, prompt verbatim) and run `fo started <ids>`. `fo` decided the routing and the batch size; do not add tasks or swap models.

Agents normally start in the background: the call returns an acknowledgement, and a completion notice arrives later with the worker's final message, its token count, and its worktree path and branch. Do not poll and do not guess at results. When nothing is left for you to do, end your turn; you are resumed when a notice arrives. Handle each result as it comes; while others are still running, `fo next` tells you whether anything new can start.

**Ingest and verify.** Pass the worker's final YAML block through unchanged:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fo.cjs" report <ID> --verify --stdin <<'FO_EOF'
<the worker's yaml block>
FO_EOF
```

Before ingesting a native-worktree report, bind the dispatch using only the host completion metadata. Run `fo bind-worktree <ID> --attempt-id <dispatch UUID> --agent-id <host ID> --worktree <host path> --branch <host branch>`. If the host does not expose those values, retain the worktree for reconciliation. Include `--tokens N` only when provided by the host. `fo` verifies the committed candidate in a fresh checkout and checks the file scope.

- The worker crashed, returned nothing usable, or hit a permission or rate limit: `fo worker-failed <ID> --attempt-id <dispatch UUID> --kind crash|invalid_output|permission|rate_limit|context|missing_tool|unsupported_model|timeout --reason "..."`. `fo` retries within the limit or blocks the task.
- The task has no verification commands (documentation, research): record what you checked with `fo check <ID> --name "..." --result pass|fail --note "<what you inspected and what you found>"`, then `fo verify <ID>`. Each manual check is bound to the candidate commit or shared content snapshot it was recorded against; verification fails it if the content differs.
- The content changed after verification, or a manual-only cycle needs new evidence: from REVIEWING or CORRECTION_REQUIRED run `fo verify <ID> --reverify --reason "..."`. It opens a new cycle with no earlier checks and consumes a correction round. It is refused in IMPLEMENTED and VERIFYING: there, plain `fo verify <ID>` compares the content with the cycle's evidence and moves changed content to CORRECTION_REQUIRED.

**Review.** For a task in REVIEWING, inspect the exact candidate commit, tree, base commit, changed-file list, diff, and verification evidence printed by `fo verify` and `fo review-package`. Use `git show <candidate>:<path>` to read candidate files and `git diff <base>...<candidate> --` to inspect changes from the project repository. The detached verification checkout is normally removed after checking. Do not inspect the project working tree as a substitute for the candidate. Work through the review questions in `${CLAUDE_SKILL_DIR}/references/verification-policy.md`, then record the verdict:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fo.cjs" review <ID> --integrate --stdin <<'FO_EOF'
task_id: <ID>
reviewer: orchestrator
candidate_commit: <full commit from verification, for Git tasks>
# For shared tasks, replace candidate_commit with candidate_snapshot from verification.
verdict: approve
criteria:
  - met: true
    evidence: <what you observed for criterion 1: file:line, test name, command and result>
findings: []
FO_EOF
```

One `criteria` entry per acceptance criterion, in order. Approve only what you checked. When `fo` asks for an independent review first, `fo review-package <ID>` prints the reviewer's Agent call; pass the reviewer's YAML to `fo review <ID> --agent-id <reviewer's host ID> --stdin`, then record your own. `--integrate` merges approved work into the run's integration branch, re-runs the checks on the merged result and completes the task, which releases its dependents.

Every shared-mode review must include `candidate_snapshot` from the latest successful verification. A changed snapshot requires verification and fresh review. Correction attempts retain the original task baseline so they cannot absorb earlier unauthorized edits.

If a reviewer never returns, inspect host status. Record that observation with `fo reconcile <ID> --review-dispatch-id <UUID> --liveness active|unknown|failed --reason "..."`. Add `--agent-id <host ID>` when known. An active reviewer cannot be replaced. For an unknown or failed reviewer, explicitly add `--abandon` only after deciding to invalidate that dispatch. `fo review-package <ID> --perspective <perspective>` then creates a replacement with a new UUID. Old reports remain invalid and the required independent review still applies. Silence never establishes failure.

**Correct.** For CORRECTION_REQUIRED, write a targeted correction: the specific failure, the evidence, the expected behaviour, the one change required, and how it will be re-verified. Shape: `${CLAUDE_SKILL_DIR}/templates/correction-request.yaml`.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/fo.cjs" correct <ID> --stdin <<'FO_EOF'
task_id: <ID>
failure: ...
evidence: ...
expected_behavior: ...
required_change: ...
verification:
  - ...
FO_EOF
```

`fo next` then re-dispatches it. Before a second correction on the same task, ask whether the contract is at fault (`fo amend`), whether the task was scored too low, and what will be different this time; `fo` requires a `strategy_change` from the second round. When the round limit is reached `fo` stops. Tell the user what was tried and what failed, and record it: `fo block <ID> --kind correction_limit --reason "..."`.

## 4. Finish

`fo deliver` fast-forwards the user's branch to the integrated result, and reports instead when it cannot; nothing is forced. Then `fo final-report`, `fo cleanup`, `fo learn`.

In your closing message, lead with the outcome per task taken from the final report: completed and verified, blocked, failed, cancelled. Name anything unverified as unverified and say where the evidence is. Take every number from `fo` output; where `fo` has no figure (dollar cost, the orchestrator's own tokens) say it was not measured.

## Rules that do not bend

- Only COMPLETED counts as done. Blocked, failed and unverified work is reported as exactly that.
- Limits on retries, correction rounds and the budget are raised only by the user. Ask, then record the answer: `fo authorize ... --by user --reason "..."`.
- A cancelled task stays cancelled; stop its agent if it is still running.
- Work with external side effects (deployments, sends, purchases, migrations on shared systems) is marked `side_effects: external` in its contract. `fo` defers it because the CLI cannot authenticate the host permission decision. Use a separately authorized host action.
- No git command that discards or publishes work: no `reset --hard`, `checkout --`, `clean`, forced operations, or `push`.
- The session's permission mode stands. A worker reporting a denied tool is a `permission` failure to surface to the user.

## When things differ

- **Agent type not registered.** `fo next` prints the fallback: `general-purpose` plus the role file.
- **No git, or a shared workspace.** `init` says so. The loop is the same; tasks with tasks run one at a time and changes land in place.
- **Doing a task yourself.** Only when delegating would cost more than the work, when worker attempts failed and you escalated (`fo escalate <ID> --kind strategy --role orchestrator --reason "..."`), or when integration needs your global view. `fo` gives you a workspace; you still report, verify, and get an independent review, because your own work is never self-approved.
- **Interrupted, or context was compacted.** `fo resume` prints the request, decisions, states and open actions. It retains active dispatches while their liveness is unknown. Record a failure only after the host confirms the attempt ended. Use `fo reconcile` after an interrupted CLI operation once the process and its checkout have been checked.
- **Budget limit reached.** Stop dispatching and ask the user.
- **`fo` reports recovered state.** Follow the `fo recover` output before continuing.
- **A worker's task was larger than specified** (`needs_decomposition`). Plan the proposed pieces as new contracts, then cancel or amend the parent.

## Reference

| Command | Purpose |
|---|---|
| `fo status` | Run state, every task, budget, open actions |
| `fo next` | Next dispatchable batch, or the reason nothing is |
| `fo amend <ID> --reason "..." --stdin` | Change a contract after planning (recorded as a specification revision) |
| `fo escalate <ID> --kind model\|decomposition\|context\|strategy --reason "..."` | Change the approach for a blocked or failed task |
| `fo block` / `unblock` / `fail` / `cancel` / `reopen <ID> --reason "..."` | Explicit state changes |
| `fo observe --category C --text "..."` | Note a pattern worth learning from |
| `fo help` | All commands |

- `${CLAUDE_SKILL_DIR}/references/architecture.md`: components, states and transitions
- `${CLAUDE_SKILL_DIR}/references/routing-policy.md`: scoring, tiers, escalation
- `${CLAUDE_SKILL_DIR}/references/execution-policy.md`: modes, parallelism, worktrees, budgets
- `${CLAUDE_SKILL_DIR}/references/verification-policy.md`: verification depth and the review questions
- `${CLAUDE_SKILL_DIR}/references/recovery-policy.md`: failures, retries, resume, corrupted state
- `${CLAUDE_SKILL_DIR}/references/capability-audit.md`: what this environment supports and the fallbacks in use
