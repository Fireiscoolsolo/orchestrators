# Recovery policy

For every failure: keep the evidence, record the state, decide whether a retry is safe, avoid repeating side effects, retry only with a reason, escalate when the problem needs stronger reasoning, and report what stays unresolved as unresolved.

## Failures and what to do

| Failure | How it shows up | Action | What `fo` does |
|---|---|---|---|
| Worker crashed or returned nothing | the completion notice reports failure, or there is no usable final message | `fo worker-failed <ID> --kind crash --reason "..."` | re-queues within `max_task_retries`, then BLOCKED (`retries_exhausted`) |
| Invalid worker output | `fo report` rejects the report and lists the errors; state unchanged | fix a transcription slip and resubmit, ask the same agent for a corrected report, or `fo worker-failed <ID> --kind invalid_output` | as above |
| Missing tool | the worker says a tool is unavailable | `fo worker-failed <ID> --kind missing_tool` | BLOCKED: an unchanged retry cannot succeed. Change the role or the environment, then `fo unblock` or `fo escalate` |
| Unsupported model | the Agent call is rejected for its model | `fo worker-failed <ID> --kind unsupported_model`, then `fo escalate <ID> --kind model --model <available>` | BLOCKED until re-routed |
| Permission denied | the worker reports a denied tool or command | `fo worker-failed <ID> --kind permission`; tell the user what was denied | BLOCKED. The orchestrator does not route around permissions |
| Rate limit | the agent result carries a rate-limit error | wait, then `fo worker-failed <ID> --kind rate_limit` | re-queues within the retry limit |
| Context exhaustion in a worker | truncated or partial result | `fo worker-failed <ID> --kind context`; shrink the task (`needs_decomposition`) or its context | re-queues within the retry limit |
| Test failure | `fo verify` shows FAIL with the output tail | targeted correction via `fo correct` | CORRECTION_REQUIRED; rounds bounded |
| File-scope violation | `fo verify` shows FAIL [scope] | correction to revert the stray change, or `fo amend` if the scope was wrong | CORRECTION_REQUIRED |
| Git conflict at integration | `fo integrate` reports CONFLICT | correction: merge the integration tip and resolve, usually with `assign_role: integration-worker` | merge aborted, integration branch untouched, CORRECTION_REQUIRED |
| Regression after merging | an integration command fails on the merged tree | correction against the merged behaviour | merge aborted, CORRECTION_REQUIRED |
| Partial integration | interrupted during `fo integrate` | `fo resume`, then `fo integrate <ID>` again | aborts any half-finished merge; if the merge commit already exists it is detected and only the checks re-run |
| Interrupted run | session ended, crashed, or context was compacted | `/fable-orchestrator --resume` or `fo resume` | see below |
| Corrupted state | `fo` warns that `state.json` is unreadable | `fo recover`, then `fo resume` | see below |
| Budget reached | `fo next` prints BUDGET LIMIT | ask the user; `fo authorize --extra-agent-calls N --by user --reason "..."` | no dispatch until authorized |
| Correction limit reached | `fo correct` refuses with CORRECTION_LIMIT | re-examine the contract, then ask the user; `fo block <ID> --kind correction_limit` | no further rounds without `fo authorize <ID> --extra-rounds N --by user` |

Every failure is appended to the task's `failures` list and the event log, and appears in the final report.

## Retries and idempotency

- A retry re-dispatches the same contract to a fresh worker in a fresh worktree. Nothing from the failed attempt is reused unless it was committed and reported.
- Retries are counted per task and capped by `max_task_retries` (default 2). An escalation that changes the strategy starts a new allowance, on record; nothing raises the cap silently.
- A task marked `side_effects: external` is never retried automatically and never dispatched without `fo authorize <ID> --by user`. After an interruption it becomes BLOCKED (`retry_unsafe`): establish what already happened before running it again.
- Run ids, dispatch numbers and merge-commit trailers (`Fable-Run`, `Fable-Task`) identify what was done, so a repeated `fo integrate` does not merge twice.
- Deployments, submissions, purchases and similar actions are never performed by `fo`, and the destructive-command filter keeps them out of verification commands.

## Resume

`fo resume` (also reached through `/fable-orchestrator --resume`):

- DISPATCHED or RUNNING tasks: their agents are gone, so each is recorded as interrupted, charged one retry, and re-queued; with no retries left, or with external side effects, it becomes BLOCKED instead.
- VERIFYING tasks return to IMPLEMENTED; verification runs again. Recorded manual checks are kept.
- INTEGRATING tasks: any merge in progress is aborted and the task returns to APPROVED.
- A plan-only run that was accepted starts executing.
- It prints the original request, recorded decisions, every task's state and the open actions.

After a context compaction the same command restores what matters. `checkpoint.yaml` in the run directory is rewritten after every state change and holds the same summary; it is the substitute for context measurements and programmatic compaction, neither of which Claude Code exposes to a running model.

## Corrupted state

State is written to a temporary file and renamed into place, so a crash mid-write leaves the previous file intact. In addition `fo` keeps `state.json.bak` (the state before the last change) and a rolling set of snapshots.

If `state.json` cannot be parsed, `fo` loads the backup, then the newest snapshot. `fo recover` reports which copy was used, keeps the unreadable file as `state.json.corrupt-<timestamp>`, and lists every event logged after the restored copy. Re-check each listed event against reality (does the commit exist, did the merge happen) before continuing. If no copy is readable `fo` stops with `STATE_UNRECOVERABLE`; the event log and the evidence files remain for manual reconstruction.

## Concurrent `fo` commands

Each command takes a lock file, so parallel `fo` calls from one message are safe. A lock older than 30 seconds is treated as left over from a crashed process and taken over. Long-running work (verification and integration commands) happens outside the lock.
