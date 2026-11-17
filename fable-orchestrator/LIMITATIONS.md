# Known limitations

**High.** Live Claude Code dispatch, completion metadata, and review have not been revalidated with paid models for this candidate. If the host omits a required agent ID, worktree, or branch, retain the attempt and investigate before retrying. The Codex-facing configuration is experimental and the runtime still targets Claude Code.

**High.** Command screening and worktree separation cannot contain untrusted executables. A repository, test, or Git configuration can access whatever the host allows. The checkout checks detect persistent Git changes at observation points. They cannot detect every transient modification, ignored artifact, external dependency, or edit made by another process.

**High.** Locks coordinate local CLI processes using the same run directory. External Git clients and differing filesystem permissions remain outside that coordination. An interruption between a Git ref change and state persistence can need manual reconciliation. A worker identity or reviewer identity supplied by the orchestrator has no cryptographic host attestation.

**Medium.** Shared mode fingerprints files, serializes tasks, and reports scope differences. Changes happen in place and have no immutable Git delivery identity. Large or unreadable snapshots fail scope validation.

**Medium.** Top-level worker and reviewer dispatches count before launch. Nested calls and token usage depend on reported data and can exceed a nominal limit before they become visible. The CLI cannot measure or enforce monetary spend.

**Medium.** Old active runs may lack attempt and verification records needed by this version. Archive their local evidence and start a new run after reconciling worktrees. An interrupted install or unknown legacy files may require a clean installation target.
