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

1. Runs each `verification_commands` entry in the worker's checkout (or a detached checkout of the reported commit), under bash where available, with the configured timeout. Output and exit code go to `evidence/<ID>-c<cycle>-v<n>.log`.
2. Compares the files actually changed (from git, or from the tree fingerprint in a shared workspace) with the contract's `file_scope`. A file outside the scope is a failed check.
3. Decides: every check passed and at least one command or manual check exists gives REVIEWING; any failure gives CORRECTION_REQUIRED; nothing verifiable is an error that leaves the task in VERIFYING until a check is recorded or the task is blocked as unverified.

`fo integrate` repeats the task's commands on the merged tree. A task that passed alone and fails merged goes to CORRECTION_REQUIRED and the merge is aborted.

A task that cannot be verified stays incomplete: `fo block <ID> --kind unverified --reason "..."`, and the final report lists it under "Not completed".

## Commands and permissions

`fo` executes verification commands itself so that their exit codes cannot be misreported. That has a consequence you should know: the commands run inside the `node ... fo.cjs` process, so Claude Code's per-command permission rules see `node`, not the commands. To keep that honest:

- commands come only from contracts (shown in the plan; use `--plan-only` to inspect them first), from `integration.regression_command`, and from explicit `--cmd` arguments;
- `fo` refuses commands that delete recursively, rewrite or publish git history, deploy, publish packages, change infrastructure, pipe downloads into a shell, or run destructive SQL, both at planning time and when asked to run them;
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

When the plan shows `orchestrator + N independent`, `fo review-package <ID>` produces the prompt for a `review-worker`: the contract, where the change is and how to diff it, the evidence recorded so far, and the report shape. The reviewer is read-only and did not write the change. Its verdict is recorded with `fo review <ID> --stdin`; a rejection sends the task to CORRECTION_REQUIRED regardless of the orchestrator's view. With two required reviews the perspectives must differ (correctness, security).

## Corrections

A correction request names the specific failure, the evidence, the expected behaviour, the single change required, how it will be re-verified, and optionally a narrower scope. It is sent to a fresh worker that starts from the previous attempt's commit. Ask for the local fix; a rewrite request wastes the parts that already passed.

Rounds are bounded (`max_review_rounds`, default 3). From the second round the request must declare a `strategy_change`. If the contract was wrong, fix the contract with `fo amend` and say so in the correction.
