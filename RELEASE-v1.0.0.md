# Fable Orchestrator v1.0.0

Experimental first release of Fable Orchestrator. It includes the Claude Code skill, dependency scheduler, model routing, worker roles, Git integration, recovery tooling, installer, and automated tests. It also includes the current partial Codex integration.

The source is the pre-hardening implementation. Use it with supervision and review the [known limitations](fable-orchestrator/LIMITATIONS.md) before execution.

The packaged Claude Code and Codex variants each passed all 54 existing tests on Windows with Node.js 26.12.1, Git 2.56.0, and Git Bash. CLI integration tests use simulated workers.

The repository starts with Fable under `fable-orchestrator/`, with room for Opus and Sonnet as sibling projects. See [installation and test instructions](fable-orchestrator/README.md).
