# Capability audit

What Claude Code provides for the things this skill needs, classified as the specification asks (Part 2.1), with where each finding comes from. Findings come from three kinds of source, named in the table:

- **docs**: the Claude Code documentation at code.claude.com/docs/en (the page is named), read during the capability research for this skill;
- **local**: a command run on the build machine (`claude --version`, `claude --help`; Claude Code CLI 2.1.302, Windows 11);
- **live**: the real Claude Code run recorded in `validation/live/` (three headless sessions with real subagents).

Classes: **NATIVE** (Claude Code provides it, the skill uses it), **IMPLEMENTABLE** (not provided; the skill implements it in `oo`), **FALLBACK** (not available as wanted; the skill uses a substitute), **UNAVAILABLE** (not possible for this skill; the skill states the limit and works around it). Where a capability has two parts, both classes are given.

## Model substitution

| Requested | What exists | What the skill uses |
|---|---|---|
| "Opus 5.5 Extra" (orchestrator) | Nothing by that name appears in the model documentation (docs: model-config). The `opus` alias resolves to Opus 5.5, `claude-opus-5-5` (docs: model-config; live: `modelUsage` showed `claude-opus-5-5`). Effort levels are `low`, `medium`, `high`, `xhigh`, `max` (docs: model-config, skills). | `model: opus` with `effort: xhigh` in the skill frontmatter. "Extra" is mapped to the highest effort level below `max`; this is a choice, not a model. Two parts of the research were not read in full (a part of the model-config page, and the `ultracode` setting), so absence of an "Extra" model is established for the pages read, not for every page. |
| "Haiku 5.5" (workers) | The `haiku` alias resolves to Haiku 5.5, `claude-haiku-5-5` (docs: model-config; live: the five worker subagents ran on `claude-haiku-5-5`). | `model: haiku` in the agent definitions and `haiku` as `models.worker_default`. No substitution is needed; only the alias is used. |
| `sonnet` | The alias resolves to Sonnet 5.5 (docs: model-config). The full identifier was not observed. | `sonnet` is an allowed alias and an escalation step. No Sonnet worker ran in the live run. |

`config/models.yaml` accepts only `haiku`, `sonnet` and `opus` and rejects any other name, so a model identifier cannot be invented through configuration. `oo` passes the alias on each `Agent call:` line. The skill does not claim that an unsupported model is active: if the invoking session is not an Opus model, `SKILL.md` tells the orchestrator to say so.

## Classification of the Part 2.1 capabilities

| # | Capability | Class | Finding and source | What the skill does |
|---|---|---|---|---|
| 1 | Installed Claude Code version | NATIVE | `claude --version` (local: 2.1.302) | `oo doctor` prints it |
| 2 | Supported skill structure | NATIVE | A skill is a folder with `SKILL.md` in `.claude/skills/` (project) or `~/.claude/skills/` (user) (docs: skills). Live: the installed project-level skill was discovered | `SKILL.md` plus supporting files, installed by `scripts/install.cjs` |
| 3 | Skill invocation behaviour | NATIVE | A skill is invoked as `/skill-name arguments` (docs: skills). Live: the slash command ran the skill although `disable-model-invocation: true`, and `$ARGUMENTS` and `${CLAUDE_SKILL_DIR}` were substituted (the first `oo` call shows the installed skill path and the arguments) | `/opus-orchestrator [options] <request>`; the model cannot start it by itself |
| 4 | Skill frontmatter | NATIVE | Supported fields include `name`, `description`, `argument-hint`, `disable-model-invocation`, `model`, `effort`, `hooks` (docs: skills). `allowed-tools` is a per-turn pre-approval and does not restrict | `SKILL.md` sets `name`, `description`, `argument-hint`, `disable-model-invocation`, `model`, `effort` and `hooks`; `install.cjs --validate` checks name, description and structure |
| 5 | Subagent mechanisms | NATIVE | Definitions in `.claude/agents` and `~/.claude/agents` with `name`, `description`, `tools`, `model`, `permissionMode`, `isolation`, `background` and more; the Agent tool launches them (docs: sub-agents). Live: 5 subagents of type `opus-implementer` spawned, completed, 0 failed | Five agents in `agents/`, copied by the installer; `oo next` prints the Agent calls |
| 6 | Available model identifiers | NATIVE | Aliases `opus`, `sonnet`, `haiku`, full IDs, `inherit` (docs: model-config, sub-agents). Live: `claude-opus-5-5` and `claude-haiku-5-5` appeared in `modelUsage` | Aliases only (see Model substitution) |
| 7 | Supported Opus configuration | NATIVE for `opus` and effort; UNAVAILABLE for "Extra" | `model: opus`, `effort: low`, `medium`, `high`, `xhigh`, `max` (docs: skills, model-config). No "Opus 5.5 Extra" (docs: model-config) | `opus` at `xhigh`; the substitution is documented above |
| 8 | Supported Haiku configuration | NATIVE | `model: haiku` per subagent (docs: sub-agents); live: workers ran on `claude-haiku-5-5` | Workers default to haiku; routing can raise a task to sonnet or opus |
| 9 | Agent-team availability | UNAVAILABLE by default | Experimental, off by default, enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, not spawned in `-p` mode (docs: agent-teams, env-vars). Not tested | Not used. Subagents plus `oo`'s own state do the coordination |
| 10 | Parallel execution | NATIVE for running; IMPLEMENTABLE for scheduling | Several Agent calls in one message run in parallel and can run in the background (docs: sub-agents). Live: one dispatch held two tasks and five agents ran in the background | `oo next` decides which tasks may run together (dependencies, scope, `max_workers`); the orchestrator issues them in one message |
| 11 | Nested delegation | NATIVE, not used | Subagents can nest up to three layers (default; `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) (docs: sub-agents, env-vars). Not tested | Workers are leaves: no agent definition lists a tool for launching subagents |
| 12 | Git worktree support | NATIVE for agent isolation; IMPLEMENTABLE for integration | `isolation: worktree` gives a subagent its own worktree; plain `git worktree` works (docs: sub-agents). Live: **not tested** (the live project had no git) | `oo` creates an integration worktree and branch, verifies in the worker's worktree, merges and delivers with fast-forward only. Covered by tests against real temporary repositories |
| 13 | Tool permission controls | NATIVE | `tools` allowlist and `disallowedTools` denylist per agent, `permissionMode` values, and `.claude` as a protected directory for file-tool writes with no exemption for skills, agents or settings (docs: sub-agents, permission-modes#protected-paths) | Agents list their tools (researcher and reviewer have no Edit or Write); run state is written only by `oo`; drafts go to the inbox. The reviewer's `Bash` makes its read-only status partly a matter of instruction |
| 14 | Agent lifecycle hooks | NATIVE | 33 hook events, among them `PreCompact` (matchers `manual`, `auto`; stdout becomes summary instructions) and `SessionStart` (matchers `startup`, `resume`, `clear`, `compact`, `fork`; stdout is added to the context); hooks can be registered from skill frontmatter for the rest of the session (docs: hooks, skills). The limits section for skill-scoped hooks was not read. Live: not fired (no compaction) | `PreCompact` writes a checkpoint and asks the summary to keep the run id; `SessionStart` with matcher `compact` prints the resume summary. Other events are not used |
| 15 | Context utilization visibility | UNAVAILABLE to a model or skill; FALLBACK | Only the status line receives `context_window.used_percentage` (docs: statusline, context-window); no model-readable source exists | The optional `scripts/hooks/statusline_bridge.cjs` stores the figure for `oo context`; otherwise the user reports it (`oo context --utilization`). Without either, utilization is "unknown". Bridge not tested in a real status line |
| 16 | Context compaction controls | UNAVAILABLE for the skill; NATIVE for the user | No model or skill can start a compaction. The user has `/compact [instructions]` and settings such as `autoCompactWindow`, `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (docs: model-config, env-vars, context-window). The `DISABLE_COMPACT` entry was not read | State is checkpointed after every change; the hooks (row 14) preserve the run id and restore a summary; above the target the orchestrator asks the user to run `/compact` |
| 17 | Token usage visibility | FALLBACK | Worker token counts arrive in subagent completion notices; the headless JSON result has `usage` and `modelUsage` for the whole tree (docs: headless, cost-tracking; live: 78,233 worker tokens recorded from notices, and per-model tokens in the session result) | `oo result --tokens N` and `oo usage --tokens N` record worker tokens; the orchestrator's own use is "not measured"; a token limit is enforced only after tokens are recorded |
| 18 | API cost visibility | UNAVAILABLE in-session; available in a headless result | `total_cost_usd` and per-model `costUSD` exist only in a headless result (docs: headless, cost-tracking; live: 2.53 for the orchestration session, 3.46 for the three sessions) | Cost is "not measured" in `oo status` and the final report unless a measured figure is recorded with `oo usage --cost`; a cost limit is enforced only then |
| 19 | Persistent execution mechanisms | IMPLEMENTABLE | Nothing in Claude Code keeps a plan or task state between turns except the conversation, which compaction can shorten | `oo` writes run state, events and a checkpoint to disk after every change, restores from backups and resumes (`oo resume`). Resume across two real sessions was not tested live |

Headless operation itself (`claude -p`, `--output-format json`, `--max-budget-usd`, `--model`, `--permission-mode`, `--strict-mcp-config`) is NATIVE (local: `claude --help`; live: used in all three sessions).

## What the skill does for each UNAVAILABLE capability

- **"Opus 5.5 Extra"** (rows 7, model table): not claimed. `opus` at effort `xhigh` is used and named as the substitute. The configuration rejects unknown model names.
- **Agent teams** (row 9): not used; subagents and `oo` provide the coordination. If a future version enables teams by default, nothing in the skill depends on them.
- **Reading context utilization** (row 15): the skill never states a figure it did not get from the bridge or the user, and says "unknown" otherwise. The advice is the same either way: checkpoint, then ask the user to compact at a safe point.
- **Starting a compaction** (row 16): the skill asks the user. It cannot do it, and the hooks cannot prevent one.
- **In-session cost** (row 18): the skill reports "not measured" and makes no cost or saving claim. The only measured cost figures are those of the live run, quoted in `README.md` from `validation/live/README.md`.
- **The skill's model setting beyond the invoking turn** (a limit, not a missing feature): the frontmatter `model` and `effort` apply only to the turn that invoked the skill (docs: skills; live: a session started on Haiku ran that turn on `claude-opus-5-5`). The skill asks that the session itself be on Opus, and tells the orchestrator to say so if it is not.

## Other findings the design depends on

- Agent definitions are discovered in `.claude/agents` and `~/.claude/agents`, not inside a skill folder (docs: sub-agents). A brand-new agents directory needs a Claude Code restart. Live: the agents installed by `install.cjs` were found, so the `general-purpose` fallback was not needed.
- `.claude` is a protected directory for file-tool writes (docs: permission-modes#protected-paths). This is why `oo` is the only writer of run state and why a self-implemented task's worktree is under `.opus-inbox/worktrees/`.
- User-level plugins and hooks stay active in nested sessions (live). In two live sessions another plugin's hook rejected the first `oo` call.

## Unconfirmed

- The skill-scoped hooks limits section of the hooks page was not read.
- The exact key list of a headless result was not observed in the research; the live run saw `total_cost_usd`, `modelUsage`, `permission_denials` and the subagent counts it reports in the README.
- The `DISABLE_COMPACT` and `CLAUDE_CODE_SUBAGENT_MODEL` environment entries were not read directly.
- The full Sonnet 5.5 identifier is not quoted anywhere here because it was not observed.
- Everything listed under "Not tested live" in `README.md`.
