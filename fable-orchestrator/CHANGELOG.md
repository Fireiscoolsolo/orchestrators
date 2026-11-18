# Changelog

## v1.1.0 candidate, unpublished

- Recover lost independent reviewers through explicit liveness observations and abandonment. Preserve dispatch history, reject late reports, and bind replacement reviews to verified candidates.
- Require Git 2.36 or newer before worktree operations, with actionable compatibility errors and explicit shared-mode fallback.
- Recheck shared workspace content throughout verification, review, integration, and delivery. Stop after failed setup and invalidate evidence after command mutations.
- Recover crashed lock reapers through atomically published owner records while protecting live owners.
- Synchronize reviewer identity instructions and exact-candidate inspection guidance. Extend deterministic regression coverage and keep live-host evidence separate.

### Earlier V1.1 hardening

- Pin task verification, reviews, integration checks, and delivery to Git candidates.
- Match worker reports to recorded attempts and assigned worktrees. Preserve dirty checkouts and uncertain in-flight work.
- Harden local process locks and recover state event logs after interrupted writes.
- Validate configuration and plans before accepting them. Count independent reviewer dispatches against the run budget.
- Reduce the command environment, restrict named reviewer and research tools, and defer explicitly external actions to the host.
- Namespace installed Claude Code roles and track installer-owned files.
- Add regression cases and clarify the supported Claude Code workflow and experimental Codex files.

## V1.0.0

Initial experimental release of the Claude Code orchestration skill and CLI.
