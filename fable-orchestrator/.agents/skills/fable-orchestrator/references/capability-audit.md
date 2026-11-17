# Capability audit

This audit records the environment used for the original Claude Code validation. **Live** means observed in a Claude Code session, **docs** means checked against the host documentation during that validation, and **local** means inspected on disk.

Classes: `NATIVE` (supported directly), `IMPLEMENTABLE` (built from supported pieces), `FALLBACK` (a supported substitute is used), `UNAVAILABLE` (cannot be done reliably here).

## Environment

| Item | Finding | How |
|---|---|---|
| Claude Code | CLI 2.1.302 | local |
| Runtimes | Node 26.12.1, Git 2.56.0 | local |
| Shell | Git Bash is the CLI's shell tool. It rewrites a leading `/word` argument into a path; `MSYS_NO_PATHCONV=1` prevents that when launching `claude -p "/skill ..."` | live |

## Capabilities

| Capability | Class | Evidence | Effect on the design |
|---|---|---|---|
| Skill directory structure | NATIVE | docs; live: a fresh session listed `fable-orchestrator` among skills and slash commands | `.claude/skills/fable-orchestrator/SKILL.md`, project or user level |
| Skill frontmatter | NATIVE | docs: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, `shell` | Uses `name`, `description`, `argument-hint`, `disable-model-invocation`. No `allowed-tools`: the session's own permissions decide |
| Arguments and substitutions | NATIVE | live: `$ARGUMENTS` reached the skill verbatim; `${CLAUDE_SKILL_DIR}` resolved to the absolute skill path | Options are parsed from the argument text by `fo init` |
| Slash invocation, including headless | NATIVE | live: `claude -p "/fable-orchestrator --status"` ran the skill with `disable-model-invocation: true` | The intended entry point works in both modes |
| Subagent definitions | NATIVE | docs; live: all eight agents registered in every session (8/8) | Fields used: `name`, `description`, `tools`, `model`, `effort`, `color` |
| Agent files inside a skill folder | IMPLEMENTABLE | docs: agents load from managed settings, `--agents`, `.claude/agents/`, `~/.claude/agents/`, plugin `agents/` only | `install.cjs` copies them; a brand-new `agents` folder needs a restart |
| Model identifiers | NATIVE | live: `haiku` -> claude-haiku-5-5, `sonnet` -> claude-sonnet-5-5, `opus` -> claude-opus-5-5, `fable` -> claude-fable-5-1 on CLI 2.1.302 | Routing uses aliases only. The orchestrator model is whatever session invokes the skill |
| Delegation tool | NATIVE | live: tool named `Agent` (listed as `Task` in the session's tool list); parameters `description`, `prompt`, `subagent_type`, `model`, `isolation`, `effort`, `run_in_background` | `fo next` prints exactly these parameters per task |
| Per-dispatch model and effort | NATIVE | live: `implementation-worker` (default sonnet) ran on haiku and on sonnet/medium as dispatched | One agent definition per role serves every tier |
| Nested delegation | NATIVE | live: `opus-executor` on Opus spawned `implementation-worker` on Haiku; session stats `max_depth: 2`, `spawned_by_subagents: 1`. docs: three layers by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) | The execution lead may delegate; it reports `delegations` for the budget |
| Agent teams | UNAVAILABLE as configured | docs: experimental, off unless `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, not spawned in `-p` mode | Not used. Subagents are the delegation mechanism |
| Parallel subagents | NATIVE | live: two Agent calls in one message, both started in the background and overlapped (dispatched 17:28:00, finished 17:28:34 and 17:28:41). docs: 20 concurrent by default | `fo next` returns a batch; the skill issues it in one message |
| Background completion | NATIVE | live: an Agent call returns an acknowledgement; a completion notice follows with the result. Headless `claude -p` keeps taking turns as notices arrive | The skill ends its turn while workers run and resumes on each notice |
| Worktree isolation | NATIVE | live: worktree `.claude/worktrees/agent-<id>` on branch `worktree-agent-<id>`, kept when the agent commits; a nested worker inherits the lead's worktree | Default workspace strategy |
| Worktree base ref | IMPLEMENTABLE | docs: agent worktrees branch from the default branch, not the session's HEAD | Every task prompt starts with `git merge --no-edit <integration tip>`; live: the corrected worker's history shows that merge |
| Lifecycle hooks | NATIVE | docs: `SubagentStart`, `SubagentStop`, `PreToolUse` and others; live: hook events appear in the stream | Not used by the skill. Hooks from other plugins can apply |
| Structured tool output | FALLBACK | An agent returns free text. Headless output formats (`json`, `stream-json`, `--json-schema`) are native but cover only the top-level session | Workers end with a YAML report; `fo report` parses and validates it |
| Token usage | NATIVE for workers, UNAVAILABLE for the orchestrator in-session | live: each completion notice carried the agent's token count, tool uses and duration. The session's own usage is visible only in a headless result record (`usage`, `modelUsage`) | `fo report --tokens N`; no figure is ever estimated |
| Dollar cost | UNAVAILABLE in-session, NATIVE headless | live: `total_cost_usd` in the `claude -p --output-format json` result; `--max-budget-usd` exists | In-session control is the agent-call limit; `cost_limit_usd` is reported as not enforceable |
| Context utilization | UNAVAILABLE | No tool exposes it to a running model | FALLBACK: `checkpoint.yaml` rewritten after every change |
| Programmatic compaction | UNAVAILABLE | Compaction is automatic or user-invoked; the window is set by `--autocompact` and by `autoCompactWindow` on an agent | FALLBACK: `fo resume` restores request, decisions, states and open actions |
| Permission controls | NATIVE | live: permission modes and `--allowedTools` work; allow rules in a project's settings are ignored until the folder is trusted interactively; shell commands still need an allow rule in `acceptEdits` mode | Documented under headless use. The skill never asks for or widens permissions |
| Protected paths | NATIVE constraint | live: a file-tool write to `.claude/fable-orchestrator/` was refused as "a sensitive file"; a write to a project-root folder succeeded | Run state stays under `.claude/` where only `fo` writes; the orchestrator's drafts go to `.fable-inbox/` |
| Persistent state | IMPLEMENTABLE | Files written atomically by `fo`; verified by automated tests and by a run that spanned two sessions | `.claude/fable-orchestrator/runs/<id>/` |
| Resuming a finished agent | NATIVE | docs and live tool list: `SendMessage` with the agent id | Not relied on. A correction goes to a fresh worker that starts from the previous commit |
| Heredocs in the shell tool | NATIVE with a caveat | live: a 13 KB chained command ending in a heredoc failed to parse inside the shell tool although `bash -n` accepts the same text; standalone heredocs worked in every other case | Contracts travel in a file; heredoc commands are kept standalone, with a file fallback |

## What the audit changed

- Scripts are Node, not Python.
- Agents are installed by a script because the skill folder is not an agent source.
- Run state and orchestrator drafts live in different places because of the protected path.
- The execution lead delegates natively; no "plan and hand back" workaround was needed.
- Worker token counts are recorded from completion notices; cost is never printed in-session.
- Context metrics and compaction are replaced by an on-disk checkpoint.
- Agent teams are documented as unavailable instead of being simulated.
