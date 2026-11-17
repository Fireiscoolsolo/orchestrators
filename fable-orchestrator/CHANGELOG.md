# Changelog

## V1.1 candidate

- Pin task verification, reviews, integration checks, and delivery to Git candidates.
- Match worker reports to recorded attempts and assigned worktrees. Preserve dirty checkouts and uncertain in-flight work.
- Harden local process locks and recover state event logs after interrupted writes.
- Validate configuration and plans before accepting them. Count independent reviewer dispatches against the run budget.
- Reduce the command environment, restrict named reviewer and research tools, and defer explicitly external actions to the host.
- Namespace installed Claude Code roles and track installer-owned files.
- Add regression cases and clarify the supported Claude Code workflow and experimental Codex files.

## V1.0.0

Initial experimental release of the Claude Code orchestration skill and CLI.
