# Fable Orchestrator

Fable Orchestrator turns multi-step software requests into task contracts, routes them to workers, and tracks verification, review, corrections, and delivery. V1.1 is an experimental release candidate for supervised use in trusted repositories.

## Install

Use Node.js 18 or later and Git 2.36 or later for worktree isolation. The CLI checks the Git version before creating a native or managed worktree. Explicit shared mode works without that version requirement, with serialized tasks and no immutable Git delivery guarantee. On Windows, use Git Bash for project verification commands. From this directory, install into an existing Claude Code project:

```bash
node .claude/skills/fable-orchestrator/scripts/install.cjs --project "/path/to/project" --dry-run
node .claude/skills/fable-orchestrator/scripts/install.cjs --project "/path/to/project"
```

The installer registers agents as `fable-orchestrator-<role>` and records source-owned files in an installation manifest. It preserves edited or unrelated files and leaves any legacy generic agents in place. Stop active Fable runs before upgrading. If a legacy installation conflicts with owned paths, reconcile the reported files or install into a clean target. The skill's [installation guide](.claude/skills/fable-orchestrator/README.md) covers dry runs, updates, and uninstall.

## Run

Open the target project in Claude Code and start with a plan:

```text
/fable-orchestrator --plan-only Add CSV export, test quoting and escaping, and update the usage guide.
```

Review the tasks and commands, then use `/fable-orchestrator --resume`. For native isolated work, the orchestrator records the worktree and agent identity from the host before accepting the worker's report. Use Git-backed isolation for commit verification and exact delivery. Shared mode processes one task at a time and changes the project in place.

## Verify

```bash
node --test .claude/skills/fable-orchestrator/scripts/tests
node --test .agents/skills/fable-orchestrator/scripts/tests
```

The CLI tests use disposable repositories and worktrees, with workers and reviewers simulated. Claude Code is the integration target. The Codex role definitions and skill preview are experimental, and no Codex execution adapter is included.

- [Architecture](ARCHITECTURE.md)
- [Security and host permissions](SECURITY.md)
- [Known limitations](LIMITATIONS.md)
- [Pending live validation procedure](LIVE-VALIDATION.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
