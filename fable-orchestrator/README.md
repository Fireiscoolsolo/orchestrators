# Fable Orchestrator

Fable Orchestrator takes a multi-part software request, builds a dependency graph of task contracts, routes tasks to worker agents, runs verification, and integrates reviewed changes. This experimental release preserves the implementation before the planned reliability and security hardening.

## Install and run in Claude Code

The existing installation guide specifies Node.js 18 or newer, Git 2.31 or newer for worktree isolation, and Claude Code 2.1.302 or newer. Claude Code 2.1.302 is the host version used in the original validation. Bash or Git Bash is used for verification when available.

From the repository root, install into an existing project with:

```bash
node fable-orchestrator/.claude/skills/fable-orchestrator/scripts/install.cjs --project "/path/to/project"
```

Add `--dry-run` to preview the files the installer would copy. Restart Claude Code if the installer created the skill or agent directories, then open the target project and invoke the skill:

```text
/fable-orchestrator --plan-only Add CSV export and update its tests.
```

Review the plan and its commands before using `/fable-orchestrator --resume`. For additional options and configuration, see the [Claude Code skill guide](.claude/skills/fable-orchestrator/README.md).

## Tests

From the repository root:

```bash
node --test fable-orchestrator/.claude/skills/fable-orchestrator/scripts/tests
node --test fable-orchestrator/.agents/skills/fable-orchestrator/scripts/tests
```

The tests use Node.js and disposable Git repositories. Both commands exercise the same CLI code with simulated workers.

## Codex files

The [.agents skill](.agents/skills/fable-orchestrator/SKILL.md) and [.codex agent definitions](.codex/agents/) preserve the existing partial Codex integration. The accompanying CLI and installer still use Claude Code paths. The installation instructions above are for Claude Code.

See [known limitations](LIMITATIONS.md) for the reliability and host-compatibility findings.
