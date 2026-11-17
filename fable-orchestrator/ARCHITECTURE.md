# Architecture

The primary skill lives under `.claude/skills/fable-orchestrator/`. The copy under `.agents/skills/fable-orchestrator/` shares its CLI, tests, templates, and references. Its skill entry describes experimental Codex use. The installer generates the Claude Code agent registration files from the primary skill's `agents/` directory.

1. The CLI parses configuration and validates the task graph before saving the accepted plan and contracts together. Routing uses task complexity, risk, and mode. Scheduling respects dependencies, file-scope conflicts, and the available budget.
2. A dispatch records its attempt UUID, route, starting commits, and workspace. Managed worktrees are assigned by the CLI. The Claude Code native path requires separate binding from host metadata. A worker report must match the current attempt and its clean, assigned worktree.
3. The verifier checks a fresh detached worktree at the candidate commit and records both the commit and tree SHA. Integration builds the merge in a separate checkout, verifies the resulting commit, and advances the integration branch to that SHA. Delivery runs final checks on the pinned integration commit and fast-forwards the project checkout to that exact SHA.
4. A reviewing agent receives the recorded evidence and a Git diff. Its report is bound to a review dispatch, attempt, verification cycle, perspective, and candidate commit. The orchestrator supplies the reviewer identity from the host.
5. The state store uses an ownership token for local locking, atomic file replacement, and an event batch written with state for recovery. Verification, merge trials, and final checks run outside the state lock. Resume retains in-flight work until the host confirms its outcome. Interrupted operations can require explicit reconciliation.

The Git worktrees isolate Git checkout state. Use host controls for filesystem, network, and execution isolation. [See the security model](SECURITY.md).
