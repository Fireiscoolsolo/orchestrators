# Changelog

## v1.2.0 - 2026-11-22

Audit repairs (2026-11-21):

- `fo verify --reverify` is accepted only from REVIEWING or CORRECTION_REQUIRED and always opens a new cycle that consumes a correction round. It is refused in IMPLEMENTED and VERIFYING, where it previously kept manual checks while skipping the shared content comparison.
- Manual checks record the candidate commit or shared content snapshot they inspected. Verification fails a check recorded against other content, including content changed and then restored. Manual checks recorded by an earlier version fail closed and must be recorded again.
- Copies of reports, reviews, corrections and review diffs are written only after their state commit. State records each file's SHA-256 digest, and command logs are named per operation, so output from a failed or interrupted commit is never named by state. An unwritable review diff retires its unissued dispatch and returns the agent call. The shared dispatch baseline is bound by digest.
- Retrying `fo next` after a failed or interrupted commit takes over the unmodified run worktree it had created; anything else is refused with WORKTREE_CONFLICT.
- In a shared workspace, a started task that is BLOCKED or waiting for a retry keeps the workspace until it completes, fails or is cancelled. Before this, another task could run and integrate in between, and the first task's retries then failed their scope check on the other task's files.
- Interrupted verification, integration and delivery operations record their host; `fo reconcile` refuses an operation started on another host.
- `scripts/run-tests.cjs` runs the suite from an explicit file list and fails when no test files are found.

## v1.1.0-rc.1 - 2026-11-18, prerelease

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
