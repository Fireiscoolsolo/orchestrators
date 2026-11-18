# Live Claude Code validation

This candidate has deterministic Git integration coverage. Its revised live workflow is pending. The connectivity attempt reached an expired OAuth login, returned no model output, and reported zero model cost. The operator chose to leave live validation pending. Do not treat historical V1.0 demonstrations or simulated reports as current live evidence.

## Reproduce in a disposable project

1. Authenticate locally with `claude auth login`. Keep credentials and session output private.
2. Create a new temporary directory, initialize Git, configure a local test author, and commit `value.cjs` containing `module.exports = 1;` and `check.cjs` containing `require('node:assert/strict').equal(require('./value.cjs'), 2);`. Use a repository with no remotes and no personal files.
3. Install this candidate with `node /path/to/fable-orchestrator/.claude/skills/fable-orchestrator/scripts/install.cjs --project /path/to/disposable-project`. Start a fresh Claude Code session there.
4. Invoke `/fable-orchestrator --mode maximum --max-workers 2 Set value.cjs to export 2. Verify with node check.cjs. Use a low-complexity Haiku worker and native worktree isolation. Pause before the first independent review and before delivery.` Keep normal host permission checks. Inspect each proposed command. For headless operation, use the actual installed CLI's budget option, such as `--max-budget-usd 3`, and stop at that limit.
5. Confirm the host dispatch and completion metadata supply the worker identity, worktree path, and branch. The worker YAML is insufficient. Bind those values with `fo bind-worktree <ID> --attempt-id <UUID> --agent-id <HOST_ID> --worktree <PATH> --branch <BRANCH>`. If metadata is unavailable, stop and retain the worktree.
6. Ingest the unchanged report and run `fo verify <ID>`. Save the candidate commit, tree, base, changed-file list, and evidence references. Inspect pinned files with `git show <COMMIT>:value.cjs`.
7. Obtain an independent review with `fo review-package <ID>`. Launch the actual host Agent call printed by that command. Preserve its dispatch UUID and host identity separately from worker identity. Submit unchanged YAML using `fo review <ID> --agent-id <REVIEWER_HOST_ID> --stdin`. Exercise every required perspective with a distinct reviewer.
8. For one controlled recovery, reserve a review package, then intentionally leave it undispatched. Record `fo reconcile <ID> --review-dispatch-id <OLD_UUID> --liveness unknown --abandon --reason "Controlled validation: reserved dispatch was not launched"`. Run `fo resume`. Create and actually launch the replacement review. Its UUID must differ. Submit a synthetic late report for the abandoned UUID and confirm rejection, recording this particular check as simulated. The replacement's real report must succeed.
9. Record the orchestrator's criteria-based review, integrate, and deliver. Confirm the delivered SHA, final verified SHA, and `git rev-parse HEAD` are identical. Confirm the reported tree SHA with `git rev-parse HEAD^{tree}`. If a merge or command fails, retain evidence and use the correction workflow.

## Evidence to retain privately

Record exact commands, host version, model aliases actually used, worker and reviewer host identities, attempt and dispatch UUIDs, candidate commit/tree/base, verification results, review decisions, replacement history, integration SHA, final verification SHA, delivered SHA, actual usage, and permission denials. Separate observations from simulations. Do not package raw transcripts, authentication output, host identifiers, local paths, or run directories in a public release.

The deterministic regression suite covers parallel workers, dependencies, verification failure, correction, independent review, lost-review recovery, integration, interrupted operations, and exact-commit delivery in real temporary Git repositories. Those checks do not establish live model or host behavior.
