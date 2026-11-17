# Architecture

## Who does what

```text
user request
   |
   v
ORCHESTRATOR  (main session model; the /fable-orchestrator skill)
   intake -> contracts -> review -> corrections -> final report
   |                 ^
   | fo <command>    | refusals, evidence, next actions
   v                 |
fo  (scripts/fo.cjs, deterministic)
   contract validation | routing | DAG + scheduler | state machine
   verification runs   | git integration | budget | recovery | learning log
   |
   | dispatch specs (agent type, model, isolation, prompt)
   v
WORKERS  (subagents in .claude/agents/)
   opus-executor (lead, may delegate) | implementation | test | debug
   integration | documentation | research | review
```

The split is deliberate. Judgement lives in the orchestrator: what the request means, how to cut it into tasks, whether a diff really meets a criterion, what a correction should say. Everything that must not depend on a model's care lives in `fo`: whether a transition is allowed, what a command's exit code was, how many correction rounds are left, which tasks may run together.

| Level | Role | Implemented as |
|---|---|---|
| A | Orchestrator | The session that invoked the skill. The skill does not pin a model; run it on your most capable one. |
| B | Execution lead | `opus-executor` subagent, routed for complexity 7 to 10. It can spawn its own workers (nested delegation is native). Simple tasks never pass through it. |
| C | Workers | Seven role definitions sharing one report contract. The model is chosen per dispatch, so one definition serves every tier. |

## Files

Reusable skill (commit it, or install it per user):

```text
.claude/skills/fable-orchestrator/
  SKILL.md                 orchestrator protocol
  config.default.yaml      defaults; override in .claude/fable-orchestrator/config.yaml
  agents/*.md              source of the eight agent definitions
  templates/*.yaml         contract, report, review, correction, checkpoint shapes
  references/*.md          this documentation
  scripts/                 fo.cjs and its modules, install.cjs, tests/
.claude/agents/*.md        installed copies (install.cjs); this is where Claude Code registers agents
```

Runtime state (git-ignored through its own `.gitignore`, never committed):

```text
.claude/fable-orchestrator/
  current                  id of the active run
  config.yaml              optional project overrides
  learning/                routing-stats.json, observations.jsonl, proposals.md
  runs/<run_id>/
    state.json             the state machine (atomic writes; .bak and snapshots/ for recovery)
    events.jsonl           append-only log of every transition and decision
    checkpoint.yaml        compact summary, rewritten after every change
    request.md, plan.md, final-report.md
    tasks/<ID>.yaml        contracts as submitted
    reports/ reviews/ corrections/   what workers and reviewers returned
    evidence/*.log         full output and exit code of every command fo ran
    integration/           git worktree of the run's integration branch
    wt/                    checkouts fo creates for verification or managed isolation
```

Drafts written by the orchestrator (git-ignored, emptied at the start of each run):

```text
.fable-inbox/
  contracts.yaml           all task contracts, separated by --- lines; read by `fo plan --file`
  report.yaml, review.yaml, correction.yaml   only when a heredoc could not be used
```

The two locations are separate on purpose. Claude Code treats `.claude/` as a sensitive path and refuses a model's file-tool writes there (verified: "requested permissions to edit ... which is a sensitive file"). So the orchestrator cannot alter `state.json` or the evidence logs with its file tools; it can only hand drafts to `fo`, which validates them and copies what it accepts into the run directory.

## Task lifecycle

```text
PENDING -> READY -> DISPATCHED -> RUNNING -> IMPLEMENTED -> VERIFYING -> REVIEWING -> APPROVED -> INTEGRATING -> COMPLETED
                        ^                                      |             |                         |
                        |                                      v             v                         v
                        +----------- READY <----------- CORRECTION_REQUIRED <-------------------------+
any active state -> BLOCKED | FAILED | CANCELLED
```

| Transition | Happens when | Guard |
|---|---|---|
| PENDING -> READY | `fo` refreshes after any completion | every dependency is COMPLETED |
| READY -> DISPATCHED | `fo next` | dependencies complete, no file-scope conflict with work in flight, a free worker slot, budget left, no external side effects requiring a host-authorized action |
| DISPATCHED -> RUNNING | `fo started` | none |
| RUNNING -> IMPLEMENTED | `fo report` | a valid completion report with status implemented; in git workspaces the commit must be locatable |
| IMPLEMENTED -> VERIFYING | `fo verify`, `fo check` | none |
| VERIFYING -> REVIEWING | `fo verify` | at least one command or manual check recorded this cycle, and every check passed |
| VERIFYING -> CORRECTION_REQUIRED | `fo verify` | any check failed, including the file-scope check |
| REVIEWING -> APPROVED | `fo review` | passing evidence, the orchestrator's approval, and the required number of independent approvals; no rejection this cycle |
| REVIEWING -> CORRECTION_REQUIRED | `fo review` | any reviewer rejected |
| CORRECTION_REQUIRED -> READY | `fo correct` | a recorded correction request; rounds used are below the limit; from round two a declared change of strategy |
| APPROVED -> INTEGRATING | `fo integrate` | no other task is integrating |
| INTEGRATING -> COMPLETED | `fo integrate` | merge without conflict and every integration command passed |
| INTEGRATING -> CORRECTION_REQUIRED | `fo integrate` | conflict (merge aborted) or a failed integration command |
| RUNNING -> READY | `fo worker-failed` | the attempt has ended and retries used are below the limit; never for tasks with external side effects |
| any -> BLOCKED | worker reports blocked, limits reached, `fo block` | none; the reason and the state it came from are recorded |
| BLOCKED -> earlier state | `fo unblock`, `fo escalate` | an explicit reason |
| FAILED -> READY | `fo escalate` | an explicit reason and a change of model, decomposition, context or strategy |
| COMPLETED -> READY | `fo reopen` | an explicit reason |
| CANCELLED -> PENDING | `fo reopen --user-authorized` | explicit user authorization and a reason |

Every transition is appended to `events.jsonl` with its reason. A command that fails a guard changes nothing: state is written only after the whole command succeeds.

## What is enforced and what is instructed

Enforced by `fo`, whatever the orchestrator does: transition legality and all guards above; contract, report, review and correction schemas; dependency cycles; concurrency and file-scope exclusion; retry and correction limits; the agent-call budget; refusal of destructive verification commands; exit codes of verification and integration commands; file-scope checks from the actual diff; fast-forward-only delivery.

Instructed in `SKILL.md`, and dependent on the orchestrator following it: the quality of decomposition and contracts; issuing Agent calls exactly as specified; reading the diff before approving; the wording of corrections; asking the user at the right moments; an accurate closing message. The final report is generated by `fo` from recorded state, so it stays correct even when the closing message is not.
