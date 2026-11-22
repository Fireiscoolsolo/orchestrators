# fable-orchestrator

A Claude Code skill that takes an unstructured, multi-part request, turns it into task contracts, delegates each task to a worker agent chosen for its difficulty, verifies every result independently, sends failures back for targeted correction, and integrates only approved work.

The session that runs the skill is the orchestrator. It plans, reviews and decides. A small command-line tool, `fo`, holds the state machine and refuses anything that would skip a step: a task cannot start before its dependencies finish, cannot be approved over a failing check, and cannot be corrected forever.

## Requirements

- Claude Code 2.1.302 or newer (built and tested on 2.1.302; subagents that spawn subagents and `isolation: worktree` are used when present).
- Node.js 18 or newer on PATH. The scripts have no dependencies.
- Git 2.36 or newer for worktree isolation. The CLI enforces this before worktree operations. Without Git it falls back to a shared workspace. On an older Git version, upgrade or explicitly configure `isolation.strategy: shared` and accept its reduced guarantees.
- Verification commands run under bash when it is available (Git Bash on Windows): write them with forward slashes.

## Install

The skill folder is self-contained. Agent definitions inside a skill folder are not registered by Claude Code on their own, so the installer copies them to `.claude/agents/`.

Into a project:

```bash
node .claude/skills/fable-orchestrator/scripts/install.cjs --project /path/to/project
```

For every project on this machine:

```bash
node .claude/skills/fable-orchestrator/scripts/install.cjs --user
```

The installer uses namespaced agent names and records ownership in `.claude/.fable-orchestrator-install.json`. It preserves edited and unrelated files. `--force` can adopt an exact match only. Use `--dry-run` to preview changes and `--uninstall` to remove files that still match the manifest. Restart Claude Code if it discovers these directories for the first time.

Check an installation:

```bash
node .claude/skills/fable-orchestrator/scripts/fo.cjs self-check
```

## Use

```text
/fable-orchestrator Fix the authentication system, add integration tests, and improve dashboard performance.
```

| Option | Meaning | Default |
|---|---|---|
| `--mode fast\|balanced\|thorough\|maximum` | how much review and regression checking | `balanced` |
| `--max-workers N` | upper bound on parallel workers | 5 |
| `--review-rounds N` | correction rounds per task before you are asked | 3 |
| `--plan-only` | stop after the plan; nothing is dispatched | off |
| `--resume` | continue the current run (also after `--plan-only`, an interruption, or a context compaction) | |
| `--status` | print the current run's state | |

Options may appear anywhere in the text. The skill is invoked only when you type it (`disable-model-invocation: true`), because a run spends agent calls. Remove that line from `SKILL.md` if you want Claude to start it on its own.

What happens in a run:

1. **Intake.** The orchestrator reads the project, separates your objectives, and records assumptions. It asks you only about things that change correctness, security, destructive or external actions, or spending.
2. **Plan.** One contract per task: objective, acceptance criteria, file scope, verification commands, dependencies, complexity. `fo plan` validates them, builds the dependency graph and routes each task to a role and model.
3. **Execute.** Independent tasks whose file scopes do not overlap run in parallel, each in its own git worktree. `fo` runs task checks in a fresh checkout of the candidate commit, checks scope, and records the commit and tree. The orchestrator reviews that candidate against each criterion.
4. **Correct.** A failed check or a rejected review produces a targeted correction for a fresh worker. Rounds are bounded.
5. **Integrate and deliver.** Approved work is merged and checked in a detached checkout before the integration branch advances. Delivery verifies the pinned integration commit again and fast-forwards to that commit. Nothing is forced, and your uncommitted changes are left alone.
6. **Report.** `fo final-report` is generated from recorded state and evidence files: what completed, what did not, and why.

## Headless use

```bash
claude -p "/fable-orchestrator --mode balanced <request>" --permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep Agent --output-format json --max-budget-usd 10
```

- Allow the tools on the command line. Allow rules in a project's `.claude/settings.json` are ignored until you have trusted that folder interactively.
- The JSON result reports `total_cost_usd`, per-model usage and subagent statistics, which is the only place dollar cost is measurable.
- In Git Bash on Windows, set `MSYS_NO_PATHCONV=1` or the leading `/` of the command is rewritten into a path.

## Configuration

Defaults live in `config.default.yaml`. Override per project in `.claude/fable-orchestrator/config.yaml` with only the keys you change:

```yaml
integration:
  regression_command: npm test     # run on the merged result according to the mode
budget:
  agent_call_limit: 30             # hard cap on worker and reviewer dispatches
routing:
  tiers:
    light: {model: sonnet, effort: null}   # for example: never use haiku
```

## Where things are

| Path | Contents |
|---|---|
| `.claude/skills/fable-orchestrator/` | the skill: `SKILL.md`, `scripts/`, `agents/`, `templates/`, `references/` |
| `.claude/agents/` | installed agent definitions |
| `.claude/fable-orchestrator/` | runtime state, git-ignored: runs, evidence logs, checkpoints, learning data. Written only by `fo` |
| `.fable-inbox/` | drafts the orchestrator hands to `fo` (task contracts), git-ignored, emptied at the start of each run |

Runtime state and the inbox can contain excerpts of your code and command output. Each ignores itself through its own `.gitignore`; do not commit them.

## Tests

```bash
node .claude/skills/fable-orchestrator/scripts/run-tests.cjs
```

The runner lists `scripts/tests/*.test.cjs` itself and exits non-zero when it finds none, so the result does not depend on how a Node release treats a directory passed to `node --test`. Extra arguments go to `node --test`, for example `--test-reporter=tap`.

The suite covers the YAML subset, contracts, routing, scheduling, worktree ownership, immutable candidates, independent review and reviewer recovery, shared workspace integrity, state and lock recovery, installation, and complete CLI runs in real Git repositories. These tests simulate workers. Read the test runner totals and the release validation report for executed counts and separate live-host evidence.

## Limitations

- Dollar cost and the orchestrator's own token usage are not visible from inside a session. `fo` counts agent dispatches and records worker token counts when they are passed to it; it prints no cost figure.
- Context usage cannot be read and compaction cannot be triggered by a running model. The on-disk checkpoint and `--resume` are the substitute.
- `fo` executes verification commands itself so exit codes cannot be misreported. Claude Code's per-command permission rules therefore see `node ... fo.cjs`, not the individual commands. Review setup, verification, and regression commands before execution. Screening is advisory and command execution inherits the host's filesystem and network access. See `references/verification-policy.md`.
- Hooks from other plugins apply to the orchestrator and to every worker. A hook that rejects the first shell command or the first write to a new file costs each worker an extra turn.
- Agent worktrees start from the repository's default branch. The task prompt makes each worker merge the run's integration branch first; a report whose commit omits an assigned starting commit is rejected.
- Agent teams are not used: they are experimental, off by default, and unavailable in headless mode.
- Quality of decomposition, contracts and reviews depends on the orchestrator model. Run the skill on your most capable model.
- The YAML parser handles the subset the contracts need (mappings, lists, lists of mappings, quoted and block scalars, single-line flow collections), not anchors, tags or multi-line flow collections.

More detail: `references/architecture.md`, `routing-policy.md`, `execution-policy.md`, `verification-policy.md`, `recovery-policy.md`, `capability-audit.md`.
