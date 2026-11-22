# Recovery policy

For every failure: keep the evidence, record the state, decide whether a retry is safe, avoid repeating side effects, retry only with a reason, escalate when the problem needs stronger reasoning, and report what stays unresolved as unresolved.

## Failures and what to do

| Failure | How it shows up | Action | What `fo` does |
|---|---|---|---|
| Worker crashed or returned nothing | the completion notice reports failure, or there is no usable final message | `fo worker-failed <ID> --attempt-id <UUID> --kind crash --reason "..."` | re-queues within `max_task_retries`, then BLOCKED (`retries_exhausted`) |
| Invalid worker output | `fo report` rejects the report and lists the errors; state unchanged | fix a transcription slip and resubmit, ask the same agent for a corrected report, or `fo worker-failed <ID> --attempt-id <UUID> --kind invalid_output` | as above |
| Missing tool | the worker says a tool is unavailable | `fo worker-failed <ID> --attempt-id <UUID> --kind missing_tool` | BLOCKED: an unchanged retry cannot succeed. Change the role or the environment, then `fo unblock` or `fo escalate` |
| Unsupported model | the Agent call is rejected for its model | `fo worker-failed <ID> --attempt-id <UUID> --kind unsupported_model`, then `fo escalate <ID> --kind model --model <available>` | BLOCKED until re-routed |
| Permission denied | the worker reports a denied tool or command | `fo worker-failed <ID> --attempt-id <UUID> --kind permission`; tell the user what was denied | BLOCKED. The orchestrator does not route around permissions |
| Rate limit | the agent result carries a rate-limit error | wait, then `fo worker-failed <ID> --attempt-id <UUID> --kind rate_limit` | re-queues within the retry limit |
| Context exhaustion in a worker | truncated or partial result | `fo worker-failed <ID> --attempt-id <UUID> --kind context`; shrink the task (`needs_decomposition`) or its context | re-queues within the retry limit |
| Test failure | `fo verify` shows FAIL with the output tail | targeted correction via `fo correct` | CORRECTION_REQUIRED; rounds bounded |
| File-scope violation | `fo verify` shows FAIL [scope] | correction to revert the stray change, or `fo amend` if the scope was wrong | CORRECTION_REQUIRED |
| Git conflict at integration | `fo integrate` reports CONFLICT | correction: merge the integration tip and resolve, usually with `assign_role: integration-worker` | merge aborted, integration branch untouched, CORRECTION_REQUIRED |
| Regression after merging | an integration command fails on the merged tree | correction against the merged behaviour | merge aborted, CORRECTION_REQUIRED |
| Partial integration | interrupted during `fo integrate` | Inspect the operation and its checkout, then use `fo reconcile <ID> --reason ...` | preserves the checkout and retains the operation until reconciled |
| Interrupted dispatch | `fo next` failed or was stopped after creating a worktree but before saving state | run `fo next` again | takes over the unrecorded run worktree only when it is unmodified, on its branch, at the intended start commit; otherwise refuses with WORKTREE_CONFLICT and leaves it untouched |
| Interrupted state commit | a command failed after doing its work but before saving state | rerun the command | state is unchanged. Record copies and review diffs are written only after a commit. Command logs from the interrupted run carry its operation ID and are named by no check record |
| Review diff not written | `fo review-package` reports EVIDENCE_WRITE_FAILED | fix the disk problem, then run `fo review-package <ID>` again | the dispatch, whose prompt was never printed, is recorded as failed and its agent call returned |
| Interrupted run | session ended, crashed, or context was compacted | `/fable-orchestrator --resume` or `fo resume` | see below |
| Corrupted state | `fo` warns that `state.json` is unreadable | `fo recover`, then `fo resume` | see below |
| Budget reached | `fo next` prints BUDGET LIMIT | ask the user; `fo authorize --extra-agent-calls N --by user --reason "..."` | no dispatch until authorized |
| Correction limit reached | `fo correct` refuses with CORRECTION_LIMIT | re-examine the contract, then ask the user; `fo block <ID> --kind correction_limit` | no further rounds without `fo authorize <ID> --extra-rounds N --by user` |

Every failure is appended to the task's `failures` list and the event log, and appears in the final report.

## Retries and idempotency

- A retry re-dispatches the same contract to a fresh worker in a fresh worktree. Nothing from the failed attempt is reused unless it was committed and reported.
- Retries are counted per task and capped by `max_task_retries` (default 2). An escalation that changes the strategy starts a new allowance, on record; nothing raises the cap silently.
- A task marked `side_effects: external` requires a host-authorized execution path. The CLI cannot authenticate the host permission decision and leaves it undispatched.
- Run ids, dispatch numbers and merge-commit trailers (`Fable-Run`, `Fable-Task`) identify what was done, so a repeated `fo integrate` does not merge twice.
- Run external actions through the host permission flow. The verification command filter is advisory.

## Resume

`fo resume` (also reached through `/fable-orchestrator --resume`):

- DISPATCHED or RUNNING tasks retain their attempt while the host status is unknown. Record failure with its UUID once the host confirms it ended.
- An interrupted verifier or integrator is retained until `fo reconcile <ID> --reason ...` confirms the CLI operation is no longer active. Reconcile Git state manually first if needed. Operations record their host; reconcile one from the host that started it, because a process ID says nothing about another machine.
- An interrupted final delivery uses `fo reconcile RUN --reason ...` after checking the destination checkout.
- A plan-only run that was accepted starts executing.
- It prints the original request, recorded decisions, every task's state and the open actions.

After a context compaction the same command restores what matters. `checkpoint.yaml` in the run directory is rewritten after every state change and holds the same summary; it is the substitute for context measurements and programmatic compaction, neither of which Claude Code exposes to a running model.

## Lost independent reviewer

`fo resume` retains outstanding reviewer dispatches and reports their status. Inspect the host's execution status before changing it. Record `active`, `unknown`, or `failed` with `fo reconcile <ID> --review-dispatch-id <UUID> --liveness <status> --reason "<host evidence or uncertainty>"`, including `--agent-id <host ID>` when available. These observations are operator supplied, not authenticated host attestations.

A confirmed active reviewer cannot be abandoned or silently downgraded to unknown. Record a confirmed failure when the host establishes that it ended. For failed or unknown liveness, adding `--abandon` explicitly invalidates the outstanding dispatch while preserving its history. This does not stop a host process. When liveness is unknown, the operator accepts that it may still finish, but its late result will be rejected.

Run `fo review-package <ID> --perspective <perspective>` for the replacement. It consumes the normal reviewer budget and has a new dispatch UUID bound to the current verified candidate. Supply the replacement's actual host identity when submitting its report. A changed candidate must be verified again. Duplicate or concurrent abandonment cannot create duplicate replacement dispatches.

## Corrupted state recovery

State is written to a temporary file and renamed into place, so a crash mid-write leaves the previous file intact. In addition `fo` keeps `state.json.bak` (the state before the last change) and a rolling set of snapshots.

If `state.json` cannot be parsed, `fo` loads the backup, then the newest snapshot. `fo recover` reports which copy was used, keeps the unreadable file as `state.json.corrupt-<timestamp>`, and lists every event logged after the restored copy. Re-check each listed event against reality (does the commit exist, did the merge happen) before continuing. If no copy is readable `fo` stops with `STATE_UNRECOVERABLE`; the event log and the evidence files remain for manual reconstruction.

## Concurrent `fo` commands

The run store uses an ownership token and can reclaim a local lock after detecting that its owner process has exited. Age alone never triggers reclamation. Project verification and merge trials run outside the state lock. The event batch committed with state can be replayed after an interrupted log write.

Reaper guards atomically record ownership. A later process can follow dead-owner records to finish interrupted recovery without deleting another live process's guard. Dead guard records remain local evidence. Legacy empty or malformed guards have no provable ownership: stop all processes using that run, preserve and move the guard aside after reconciling ownership, then retry. Foreign-host ownership or a reused PID remains conservative and may require the same operator procedure.
