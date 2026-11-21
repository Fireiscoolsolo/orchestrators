# opus-orchestrator

A Claude Code skill that turns one request with several objectives into task specifications, runs them through Haiku-first worker subagents in dependency order (in parallel where the scopes do not overlap), verifies and reviews every result, and keeps Opus as architect and final approver. The rules that matter are enforced by a command line, `oo`, not by prose: it owns the task state machine, routing, scheduling, verification runs, git integration, budgets and the persisted state.

Version 2.0.0. Read "Verification status" and "Limitations" before relying on it: only one live Claude Code run has been made, and several parts have never run against real agents.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Invocation and options](#invocation-and-options)
- [How a run proceeds](#how-a-run-proceeds)
- [Configuration](#configuration)
- [Where state lives](#where-state-lives)
- [Hooks and the status-line bridge](#hooks-and-the-status-line-bridge)
- [Headless use](#headless-use)
- [Testing](#testing)
- [Verification status](#verification-status)
- [Limitations](#limitations)
- [Layout of the skill](#layout-of-the-skill)

Reference documents: `references/architecture.md` (parts, state layout, improvement proposals), `references/routing-policy.md`, `references/execution-policy.md`, `references/verification-policy.md`, `references/recovery-policy.md`, `references/capability-audit.md` (what Claude Code provides, with sources and substitutions).

## Requirements

- Claude Code. Developed and run live against CLI 2.1.302.
- Node.js. All scripts are Node (`.cjs`, no dependencies); Python is not used. The build and the live run used Node 26.12.1; the lowest working version was not determined.
- git is optional. With a git repository that has at least one commit, work is isolated in worktrees and merged into an integration branch; without it the skill uses a shared workspace (see `references/execution-policy.md`). Tested with git 2.56.0.
- A POSIX shell for verification commands is preferred. `oo` runs them with `OPUS_ORCH_SHELL` if set, else `bash` from the path (not the WSL launcher), else Git for Windows bash, else `cmd.exe` or `/bin/sh`. `oo doctor` prints the shell it found.

## Installation

The skill is a folder, `opus-orchestrator`, that Claude Code finds in `.claude/skills/` of a project or in `~/.claude/skills/`. Its five worker agents must additionally be in `.claude/agents/` (project) or `~/.claude/agents/` (user): Claude Code does not discover agent definitions inside a skill folder. Without them `oo next` falls back to the `general-purpose` agent type and tells it to read the role definition first, which works but is less restricted (see "Limitations").

`scripts/install.cjs` does both and never edits settings files and never deletes anything:

```bash
# project level: copies the skill to <dir>/.claude/skills/opus-orchestrator and the agents to <dir>/.claude/agents
node .claude/skills/opus-orchestrator/scripts/install.cjs --project <dir>

# user level: the same under your home directory (OPUS_ORCH_HOME overrides the home directory)
node .claude/skills/opus-orchestrator/scripts/install.cjs --user

# only the agents, for a skill that is already in place
node .claude/skills/opus-orchestrator/scripts/install.cjs --project <dir> --agents-only

# show what would be written, change nothing
node .claude/skills/opus-orchestrator/scripts/install.cjs --project <dir> --dry-run

# replace agent files that exist with different content (a .bak copy is kept)
node .claude/skills/opus-orchestrator/scripts/install.cjs --project <dir> --overwrite

# check the structure of a skill directory (frontmatter, agents, VERSION, paths mentioned in SKILL.md and this README)
node .claude/skills/opus-orchestrator/scripts/install.cjs --validate
```

Exit codes: 0 success, 1 a conflict or a validation problem (it names each one), 2 a usage error. If an agent file already exists with different content and `--overwrite` is not given, nothing at all is written.

When `.claude/agents/` does not exist yet, the installer says so: Claude Code must be restarted before it loads a brand-new agents directory.

`oo doctor` reports the versions of Node, git and Claude Code, the workspace strategy the current directory would get, which agents are installed and the verification shell:

```bash
node .claude/skills/opus-orchestrator/scripts/oo.cjs doctor
```

## Invocation and options

The skill has `disable-model-invocation: true`: only you start it, with a slash command.

```text
/opus-orchestrator [--mode fast|balanced|thorough|maximum] [--max-workers N] [--review-rounds N] [--plan-only] [--resume] [--status] <request>
```

| Option | Meaning |
|---|---|
| `--mode` | Quality mode; default `balanced`. See `references/verification-policy.md`. |
| `--max-workers N` | Cap on workers running at the same time (1-20; default 5). Fast mode caps it at 3. |
| `--review-rounds N` | Correction rounds per task before escalation (0-10; default 3). |
| `--plan-only` | Plan and present the tasks, never dispatch. `oo next` refuses in such a run. |
| `--status` | Print the status of the current run and stop. With no run, `oo` refuses with `no current run`. |
| `--resume` | Check the state's integrity and print the objective, decisions, open tasks and next actions. |

Options are read only at the start of the text; everything from the first other word on is the request, kept verbatim. A bare `--` ends the options.

Frontmatter sets `model: opus` and `effort: xhigh` for the turn that invokes the skill. They do not carry over to later turns. Start the session on Opus (`claude --model opus` or `/model opus`) so that the turns that ingest worker results also run on it. The requested "Opus 5.5 Extra" does not exist; see `references/capability-audit.md`.

## How a run proceeds

The orchestrator (the Opus session) follows `SKILL.md`; `oo` records and enforces. In order:

1. `oo init` creates a run: mode, limits, workspace strategy (worktree with an integration branch, or shared) and warnings.
2. Intake and specification: the orchestrator splits the request into objectives, finds dependencies and conflicts, and writes task specifications (`templates/task.yaml`) to `.opus-inbox/specs.yaml`.
3. `oo plan` validates every specification (nothing is saved if one is invalid), rejects cycles, unknown dependencies and unsafe commands, scores complexity, routes each task (model, agent, verification layers) and prints the waves.
4. `oo next` moves the runnable batch to DISPATCHED and prints one `Agent call:` line per task plus a short prompt that names the task's package file. The orchestrator issues all those calls in one message, then runs `oo started`.
5. Each worker's final message goes to `oo result <ID> --verify --stdin`. `oo` validates the report, runs the task's verification commands itself, checks the changed files against the authorized scope and writes an evidence file.
6. Independent review when the mode and risk require it (`oo review-package`, then `oo review`), then the orchestrator's own quality gate (`oo review ... --integrate`), which must cite evidence for every acceptance criterion.
7. A failing verification or a request for changes leads to a targeted correction (`oo correct`), bounded by the review-round limit. After repeated failure the task is escalated to a stronger model or role, or blocked for the user.
8. `oo integrate` merges the task into the integration branch and re-runs the checks (worktree), or re-runs them in place (shared). Only then is a task COMPLETED.
9. `oo deliver` fast-forwards the branch the run started on (worktree), after the final audit in thorough and maximum mode. `oo final-report` writes `final-report.md` from recorded state; `oo cleanup` removes the worktrees and merged branches `oo` made; `oo learn` records observations and may propose configuration changes for you to approve.

Only COMPLETED counts as done. A worker saying "done" is a claim that `oo` checks. `oo help` lists every command, the state table and the guards:

```bash
node .claude/skills/opus-orchestrator/scripts/oo.cjs help
```

Exit codes of `oo`: 0 success, 1 refused (an invariant, limit or validation failed; the message names the cause and a NEXT step), 2 usage error.

## Configuration

Settings are read from `config/*.yaml` in the skill, then from your project's `.claude/opus-orchestrator/config.yaml` on top (objects merge key by key; lists and scalars are replaced), then from the options given to `oo init`. The result is saved into the run when it is created, so a change applies to runs started afterwards.

Check the configuration (optionally with a project file):

```bash
node .claude/skills/opus-orchestrator/scripts/validate_config.cjs
node .claude/skills/opus-orchestrator/scripts/validate_config.cjs --state-config .claude/opus-orchestrator/config.yaml
```

It prints `CONFIG OK` and exits 0, or prints each error and exits 1. Unknown top-level sections produce a warning.

| File | Key | Default | Meaning |
|---|---|---|---|
| `execution.yaml` | `execution.mode` | `balanced` | fast, balanced, thorough or maximum |
| | `max_workers` | 5 | integer 1-20 |
| | `max_review_rounds` | 3 | integer 0-10 |
| | `max_retries` | 2 | integer 0-10 |
| | `parallel_execution` | true | false runs one task at a time |
| | `persistent_checkpoints` | true | declared; see note below |
| | `independent_verification` | true | false skips independent review for low-risk tasks |
| | `isolation` | `auto` | `auto` or `worktree` use worktrees when possible; any other value (for example `none`) means shared |
| | `command_timeout_seconds` | 600 | per verification command |
| | `improvement.collect_observations` | true | whether `oo learn` records the run's outcomes |
| | `improvement.auto_modify_core_skill` | false | must stay false; validation rejects true |
| | `improvement.min_samples` | 5 | observations a rule needs before it proposes anything |
| | `security.extra_unsafe_patterns` | `[]` | extra regular expressions that mark a command unsafe |
| | `security.protected_paths` | `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, `*secret*` | specifications may not authorize these unless `security_sensitive: true` |
| `models.yaml` | `orchestrator`, `worker_default`, `escalation` | opus, haiku, opus | aliases only: haiku, sonnet, opus |
| | `allowed` | haiku, sonnet, opus | other names are rejected |
| | `relative_cost` | 1, 3, 5 | unitless planning weights, not prices |
| `routing.yaml` | `adaptive`, `prefer_haiku`, `allow_opus_escalation` | true, true, true | see `references/routing-policy.md` |
| | `min_observations` | 5 | outcomes per model and band before observed data replaces heuristics |
| | `heuristic_expected_attempts` | per model and band | stated guesses, not measurements |
| | `roles` | ten roles | agent, whether it writes, and a brief for each |
| `budgets.yaml` | `budget.enabled` | true | |
| | `token_limit`, `cost_limit_usd`, `agent_call_limit` | null | null means no limit set by the skill |
| | `warning_threshold_percent` | 80 | |
| `verification.yaml` | `regression_command` | null | shell command for regression checks and the final audit |
| | `modes.<mode>` | see `references/verification-policy.md` | max_parallel, independent_review, regression, final_audit, reviewers_high_risk |
| `compaction.yaml` | `context.mode` | `balanced` | aggressive targets 0.40, balanced 0.60, custom uses `target_utilization` |
| | `target_utilization` | 0.60 | strictly between 0 and 1 |
| | `checkpoint_before_compaction` | true | |
| | `max_resume_lines` | 120 | |
| | `utilization_max_age_seconds` | 600 | an older reading is ignored |

`persistent_checkpoints` is a declared setting that validation accepts; the code writes state and `checkpoint.yaml` after every change regardless of it.

`verification.regression_command` is null in the shipped configuration. Until you set it, the regression runs and the final audit that thorough and maximum mode ask for do not happen; `oo deliver` says so. Example project file:

```yaml
verification:
  regression_command: 'npm test'
```

Environment variables read by the scripts: `OPUS_ORCH_PROJECT_DIR` (project root; default the current directory), `OPUS_ORCH_STATE_DIR` (state directory), `OPUS_ORCH_HOME` (home directory for `install.cjs --user` and for finding user-level agents) and `OPUS_ORCH_SHELL` (verification shell).

## Where state lives

All run state is under `.claude/opus-orchestrator/` of the project, which `oo` creates with a `.gitignore` that ignores everything in it. `oo` is its only writer; Claude Code's file tools cannot write below `.claude`, which is why the orchestrator drafts specifications and reports in the inbox `.opus-inbox/` (also git-ignored) and passes them to `oo`.

```text
.claude/opus-orchestrator/
  current                  id of the current run
  config.yaml              your project overrides (you create it)
  context.json             last context-utilization reading
  observations.jsonl       observations across runs
  proposals/               improvement proposals
  runs/<run id>/
    run.json               objective, options, config snapshot, usage, decisions, authorizations
    tasks/<ID>.json        one record per task, with history and evidence
    specs/<ID>.yaml        the specification as planned
    packages/              worker and reviewer packages
    reports/               worker reports as accepted
    reviews/               review reports
    evidence/              verification, integration and final-audit output
    snapshots/             file snapshots taken at dispatch (shared workspace)
    events.jsonl           append-only event log
    checkpoint.yaml        rewritten after every change
    final-report.md        written by oo final-report
    worktrees/integration  the integration worktree (worktree strategy)
```

Every file is written atomically with a `.bak` copy of the previous version; `oo resume` restores a damaged file from it. Inspect state without changing it:

```bash
node .claude/skills/opus-orchestrator/scripts/manage_state.cjs show [<ID>]
node .claude/skills/opus-orchestrator/scripts/manage_state.cjs transitions
node .claude/skills/opus-orchestrator/scripts/manage_state.cjs integrity
node .claude/skills/opus-orchestrator/scripts/manage_state.cjs events --tail 20
```

## Hooks and the status-line bridge

Invoking the skill registers two hooks from its frontmatter for the rest of the session. Both always exit 0 and never block.

- `PreCompact` (`scripts/hooks/pre_compact.cjs`): when a run has unfinished tasks it writes a fresh checkpoint and prints instructions that Claude Code adds to the compaction summary: keep the run id, the state is on disk, run `oo resume` afterwards.
- `SessionStart` with matcher `compact` (`scripts/hooks/session_start.cjs`): after a compaction it prints the resume summary of the unfinished run, which Claude Code adds to the context. It also prints for source `resume`, though the frontmatter registers only the `compact` matcher.

Neither hook can start a compaction. The optional status-line bridge, `scripts/hooks/statusline_bridge.cjs`, is not registered automatically. A model cannot read context utilization, but the status line receives `context_window.used_percentage`; the bridge stores it in `context.json` so that `oo context` and `oo status` can show it, and prints one short line (`<model> | ctx NN%`). Setting it as your status line replaces whatever your current status line prints. See the status line documentation (code.claude.com/docs/en/statusline) for how to register a command. Without the bridge `oo context` reports utilization as unknown; you can record a figure you read yourself:

```bash
node .claude/skills/opus-orchestrator/scripts/oo.cjs context --utilization 55%
```

Above the target, the orchestrator reaches a safe point (no worker in flight), runs `oo checkpoint` and asks you to run `/compact`. The hooks and the bridge have been tested only with simulated hook input (see "Verification status").

## Headless use

The live run used nested headless sessions, with a budget cap, like this (the form recorded in `validation/live/README.md`):

```bash
claude -p "/opus-orchestrator --status" --output-format json --max-budget-usd 2 ...
claude -p "/opus-orchestrator --mode balanced --max-workers 3 <request text>" --model opus --max-budget-usd 8 ...
```

The `...` stands for the flags that run needs and that are not specific to this skill: `--strict-mcp-config`, `--permission-mode acceptEdits` and tools allowed on the command line. In Git Bash on Windows, `MSYS_NO_PATHCONV=1` kept the leading slash of the skill command from being rewritten. Dollar cost and whole-tree token usage exist only in the JSON result of a headless run (`total_cost_usd`, `modelUsage`); inside the session `oo` reports cost as not measured. User-level plugins and hooks stay active in nested sessions; in the live run another plugin's hook rejected the first `oo` call of two sessions.

## Testing

Run the whole suite, or only the files whose names contain a filter:

```bash
node .claude/skills/opus-orchestrator/scripts/run_tests.cjs
node .claude/skills/opus-orchestrator/scripts/run_tests.cjs yaml
```

It runs every `tests/*.test.cjs` with `node --test` and exits 0 only when all passed. Run the simulated demonstration, which drives `oo` through the eleven-step scenario of the specification (two independent tasks run together, a dependent task, a documentation task, an acceptance test that fails first, a correction cycle, integration, final report) in a temporary copy of `demo/project`:

```bash
node .claude/skills/opus-orchestrator/scripts/demo.cjs          # shared workspace
node .claude/skills/opus-orchestrator/scripts/demo.cjs --git    # worktree strategy, real branches and merges
node .claude/skills/opus-orchestrator/scripts/demo.cjs --keep   # keep the temporary directory
```

The demonstration prints, in its first lines, that its workers and reviewers are scripted code. No model is called and no agent is launched; what is real is `oo`, the state it persists, the verification commands it runs, the final report and (with `--git`) git. Exit 0 means four tasks COMPLETED and a final report of COMPLETE; 1 means the scenario failed and the directory is kept; 2 is a usage error.

Two smaller tools: `scripts/schedule_tasks.cjs <specs.yaml> [--max-workers N]` validates specifications and prints the waves and the critical-path order, and `scripts/verify_results.cjs result|review|correction <file> --spec <spec.yaml>` validates a report against its specification. `schedule_tasks.cjs` expects documents separated by `---`; unlike `oo plan` it does not accept a file that is one YAML list.

## Verification status

Taken from runs made while writing this document (2026-11-16, Windows 11, Node 26.12.1, git 2.56.0, Claude Code 2.1.302) and from the recorded live run in `validation/live/`. Nothing here is a claim about untested behaviour.

| Kind | What | Result |
|---|---|---|
| Unit and module tests | 439 tests in 25 files, run with `run_tests.cjs`: library modules (yaml, state machine, spec, routing, scheduler, security, verify, reports, budget, checkpoint, store, config, improve, gitops against real temporary git repositories), installer, hooks, the `oo` command line | 439 passed, 0 failed, about 25 seconds |
| Simulated-agent tests | 31 of those 439 are named `simulated-agent:`. They drive `oo` with workers and reviewers that are test code feeding YAML reports; `tests/e2e_simulated.test.cjs` runs `demo.cjs` in both workspace strategies. The `demo.cjs` runs themselves: shared workspace and `--git` | All passed; both demo runs exit 0 with four tasks COMPLETED. This shows that the state machine, verification, correction and integration work when fed well-formed reports. It does not show that real agents produce them. |
| Live Claude Code integration | 3 headless sessions with real subagents (see below) | Observed and not observed steps listed below |
| Manual verification | Commands run by hand: `oo help`, `oo doctor`, `oo version`, `install.cjs --validate` and `--dry-run` (project, user, agents-only), `validate_config.cjs`, `schedule_tasks.cjs`. From the live setup, observed in the build session only and not saved as evidence: tool versions, `install.cjs --validate` exit 0 on the installed copy, the fixture's 11 of 11 failing tests before the run | As described |
| Untested | See the list under "Not tested live" below | Not tested |

The hook tests use simulated hook input, and the test files of the `oo` command line use a temporary project and an empty home directory so that nothing in the real project or home is touched.

### The live run

Real headless Claude Code sessions with real subagents, on a disposable project without git, copied from `demo/project`. Evidence is in `validation/live/` (`README.md` has the details). That folder sits at the root of the repository the skill was built in, outside the skill folder, so an installed copy does not contain it.

| Session | Result |
|---|---|
| 1. `/opus-orchestrator --status` | The skill was found and ran from the slash command although it has `disable-model-invocation: true`; `$ARGUMENTS` and `${CLAUDE_SKILL_DIR}` resolved. The first `oo` call was rejected by another plugin's hook; `oo`'s answer (`no current run`) is evidenced only by the session's result text. 3 turns, `total_cost_usd` 0.555, model `claude-opus-5-5`. |
| 2. same, started with `--model haiku` | `modelUsage` lists only `claude-opus-5-5`: the skill's `model: opus` took over the invoking turn. A later turn after the skill's turn was not tested. 3 turns, `total_cost_usd` 0.368. |
| 3. full orchestration of the demonstration request, `--mode balanced --max-workers 3` | Four tasks (slugify, wordcount, summarize, README) all COMPLETED; slugify had one correction round. 5 subagents spawned, 5 completed, 0 failed, all `opus-implementer` on `claude-haiku-5-5`, started in the background; the project's agents were found, so the `general-purpose` fallback was not needed. `oo status`: delivered, 5 agent calls, 5 verification runs, 78,233 worker tokens from completion notices. Project tests afterwards: 16 of 16. |

The eleven steps of the specification's end-to-end demonstration, as observed in session 3:

| Step | Observed live? |
|---|---|
| 1. Interpret the request | Yes |
| 2. Create specifications | Yes (4 specifications, 4 `planned` events) |
| 3. Build the dependency graph | Yes |
| 4. Assign workers | Yes (opus-implementer on haiku for all four) |
| 5. Execute independent tasks concurrently | Yes (one dispatch holding two tasks; five agents in the background) |
| 6. Run verification | Yes (5 verification runs) |
| 7. Detect the failing test | **No.** The orchestrator found the acceptance test while reading the project and put it into the task's verification commands, so the worker satisfied it first time; no verification run failed live. Detection of a failing test by `oo verify` is shown only by the simulated demo and the automated tests. |
| 8. Request a targeted correction | Yes, from review: the orchestrator's own review of slugify requested a change and a correction followed |
| 9. Reverify the result | **Partly.** `oo` re-ran the task's verification after the correction, but that was the command that had passed before, so it could not detect the corrected defect; the orchestrator's second review confirmed the fix. (Correction requests can now carry `verification_commands` that `oo verify` runs in that round; that change is covered by automated tests, not by a live run.) |
| 10. Integrate approved work | Yes (all four COMPLETED, `deliver` event) |
| 11. Evidence-backed final report | Yes (overall COMPLETE, cost stated as not measured) |

Measured cost, from the session results only: session 3 `total_cost_usd` 2.53 for the whole tree (`claude-opus-5-5` 2.51, `claude-haiku-5-5` 0.02); the three sessions together 3.46. No comparison with any other way of doing the same work was measured, so no saving is claimed. These are the only cost figures in this documentation.

Defects the live run found, since fixed and covered by automated regression tests (`tests/harden.test.cjs`), not re-run live: worker reports rejected as invalid YAML (unknown backslash escapes in double-quoted strings are now kept literally; worker and reviewer packages ask for single-quoted strings and forward slashes; an unparsable report is refused with the line number and an instruction to resend), a corrected defect that `oo verify` could not re-check (a correction can carry `verification_commands`), and a file listed twice in the final report (reported absolute paths are made project-relative).

### Not tested live

- The worktree strategy with real agents (`isolation: worktree`), including where Claude Code places agent worktrees. The live run used a project without git. It is covered by automated tests against real temporary repositories and by the simulated demo with `--git`.
- Independent review by a real `opus-reviewer` agent. In balanced mode none of the four tasks required one.
- The `PreCompact` and `SessionStart` hooks from the skill frontmatter firing on a real compaction. No compaction happened in the live sessions. The hook scripts are covered by tests with simulated hook input.
- The status-line bridge in a real status line.
- `--resume` across two real sessions, budget limits, escalation to Opus workers, external-side-effect holds and improvement proposals in a live session. Each is covered by automated tests only.
- Agent teams: not used by the skill and not tested.

Also not exercised live, from this document's own checks: the changes made after the live run (tolerant YAML escapes, single-quote instructions and the resend refusal, correction `verification_commands`, project-relative reported paths, self-implemented task worktrees under `.opus-inbox/worktrees/`, the final audit in `oo deliver`, the high-risk reviewer count, deduplicated `oo learn`, `oo context` source recording and `oo authorize` raising rules). They are in the automated suite only.

The skill should not be called production-ready: critical paths named above have not passed a live test.

## Limitations

Cost, tokens and context

- **Cost is not measurable in-session.** Dollar cost and whole-tree token usage appear only in a headless run's JSON result. `oo` reports cost as "not measured" unless you record a figure with `oo usage --cost <USD>`, and a `cost_limit_usd` is not enforced unless a cost has been recorded. The orchestrator's own token use is not measured. Worker token counts come from completion notices (`--tokens N`); a `token_limit` is enforced only after tokens have been recorded. The agent-call limit is always enforced.
- **Context utilization and compaction.** No model or skill can read context utilization or start a compaction. `oo context` knows a figure only from the status-line bridge (if you set it up) or from one you give it, and ignores a reading older than 600 seconds by default. Compaction is yours (`/compact`) or Claude Code's own. The hooks preserve the run id and restore a summary; they do not prevent a compaction, and after one the orchestrator must run `oo resume`.
- **The model setting applies to the invoking turn only.** `model: opus` and `effort: xhigh` hold for the turn that invoked the skill (confirmed live: a session started on Haiku ran that turn on `claude-opus-5-5`). Later turns run on the session's model, so start the session on Opus. If the orchestrator finds it is not an Opus model it is told to say so.
- Worker models are chosen per Agent call by `oo`; the agents' own `model: haiku` frontmatter is a default.

Specifications, reports and commands

- **The YAML subset.** `oo` reads a documented subset: block mappings and sequences, plain, single- and double-quoted scalars, numbers, booleans, null, comments, `|` and `>` block scalars, single-line flow collections. Anchors, aliases, tags, tab indentation, multi-line flow or plain scalars and duplicate keys are errors. Quoting pitfalls that change meaning: an unquoted `: ` inside a list item turns it into a mapping (`oo` rejects it); an unquoted ` #` silently drops the rest of the line; a value starting with `*`, `&`, `!`, `[` or `{` is read as an alias, anchor, tag or collection. Unknown backslash escapes in double-quoted strings are now kept literally, but single quotes are the safe choice for paths and regular expressions, and the worker packages ask for them.
- **Command safety is a guard, not a sandbox.** Verification and correction commands are matched against patterns for destructive or publishing commands (`git push`, `git reset --hard`, `git clean`, `--force`, `sudo`, piping a download into a shell, `rm -rf` of a root, home or `.`, `npm publish`, `docker push`, `terraform apply`, `kubectl apply` and similar) plus your `security.extra_unsafe_patterns`. A command that is allowed runs with all the rights of your user. An obfuscated command, or a script that does the damage itself, is not caught: for example `python -c` calling `shutil.rmtree`, or a command decoded and evaluated at run time, passes the check.
- **Secret redaction has gaps.** `oo` redacts private-key blocks, `Bearer` tokens, tokens with well-known prefixes (such as `sk-`, `ghp_`, `AKIA`, `AIza`), long mixed-case tokens and assignments whose name contains KEY, TOKEN, SECRET, PASSWORD or PASSWD, in what it records (reports, reviews, evidence output, commands). It does not redact a password inside a URL, a value under another name (`auth=...`, `pw=...`), a `password: value` line in lower case, basic-auth headers, short numeric values or lowercase hexadecimal strings. It does not scan files that workers write, and it does not stop a worker or the orchestrator from seeing a secret. `protected_paths` only keeps matching files out of a specification's authorized files. Keep secrets out of requests and out of the project files that workers read.
- **Shared-workspace scope checks are snapshot based.** Without git, `oo` stores a snapshot of file sizes and modification times at dispatch and compares at verification. A change inside another task's scope that overlapped in time is attributed to that task and ignored, so a worker's out-of-scope edit that happens to fall inside a concurrent task's scope is not reported. The comparison uses size and modification time, not content. In the worktree strategy the scope is the git diff of the worker's commit instead.
- **Reviewer and researcher roles are read-only by instruction and tool list.** The reviewer agent has `Bash` in its tools, so "does not modify files" rests on its instructions as well as on the tool list.

Environment

- **Hooks from other plugins.** Other plugins' hooks run in the same session and can reject or alter a call. In the live run another plugin's hook rejected the first `oo` call of two sessions; the session then retried. This skill's own hooks are registered for the session only after the skill is invoked, and only fire on a compaction.
- **Agents need installation outside the skill folder.** `.claude/agents/` or `~/.claude/agents/`, and a Claude Code restart if that directory is new. Without them the `general-purpose` fallback is used.
- **`.claude` is write-protected for Claude Code's file tools.** Run state is therefore written only by `oo`, and drafts go to `.opus-inbox/`. A task the orchestrator does itself in the worktree strategy uses a worktree under `.opus-inbox/worktrees/`.
- A run holds one state lock while a command works. `oo deliver` runs the final audit while holding it, and another `oo` process treats a lock older than 30 seconds as stale, so do not start other `oo` commands during a long audit. This is read from the code, not tested.
- `oo next` still prints the worker model in its heading for a task the orchestrator does itself (`DO YOURSELF`); no agent is launched for it.
- Agent teams are experimental and off by default in Claude Code; the skill does not use them.
- Untested scenarios: everything under "Not tested live".

## Layout of the skill

```text
SKILL.md                  the orchestrator's instructions and frontmatter
README.md  CHANGELOG.md  VERSION
config/                   models, routing, budgets, verification, compaction, execution (YAML)
agents/                   opus-researcher, opus-implementer, opus-tester, opus-reviewer, opus-debugger
templates/                task, agent-result, review-report, correction-request, checkpoint, improvement-proposal
references/               architecture, routing, execution, verification and recovery policies, capability audit
scripts/                  oo.cjs (the CLI), install.cjs, validate_config.cjs, manage_state.cjs,
                          schedule_tasks.cjs, verify_results.cjs, run_tests.cjs, demo.cjs,
                          hooks/ (pre_compact, session_start, statusline_bridge), lib/ (the modules)
tests/                    the automated suite
demo/                     fixture project, request, specifications and scripted workers for demo.cjs
```
