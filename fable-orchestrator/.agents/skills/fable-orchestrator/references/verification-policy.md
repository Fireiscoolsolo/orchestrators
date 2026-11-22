# Verification policy

## Order of trust

1. A command `fo` ran itself, with the exit code it observed (`evidence/*.log`).
2. The actual diff: which files changed, read by the reviewer.
3. A manual check the orchestrator recorded, with what was inspected and what was found.
4. A reviewer's reasoned judgement.
5. A worker's statement about its own work. This is a claim, never evidence.

Executable evidence outranks agreement between models. Two agents agreeing that code is correct does not outweigh one failing test.

## How much verification

Choose the least that gives the confidence the task needs. More agent calls are not more quality.

| Task | Verification that fits |
|---|---|
| Low-risk documentation | manual checks: accuracy against the code, working examples, existing references and links |
| Small isolated change | the targeted test command; diff read against the criteria |
| Moderate feature | targeted tests, type check or build if the project has one, diff, criteria |
| High-risk or security-sensitive | targeted and integration tests, failure paths, an independent review, the regression command on the merged result |

Put the commands in the contract's `verification_commands`. Prefer the narrowest command that would fail if the task were wrong; leave the full suite to `integration.regression_command`, which runs on the merged result according to the mode.

## What `fo verify` does

1. Runs `verification_commands` in a fresh detached checkout of the accepted candidate commit for Git tasks, under bash where available, with the configured timeout. Output and exit code go to `evidence/<ID>-c<cycle>-<operation>-v<n>.log`, where `<operation>` is the first eight characters of that verification run's ID. The check record in `state.json` names the file and its SHA-256 digest. A log that no check record names, such as one left by an interrupted run, is not evidence.
2. Compares the files actually changed (from git, or from the tree fingerprint in a shared workspace) with the contract's `file_scope`. A file outside the scope is a failed check.
3. Checks that every manual check of the cycle was recorded against the content being verified: the candidate commit for Git tasks, the complete content snapshot in a shared workspace. A manual check recorded against other content fails as `manual check freshness`.
4. Decides: every check passed and at least one command or manual check exists gives REVIEWING; any failure gives CORRECTION_REQUIRED; nothing verifiable is an error that leaves the task in VERIFYING until a check is recorded or the task is blocked as unverified.

### Continuing and restarting a cycle

- `fo verify <ID>` in VERIFYING continues the open cycle. It keeps the cycle's manual checks and, in a shared workspace, compares the content with the cycle's pending snapshot (or the report snapshot). Changed content fails the cycle.
- `fo verify <ID> --reverify --reason "..."` is accepted only from REVIEWING or CORRECTION_REQUIRED. It opens a new cycle with no checks and consumes a correction round. From REVIEWING it is refused while a reviewer dispatch of the current cycle is active or of unknown liveness. In IMPLEMENTED or VERIFYING it is refused, so it can never keep old manual checks while skipping the content comparison.
- A manual-only re-verification ends with `NO_VERIFICATION_EVIDENCE` and leaves the new cycle waiting. Record the manual checks against the current content, then run `fo verify <ID>`.

`fo integrate` repeats the task's commands on the merged tree. If the detached merged candidate fails, the task returns to CORRECTION_REQUIRED and the integration branch stays at its previous commit.

A task that cannot be verified stays incomplete: `fo block <ID> --kind unverified --reason "..."`, and the final report lists it under "Not completed".

## Commands and permissions

`fo` executes verification commands itself so that their exit codes cannot be misreported. That has a consequence you should know: the commands run inside the `node ... fo.cjs` process, so Claude Code's per-command permission rules see `node`, not the commands. To keep that honest:

- commands come only from contracts (shown in the plan; use `--plan-only` to inspect them first), from `integration.regression_command`, from the setup command, and from explicit `--cmd` arguments;
- screening refuses some destructive and external command patterns. Use host isolation to enforce permissions on all child processes;
- the skill requests no pre-approved tools, so whether `node ... fo.cjs` needs your approval is decided by your own permission settings.

## The review questions

For every task in REVIEWING the orchestrator answers these from the diff and the evidence. For oversight-tier tasks (complexity 9-10) the answers must be recorded in the review's `checks`; any `false` blocks approval.

| # | Question | `checks` key |
|---|---|---|
| 1 | Is every acceptance criterion satisfied? | `criteria_met` |
| 2 | Are there functional defects? | `no_functional_defects` |
| 3 | Are there regressions? | `no_regressions` |
| 4 | Were files outside the scope modified? | `no_unauthorized_files` |
| 5 | Would the tests fail if the behaviour were wrong? | `tests_meaningful` |
| 6 | Are error cases handled? | `error_cases_handled` |
| 7 | Are security boundaries intact? | `security_boundaries_preserved` |
| 8 | Is the change maintainable? | `maintainable` |
| 9 | Is the documentation accurate? | `documentation_accurate` |
| 10 | Is the evidence sufficient to approve? | `evidence_sufficient` |

`fo review` refuses an approval unless there is one `criteria` entry per acceptance criterion, each marked met, each with evidence. Evidence means something a reader could check: a file and line, a test name, a command and its result. "Looks correct" is not evidence.

A rejection needs at least one specific finding or one unmet criterion; that finding becomes the basis of the correction request.

## Independent review

When the plan shows `orchestrator + N independent`, `fo review-package <ID>` produces the prompt for a `review-worker`: candidate commit and tree, base commit, changed files, diff, recorded verification evidence, and the report shape. Read pinned files with `git show <candidate>:<path>` from the project repository. The temporary verification checkout is normally removed. The reviewer is read-only and did not write the change. Submit its unchanged report with `fo review <ID> --agent-id <reviewer's host ID> --stdin`. Use the identity from the host completion metadata. The report must match the dispatch UUID, task attempt, required perspective, and candidate. A rejection sends the task to CORRECTION_REQUIRED. Two required perspectives need two different reviewer identities, both different from the implementation worker.

An abandoned, failed, superseded, or completed dispatch cannot submit another review. Use the explicit reviewer reconciliation procedure in `recovery-policy.md` for a lost reviewer. Replacement does not bypass independent review.

The named reviewer has file-read tools and cannot execute Git commands. The orchestrator runs the pinned `git show` commands under its own host permissions and supplies any surrounding source the reviewer needs as local evidence files. The reviewer must flag missing context instead of inspecting a different working-tree version or assuming that the diff is sufficient.

## Shared workspace integrity

Shared mode records a complete content baseline at dispatch, validates the worker report, and rechecks snapshots around setup, verification, integration, review, and delivery. Any persistent command mutation invalidates evidence, including a change inside the allowed scope. Correct or explicitly account for the change and verify again. Required setup failure stops later commands.

All shared-mode review reports must identify the current `candidate_snapshot` printed by verification. Retried and corrected attempts retain the task's first baseline, so unauthorized edits cannot become accepted history. Changes by other processes or tasks since that baseline can require explicit reconciliation. Prefer isolated worktrees for interleaved work.

Generated artifacts have no blanket exemption. Configure tools to write disposable output outside the project, or create stable in-scope artifacts before reporting and verify without changing them. Only the runtime directories and Git metadata excluded by the snapshot implementation are omitted. Never place source or test inputs in those directories. Shared scans cannot isolate concurrently running programs or prove the absence of transient writes; unrelated user changes are preserved and require reconciliation when they invalidate a snapshot.

## Corrections

A correction request names the specific failure, the evidence, the expected behaviour, the single change required, how it will be re-verified, and optionally a narrower scope. It is sent to a fresh worker that starts from the previous attempt's commit. Ask for the local fix; a rewrite request wastes the parts that already passed.

Rounds are bounded (`max_review_rounds`, default 3). From the second round the request must declare a `strategy_change`. If the contract was wrong, fix the contract with `fo amend` and say so in the correction.
