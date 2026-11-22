# Security model of opus-orchestrator

What `oo` enforces, what it only screens for, and what it cannot protect against. It applies to version 1.1.0, whose repairs are listed in `CHANGELOG.md`.

## What is trusted

- The orchestrator session (Opus) and the person using it. `oo` takes their commands as authoritative, including paths they pass (`--worktree`) and agent ids the host reported (`--agent-id`).
- The local machine, the user's account and the git binary.

Not trusted: worker and reviewer reports, repository content, documentation, web pages and tool output. A report is a claim that `oo` checks against evidence it gathers itself.

## What oo enforces

- **State integrity.** One writer at a time through a lock with an owner token, process id and host. Age never frees a lock; only a proven-dead owner on the same host is taken over automatically, everything else needs a person (`node scripts/manage_state.cjs lock`). Every state write checks that the lock is still held. Files are written atomically with a backup.
- **Attempt identity.** Every dispatch has an attempt id; a report must carry the current one. Late, duplicate, abandoned and foreign reports are refused. In-flight work is never requeued on a guess (`oo reconcile` names the attempt explicitly).
- **Candidate binding (worktree strategy).** The worker's worktree is checked by `oo` (this repository, not the main checkout, the integration worktree or another attempt's worktree, not on the base or integration branch); its HEAD commit and tree are pinned. The commit or branch named in a report is never used. Verification runs in a fresh, clean checkout of the pinned commit; integration merges exactly that commit in a clean checkout, checks the merge commit, then fast-forwards the integration branch to it; delivery fast-forwards to exactly the integrated, audited commit. Nothing is forced; dirty or unowned worktrees are never removed.
- **Scope evidence (shared workspace).** Content-hash snapshots with an explicit completeness flag; the task's baseline from its first dispatch is kept across retries. A change outside the scope is a violation unless it is exactly the content another task's verified candidate recorded. Incomplete evidence blocks the task. Writers run one at a time.
- **Commands do not rewrite evidence.** A verification, integration or audit command that changes sources (anything but git-ignored files and `verification.generated_artifacts`) invalidates the result.
- **Repository guard.** The git configuration, hooks and `info/attributes`/`info/exclude` of the shared git directory are hashed at `oo init`; verification, integration and delivery stop when they changed, and the guard is checked again after candidate commands ran and before each fast-forward.
- **Independent review.** Review dispatches are bound to task, attempt, round, perspective and verified candidate; reviews need the host's agent id, and the worker's agent cannot review its own work. The `opus-reviewer` agent has no shell (Read, Glob, Grep) and reviews a pinned evidence file.
- **Authorization.** Limits, external side effects, reopening finished work, a new baseline and accepting changed git configuration are recorded only with `--by user` or `--user-authorized`, which the orchestrator may pass only after the user said so.

## Limited safeguards

These reduce risk; they are not boundaries.

- **Command screening** (`scripts/lib/security.cjs`) matches command text against patterns for destructive or publishing commands. It is not a sandbox: an allowed command runs with all the rights of your user, and an obfuscated command or a script that does the damage itself passes.
- **Credential scrubbing** removes environment variables whose names look like credentials from verification commands (`security.command_env_allow` keeps one). A command can still read credential files your account can read.
- **Secret redaction** of recorded text catches common token formats and `NAME=value` assignments for key-like names; it misses passwords in URLs, other names, short values and anything it does not recognize. It does not stop a worker from seeing a secret in the files it reads.
- **Protected paths** keep matching files out of a specification's authorized files (unless the task is security sensitive) and out of pinned review evidence; they do not prevent reading.
- **Agent tool lists** (`agents/*.md`) restrict what an installed agent can call. Without installed agents `oo next` falls back to `general-purpose`, which has a shell.
- **Agent ids** passed with `--agent-id` come from the orchestrator; `oo` cannot verify them against the host.
- **Repository hooks.** The guard detects changes; hooks the user installed before `oo init` still run during `oo`'s merges and fast-forwards, as they would for the user.

## Known gaps

- A process id reused by an unrelated program makes a dead owner look alive; recovery then needs a person (`--pid-reused`, `--takeover <op id>`).
- The shared-workspace baseline is taken just before the state lock; a command still writing at that moment could end up in the baseline.
- Runs started by an earlier version lack candidates, baselines and the integration head and must be finished by hand or restarted.
- Live validation with real agents covers only the run recorded in `validation/live/` (before these repairs). Everything above is covered by automated tests with simulated agents.

## Reporting a problem

Do not put secrets, private paths or transcripts in a public issue. Describe the command, the observed and expected behaviour, and the version (`node scripts/oo.cjs version`).
