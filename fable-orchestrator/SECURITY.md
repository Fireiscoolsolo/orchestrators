# Security

Use this experimental version in trusted projects with supervision and the narrowest permissions available in the host. Keep network access and external changes subject to the host's permission flow.

| Control | Scope |
| --- | --- |
| Attempt and candidate matching | The CLI rejects stale attempt identifiers, mismatched assigned worktrees and branches, dirty worker checkouts, and evidence for a different Git commit. |
| Checkout and delivery integrity | The CLI verifies in detached worktrees, checks Git state around commands, and uses pinned commits for integration and delivery. Cleanup preserves dirty or unowned worktrees. |
| Worker and reviewer identity | Managed worktrees are created by the CLI. For native worktrees and independent reviews, the orchestrator supplies identity information from host notifications. The CLI trusts that caller to report it accurately. |
| Reviewer recovery | Dispatch UUID, task attempt, candidate, perspective, and host identity are checked. Explicit abandonment revokes the old dispatch without waiving review. Operator liveness assertions are not independent permission or host attestation. |
| Shared workspace | Content hashes are checked across phases and evidence is invalidated on persistent drift. This detects observed changes but cannot prevent transient writes or isolate another process. Runtime directories must not contain source or verification inputs. |
| Lock recovery | Local PID and owner-token checks protect run locks and recover crashed reapers. No elapsed-time-only takeover. Ambiguous or foreign ownership fails closed for reconciliation. |
| Command execution | Setup and verification commands run as the CLI process user. The child environment passes a small set of platform and shell settings. Command screening is advisory. Files, system credentials, network access, and code run by tests remain governed by the host and OS. |
| Read-only roles | The named Claude Code reviewer has read tools only. The research role adds web read tools. The host must enforce those tool restrictions. |
| External actions | The CLI defers explicitly marked external tasks because it cannot authenticate approval. An operator must use a host-authorized path. |

Do not share run directories, evidence logs, raw transcripts, or private patches with vulnerability reports. Report sensitive issues through a private channel available from the project owner.
