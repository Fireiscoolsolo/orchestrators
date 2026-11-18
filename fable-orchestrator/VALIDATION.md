# v1.1.0 candidate validation

Validation completed on 2026-11-18. Readiness classification: **Experimental**. This is a local release candidate, not a published v1.1.0 release. No license has been selected or applied.

## Executed results

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Baseline, Claude skill layout | 79 | 0 | 0 |
| Baseline, Codex preview layout | 79 | 0 | 0 |
| Final, Claude skill layout | 124 | 0 | 0 |
| Final, Codex preview layout | 124 | 0 | 0 |
| Historical demo fixture, rerun in an isolated copy | 24 | 0 | 0 |

Windows execution used Node.js 26.12.1 and Git 2.56.0.windows.4. Both layouts have identical executable sources and tests. Their SKILL.md files differ only by the intentional Codex preview banner. The suite uses real disposable Git repositories, worktrees, filesystem changes, and child processes. Worker and reviewer reports are simulated. Temporary test directories were kept short to avoid Windows path-length limits.

Forty-five new regressions cover Git compatibility (5), reviewer recovery (9), lock-reaper recovery (8), and shared-mode integrity (23). Existing CLI assertions were strengthened for snapshot-bound review. The full suite also covers parallel workers, dependencies, failed verification, correction, independent review, integration conflicts, interrupted operation recovery, installation ownership, and delivered-versus-verified SHA equality.

Independent review identified additional shared-mode defects during the repair: retries could absorb unauthorized edits, shared review identity was optional, and delivery status could remain stale. Those were repaired with regression coverage. The final independent reviewer inspected the resulting code and independently executed 13 targeted checks with no failures or skips. No blocking finding remained in the reviewed paths.

## Five audit findings

| Finding | Repair and evidence | Status |
| --- | --- | --- |
| Lost independent reviewer | Explicit active/unknown/failed observation, abandonment, unique replacement dispatch, preserved history, late-report rejection, candidate and independent identity checks. Nine recovery regressions exercise concurrent reconciliation and replacement. | Fixed |
| Git minimum mismatch | Worktree operations require Git 2.36 or later before execution. Parsing covers Windows and Apple suffixes, missing/malformed output, unsupported versions, and explicit shared mode. Five regressions pass. | Fixed |
| Shared scope after report | Complete content snapshots checked across verification, review, integration and delivery. Setup failure stops commands. Mutations invalidate evidence, retries retain the first baseline, and every shared review names its snapshot. Twenty-three regressions pass. | Fixed |
| Crashed lock reaper | Atomically published PID/host/token guards with dead-owner successor recovery. No age-only takeover or deletion of a live owner's guard. Eight new crash/concurrency regressions pass. | Fixed |
| Workflow and documentation drift | Required reviewer host ID documented in policy, skill, template, and CLI help. Exact candidate commit/tree/base/diff/files/evidence replace reliance on removed checkouts. Both layouts synchronized and obsolete fixed README counts removed. | Fixed |

Git's [2.36 worktree documentation](https://github.com/git/git/blob/v2.36.0/Documentation/git-worktree.txt) includes `worktree list --porcelain -z`; the [2.35 documentation](https://github.com/git/git/blob/v2.35.0/Documentation/git-worktree.txt) does not. This is the reason for the enforced minimum.

## Evidence limits

Live Claude validation is pending. A capped connectivity check failed because its OAuth login could not refresh and reported zero model cost. The operator chose not to reauthenticate during this repair. A fresh live worker/reviewer run, host completion metadata, and live reviewer interruption are therefore unverified. See [the reproducible procedure](LIVE-VALIDATION.md).

Ubuntu was unavailable locally; no WSL distribution or container runtime was available. The prepared repository retains Windows/Ubuntu CI for Node 22 and 24, but that workflow has not been run for this candidate. The documented Node 18 minimum was not independently executed in this environment. Do not infer current Linux, older-runtime, or live-host compatibility from Windows deterministic results.

Worktrees and command screening are not security containment. Host permissions govern filesystem, executable, credential, and network access. Host identities and liveness are operator-supplied observations. Shared content scans cannot prevent transient or concurrent writes. Ambiguous old locks and interrupted Git operations may need manual reconciliation. See [security](SECURITY.md) and [remaining limitations](LIMITATIONS.md).

## Distribution policy

The release uses an explicit source-file manifest. Historical validation directories, raw transcripts, session identifiers, authentication output, personal paths, runtime state, generated worktrees, nested Git repositories, installed-agent manifests, and temporary test output are excluded. Historical evidence remains in the original project. The two layouts are synchronized before packaging and archive entries are checked against the source manifest and their SHA-256 hashes.

The root collection reserves names for Opus Orchestrator and Sonnet Orchestrator. Fable installs independently from its own directory with namespaced agent registrations. The existing v1.0.0 archive and remote release remain untouched. Publication and licensing need a separate decision.
