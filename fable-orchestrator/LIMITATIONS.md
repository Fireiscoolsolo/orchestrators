# Known limitations in v1.0.0

Fable Orchestrator is experimental and intended for supervised use in trusted repositories. The existing test suite covers core logic and several failure paths with simulated workers. The original live demonstration completed with Sonnet as orchestrator. A Fable-led attempt reached intake and contract drafting before hitting an account usage limit. The Codex integration has partial configuration and lacks a validated end-to-end installation and execution path.

| Area | Current limitation |
| --- | --- |
| Verification and delivery | Verification can run against working-tree contents that differ from the Git revision ultimately delivered. Review evidence can become stale when the candidate changes. |
| Worker worktrees and file scope | The orchestrator relies partly on worker-reported worktree information. Ownership checks, automatic commits, scope checks, and cleanup have gaps. Shared-workspace mode provides weaker isolation. |
| Resume and recovery | Resume can redispatch workers that may still be active. Reports that arrive late can be associated with a newer attempt. Interrupted Git operations may need manual reconciliation. |
| Concurrency and state | Age-based lock recovery can reclaim a lock held by an active process. An interruption between state and event-log writes can leave them out of sync. |
| Command execution and permissions | Setup and verification can run shell commands. Command screening is advisory, and the CLI can accept caller-supplied assertions of authorization. Host rules may see only the outer CLI command. Use trusted repositories and review the commands in the plan before execution. |
| Review independence | The review gate relies partly on reported reviewer perspectives and does not independently establish that each perspective came from a distinct reviewer or the same candidate revision. |
| Configuration and budgets | Configuration validation, setup failure handling, and agent-call accounting have gaps. Nested calls may be undercounted. Dollar costs and the orchestrator's own token use are unavailable within a run. |
| Planning and installation | Plan writes can leave partial state. Installed agent names are generic, which can cause collisions with other skills. Installer ownership tracking is limited. |
| Host compatibility | The bundled installer targets Claude Code. The Codex skill text and the CLI disagree on the runtime directory. Model routing and workflow behavior depend on the host and its permissions. |

Additional runtime constraints, including the supported YAML subset and Windows headless invocation, are listed in the [Claude Code skill guide](.claude/skills/fable-orchestrator/README.md#limitations).
