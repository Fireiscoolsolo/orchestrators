# Contributing

Make shared CLI changes in `.claude/skills/fable-orchestrator/` and mirror them to the copy in `.agents/skills/fable-orchestrator/`. Keep host-specific skill entry points separate. Add focused regression tests for changes to attempts, state, Git, or the installer.

Run both test suites from the project directory with `node .claude/skills/fable-orchestrator/scripts/run-tests.cjs` and `node .agents/skills/fable-orchestrator/scripts/run-tests.cjs`; CI should call the same runner. Use temporary repositories and fixtures for Git tests. Keep live agent validation and deterministic tests distinct in reports.

Keep runtime state, transcripts, nested worktrees, local settings, and installation manifests out of changes intended for distribution.
