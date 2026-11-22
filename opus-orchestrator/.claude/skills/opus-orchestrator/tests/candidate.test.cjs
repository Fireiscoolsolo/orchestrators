'use strict';
// Candidate binding, worktree ownership, clean-checkout verification, integration of the exact
// verified commit, delivery of the exact integrated sha, the repository guard, and fail-closed
// evidence, through the oo CLI on real temporary git repositories and worktrees.
// SIMULATED AGENTS: "workers" are test code that commits in its own worktree and feeds a YAML
// report to oo result; "reviewers" are test code. No model or real agent runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./oo-harness.cjs');
const store = require('../scripts/lib/store.cjs');

const FAULTS = path.join(__dirname, 'faults', 'git-faults.cjs');
test.after(H.cleanup);

/** Simulated worker: own worktree and branch, merges the dispatch integration head, commits files. */
function worker(p, id, files, o = {}) {
  const wt = path.join(p.root, `wt-${id}-${p.task(id).attempts}`);
  const branch = o.branch || `agent-${id.toLowerCase()}-${p.task(id).attempts}`;
  H.g(p.dir, 'worktree', 'add', '-q', '-b', branch, wt, 'HEAD');
  H.g(wt, 'merge', '--no-edit', '-q', p.task(id).dispatch.integration_head);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(wt, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  H.g(wt, 'add', '-A');
  H.g(wt, 'commit', '-q', '-m', `${id}: simulated worker change`);
  return { wt, branch, sha: H.g(wt, 'rev-parse', 'HEAD') };
}

function gitProject(extra = {}) {
  const p = H.project(Object.assign({ git: true }, extra));
  p.write('.gitignore', 'build-out/\n');
  p.git('add', '-A');
  p.git('commit', '-q', '-m', 'ignore build output');
  return p;
}

/** Runs oo with the fault-injection preload. */
function faulty(p, fault, faultDir, args, input = '') {
  const env = Object.assign({}, p.env, { OO_TEST_FAULT: fault });
  if (faultDir) env.OO_TEST_FAULT_DIR = faultDir;
  else delete env.OO_TEST_FAULT_DIR;
  const r = spawnSync(process.execPath, ['-r', FAULTS, H.OO, ...args], { cwd: p.dir, env, input, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function approve(p, id) {
  return p.ok(['review', id, '--stdin'], { input: H.review(id) });
}

test('simulated-agent: worktree ownership comes from oo\'s checks, never from the report', () => {
  const p = gitProject();
  p.ok(['init', 'Ownership']);
  p.plan([H.spec('A-001'), H.spec('B-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  const res = (id, wt, extra = {}) => p.run(['result', id, '--stdin', '--worktree', wt], { input: H.report(id, Object.assign({ files: [`${id.toLowerCase()}.txt`] }, extra)) });
  const intDir = path.join(p.dir, ...p.runRecord().workspace.integration_worktree.split('/'));
  const other = H.project({ git: true }); // another repository
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-notrepo-'));
  const cases = [
    [p.dir, /that is the main checkout, not a worker worktree/],
    [intDir, /that is the integration worktree/],
    [other.dir, /belongs to another repository/],
    [notRepo, /is not the top directory of a git work tree/],
    [path.join(p.root, 'missing-worktree'), /does not exist/],
    [path.join(a.wt, 'sub'), /does not exist|is not the top directory/],
  ];
  const before = JSON.stringify(p.task('A-001'));
  for (const [wt, re] of cases) {
    const r = res('A-001', wt);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, re, wt);
    assert.match(r.out, /result for A-001 rejected; task state unchanged/);
  }
  assert.equal(JSON.stringify(p.task('A-001')), before);
  fs.rmSync(notRepo, { recursive: true, force: true });

  // the report's commit and branch are compared, never used
  let out = p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'], commit: 'deadbeef', branch: 'main' }) });
  assert.match(out, /the reported commit deadbeef differs from the worktree HEAD [0-9a-f]{40}; the worktree HEAD is the candidate/);
  assert.match(out, /the reported branch main differs from the worktree's branch agent-a-001-1; the report does not decide which branch is used/);
  assert.equal(p.task('A-001').candidate.commit, a.sha);
  assert.equal(p.task('A-001').binding.branch, 'agent-a-001-1');

  // a worktree bound to A cannot be claimed by B
  const r = res('B-001', a.wt);
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`already bound to A-001 attempt ${p.task('A-001').dispatch.attempt_id}`));
  assert.equal(p.status('B-001'), 'DISPATCHED');
});

test('simulated-agent: the pinned candidate is verified in a clean checkout; later commits on the branch are neither verified nor integrated', () => {
  const p = gitProject();
  p.ok(['init', 'Pinned candidate']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  // the worker keeps going after its report
  fs.writeFileSync(path.join(a.wt, 'late.txt'), 'not reviewed\n');
  H.g(a.wt, 'add', '-A');
  H.g(a.wt, 'commit', '-q', '-m', 'after the report');
  let out = p.ok(['verify', 'A-001']);
  assert.match(out, new RegExp(`the worktree HEAD moved to [0-9a-f]{40} after the report; the pinned candidate ${a.sha} is verified`));
  assert.match(out, /Changed files: a-001\.txt\n/);
  approve(p, 'A-001');
  out = p.ok(['integrate', 'A-001']);
  const run = p.runRecord();
  const intBranch = run.workspace.integration_branch;
  const merged = p.task('A-001').evidence.integration.merged_commit;
  assert.equal(p.git('rev-parse', intBranch), merged, 'the integration branch is exactly at the checked merge commit');
  assert.equal(run.workspace.integration_head, merged);
  assert.equal(p.git('rev-parse', `${merged}^2`), a.sha, 'the merge brought in the pinned candidate');
  assert.equal(p.git('ls-tree', '--name-only', intBranch).split('\n').includes('late.txt'), false, 'the later commit was not integrated');
});

test('simulated-agent: commands that rewrite sources invalidate the evidence; ignored and policy outputs do not; a failed setup stops the run', () => {
  const p = gitProject({ config: 'verification:\n  generated_artifacts: [\'coverage/\']\n' });
  p.ok(['init', 'Generated artifacts']);
  const rewrite = 'node -e "require(\'fs\').appendFileSync(\'a-001.txt\', \'rewritten by the check\\n\')"';
  const ignored = 'node -e "require(\'fs\').mkdirSync(\'build-out\', {recursive: true}); require(\'fs\').writeFileSync(\'build-out/x.js\', \'1\')"';
  const cov = 'node -e "require(\'fs\').mkdirSync(\'coverage\', {recursive: true}); require(\'fs\').writeFileSync(\'coverage/lcov.info\', \'1\')"';
  p.plan([H.spec('A-001', { verification_commands: [H.existsCmd('a-001.txt'), rewrite] }), H.spec('B-001', { verification_commands: [ignored, cov, H.existsCmd('b-001.txt')] })]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  const b = worker(p, 'B-001', { 'b-001.txt': 'B\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['result', 'B-001', '--stdin', '--worktree', b.wt], { input: H.report('B-001', { files: ['b-001.txt'] }) });
  let out = p.refused(['verify', 'A-001']);
  assert.match(out, /manual check failed: commands left the sources unchanged \(the verification commands changed a-001\.txt/);
  assert.match(out, /clean checkout .*: kept as evidence/);
  const v = p.task('A-001').evidence.verification;
  assert.deepEqual(v.mutations, [{ path: 'a-001.txt', generated: false }]);
  out = p.ok(['verify', 'B-001']);
  assert.match(out, /VERIFICATION PASSED: B-001/);
  assert.deepEqual(p.task('B-001').evidence.verification.mutations, [{ path: 'coverage/lcov.info', generated: true }], 'the ignored build output is not even listed; the policy output is allowed');

  // setup commands run first; a failing one stops the verification
  const q = gitProject({ config: 'verification:\n  setup_commands: [\'node -e "process.exit(4)"\']\n' });
  q.ok(['init', 'Setup failure']);
  q.plan([H.spec('C-001')]);
  q.ok(['next']);
  const c = worker(q, 'C-001', { 'c-001.txt': 'C\n' });
  q.ok(['result', 'C-001', '--stdin', '--worktree', c.wt], { input: H.report('C-001', { files: ['c-001.txt'] }) });
  out = q.refused(['verify', 'C-001']);
  assert.match(out, /Failing command: node -e "process\.exit\(4\)" \(setup\)/);
  assert.match(out, /Not run after the failure: node -e "process\.exit\(require/);
  const cmds = q.task('C-001').evidence.verification.commands;
  assert.deepEqual(cmds.map((x) => [x.setup === true, x.skipped === true, x.exit_code]), [[true, false, 4], [false, true, null]]);
});

test('simulated-agent: an unreadable or malformed worktree status and a deleted worker worktree never read as clean', () => {
  const p = gitProject();
  p.ok(['init', 'Status failures']);
  p.plan([H.spec('A-001'), H.spec('B-001'), H.spec('C-001')]);
  p.ok(['next']);
  const ws = {};
  for (const id of ['A-001', 'B-001', 'C-001']) {
    ws[id] = worker(p, id, { [`${id.toLowerCase()}.txt`]: `${id}\n` });
    p.ok(['result', id, '--stdin', '--worktree', ws[id].wt], { input: H.report(id, { files: [`${id.toLowerCase()}.txt`] }) });
  }
  let r = faulty(p, 'status-denied', ws['A-001'].wt, ['verify', 'A-001']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /work committed \(the worktree status cannot be read \(git status failed in .* \(exit 128\): fatal: cannot open \.git\/index: Permission denied\); uncommitted work cannot be ruled out\)/);
  r = faulty(p, 'status-malformed', ws['B-001'].wt, ['verify', 'B-001']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /work committed \(the worktree status cannot be read \(git status output is truncated/);
  // the worker removed its worktree: the pinned commit is still verified from the repository
  H.g(p.dir, 'worktree', 'remove', ws['C-001'].wt);
  const out = p.ok(['verify', 'C-001']);
  assert.match(out, /the worker worktree .* no longer exists; the pinned candidate commit is verified from the repository/);
});

test('simulated-agent: a missing candidate or baseline blocks verification instead of trusting the worker', () => {
  const p = gitProject();
  p.ok(['init', 'Missing evidence']);
  p.plan([H.spec('A-001'), H.spec('N-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  // the record of the candidate is lost (state damaged or written by an older version)
  const t = p.task('A-001');
  delete t.candidate;
  store.saveTask(p.paths, p.runId(), t);
  let out = p.refused(['verify', 'A-001']);
  assert.match(out, /VERIFICATION NOT POSSIBLE: A-001 -> BLOCKED \(kind evidence_missing\)/);
  assert.match(out, /no candidate was recorded for the worker's attempt/);
  assert.equal(p.task('A-001').evidence.verification == null, true, 'no verification evidence from claims');

  // an isolated task that reports no change gets the dispatch head as its candidate, verified for
  // real in a clean checkout; nothing is merged for it
  out = p.ok(['result', 'N-001', '--stdin'], { input: H.report('N-001', { files: [] }) });
  assert.match(out, /the candidate is the integration head the task was dispatched with/);
  const head = p.runRecord().workspace.integration_head;
  assert.equal(p.task('N-001').candidate.commit, head);
  out = p.refused(['verify', 'N-001']);
  assert.match(out, /command failed \(exit 1\): node -e .*n-001\.txt/, 'the check runs against the real candidate, which has no n-001.txt');
});

test('simulated-agent: shared workspace without its baseline blocks; a new baseline needs the user', () => {
  const p = H.project();
  p.ok(['init', 'Baseline gone']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  fs.rmSync(path.join(p.dir, ...p.task('A-001').baseline.snapshot.split('/')));
  fs.rmSync(path.join(p.dir, ...p.task('A-001').baseline.snapshot.split('/')) + '.bak', { force: true });
  let out = p.refused(['verify', 'A-001']);
  assert.match(out, /VERIFICATION NOT POSSIBLE: A-001 -> BLOCKED \(kind evidence_missing\)/);
  assert.match(out, /the baseline snapshot is missing or in an old format/);
  assert.match(p.refused(['rebaseline', 'A-001', '--reason', 'lost']), /NOT_AUTHORIZED/);
  p.ok(['rebaseline', 'A-001', '--reason', 'the user accepts the current files as the baseline', '--user-authorized']);
  p.ok(['unblock', 'A-001', '--reason', 'baseline reset']);
  p.ok(['next']);
  assert.ok(p.task('A-001').baseline.snapshot, 'the next dispatch took a new baseline');
  p.write('a-001.txt', 'A again\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  assert.match(p.ok(['verify', 'A-001']), /VERIFICATION PASSED: A-001/);
});

test('simulated-agent: integration checks run on the merge commit itself; a failure leaves the integration branch untouched', () => {
  const p = gitProject();
  p.ok(['init', 'Integration checks']);
  // B's integration check fails when A's file is present: only visible on the merged result
  const noA = 'node -e "process.exit(require(\'fs\').existsSync(\'a-001.txt\') ? 1 : 0)"';
  p.plan([H.spec('A-001'), H.spec('B-001', { verification_commands: [H.existsCmd('b-001.txt'), noA] })]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  const b = worker(p, 'B-001', { 'b-001.txt': 'B\n' });
  for (const [id, w] of [['A-001', a], ['B-001', b]]) {
    p.ok(['result', id, '--stdin', '--worktree', w.wt], { input: H.report(id, { files: [`${id.toLowerCase()}.txt`] }) });
    p.ok(['verify', id]);
    approve(p, id);
  }
  p.ok(['integrate', 'A-001']);
  const head = p.runRecord().workspace.integration_head;
  const out = p.refused(['integrate', 'B-001']);
  assert.match(out, /INTEGRATION FAILED: B-001 -> CORRECTION_REQUIRED; the merge commit was never put on the integration branch, which is unchanged/);
  assert.equal(p.git('rev-parse', p.runRecord().workspace.integration_branch), head);
  assert.equal(p.runRecord().workspace.integration_head, head);
});

test('simulated-agent: a moved or dirty integration branch blocks integration and delivery; nothing is forced or reverted', () => {
  const p = gitProject();
  p.ok(['init', 'Branch movement']);
  p.plan([H.spec('A-001'), H.spec('B-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  const b = worker(p, 'B-001', { 'b-001.txt': 'B\n' });
  for (const [id, w] of [['A-001', a], ['B-001', b]]) {
    p.ok(['result', id, '--stdin', '--worktree', w.wt], { input: H.report(id, { files: [`${id.toLowerCase()}.txt`] }) });
    p.ok(['verify', id]);
    approve(p, id);
  }
  const intDir = path.join(p.dir, ...p.runRecord().workspace.integration_worktree.split('/'));
  // someone edits the integration worktree by hand
  fs.writeFileSync(path.join(intDir, 'hand-edit.txt'), 'not by oo\n');
  let out = p.refused(['integrate', 'A-001']);
  assert.match(out, /INTEGRATION NOT STARTED: A-001 -> BLOCKED \(kind integration_dirty\)/);
  assert.equal(fs.readFileSync(path.join(intDir, 'hand-edit.txt'), 'utf8'), 'not by oo\n', 'the foreign edit is preserved');
  fs.rmSync(path.join(intDir, 'hand-edit.txt'));
  // someone commits on the integration branch
  fs.writeFileSync(path.join(intDir, 'foreign.txt'), 'foreign\n');
  H.g(intDir, 'add', '-A');
  H.g(intDir, 'commit', '-q', '-m', 'a commit oo did not make');
  p.ok(['unblock', 'A-001', '--reason', 'cleaned up']);
  assert.equal(p.status('A-001'), 'READY', 'unblocking sends the work back to a worker');
  out = p.refused(['integrate', 'B-001']);
  assert.match(out, /BLOCKED \(kind integration_moved\)[\s\S]*something other than oo moved it/);
});

test('simulated-agent: an integration interrupted after the fast-forward is finalized by the next integrate', () => {
  const p = gitProject();
  p.ok(['init', 'Interrupted integration']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['verify', 'A-001']);
  approve(p, 'A-001');
  const r = faulty(p, 'crash-after-ff', null, ['integrate', 'A-001']);
  assert.equal(r.code, 9, r.out);
  const t = p.task('A-001');
  assert.equal(t.status, 'INTEGRATING');
  assert.equal(t.pending_op.checks_passed, true);
  const intBranch = p.runRecord().workspace.integration_branch;
  assert.equal(p.git('rev-parse', intBranch), t.pending_op.merge_sha, 'the branch was moved before the crash');
  assert.notEqual(p.runRecord().workspace.integration_head, t.pending_op.merge_sha, 'the state was not yet updated');
  assert.match(p.ok(['resume']), /Operation integrate of A-001 \([0-9a-f-]{36}\): interrupted/);
  const out = p.ok(['integrate', 'A-001']);
  assert.match(out, /INTEGRATED: A-001 -> COMPLETED \(merge commit [0-9a-f]{40}/);
  assert.match(out, /finalized the interrupted integration .*: its merge commit [0-9a-f]{40} had passed the checks/);
  assert.equal(p.runRecord().workspace.integration_head, t.pending_op.merge_sha);
  assert.equal(p.task('A-001').evidence.integration.merged_commit, t.pending_op.merge_sha);
});

test('simulated-agent: delivery fast-forwards to exactly the integrated sha and forces nothing over local changes', () => {
  const p = gitProject();
  p.ok(['init', 'Exact delivery']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt, '--verify'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['review', 'A-001', '--stdin', '--integrate'], { input: H.review('A-001') });
  const sha = p.runRecord().workspace.integration_head;
  // an untracked local file in the main checkout would be overwritten by the fast-forward
  p.write('a-001.txt', 'local, uncommitted\n');
  let out = p.refused(['deliver']);
  assert.match(out, /the fast-forward to [0-9a-f]{40} failed: .*untracked working tree files would be overwritten/s);
  assert.equal(p.read('a-001.txt'), 'local, uncommitted\n', 'the local file is untouched');
  assert.equal(p.runRecord().delivered, false);
  fs.rmSync(path.join(p.dir, 'a-001.txt'));
  out = p.ok(['deliver']);
  assert.match(out, new RegExp(`DELIVERED: main fast-forwarded to ${sha} \\(exactly the integrated and audited commit`));
  assert.equal(p.git('rev-parse', 'HEAD'), sha);
  assert.equal(p.runRecord().delivery.commit, sha);
  assert.match(p.refused(['deliver']), /the run was already delivered/);
});

test('simulated-agent: a changed git hook or config after init stops verification until the user accepts it', () => {
  const p = gitProject();
  p.ok(['init', 'Repo guard']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  // a worker (or anyone) adds a hook to the shared git directory
  fs.writeFileSync(path.join(p.dir, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho owned > owned.txt\n');
  let out = p.refused(['verify', 'A-001']);
  assert.match(out, /the repository configuration, hooks or info\/attributes in the git directory changed since the run started/);
  assert.equal(p.status('A-001'), 'IMPLEMENTED', 'nothing ran');
  assert.match(p.ok(['repo-guard']), /CHANGED since the run started/);
  assert.match(p.refused(['repo-guard', '--accept', '--reason', 'x']), /NOT_AUTHORIZED/);
  fs.rmSync(path.join(p.dir, '.git', 'hooks', 'post-checkout'));
  assert.match(p.ok(['repo-guard']), /unchanged since the run started/);
  assert.match(p.ok(['verify', 'A-001']), /VERIFICATION PASSED: A-001/);
});

test('simulated-agent: review dispatches bind task, attempt, round and candidate; a lost reviewer is abandoned and its late report refused', () => {
  const p = gitProject();
  p.ok(['init', 'Review identities']);
  p.plan([H.spec('R-001', { complexity: 5 })]);
  p.ok(['next']);
  const w = worker(p, 'R-001', { 'r-001.txt': 'R\n' });
  p.ok(['result', 'R-001', '--stdin', '--worktree', w.wt, '--agent-id', 'worker-agent-1'], { input: H.report('R-001', { files: ['r-001.txt'] }) });
  p.ok(['verify', 'R-001']);
  p.ok(['review-package', 'R-001']);
  const first = p.task('R-001').review_dispatches[0];
  assert.equal(first.attempt_id, p.task('R-001').dispatch.attempt_id);
  assert.equal(first.candidate_id, p.task('R-001').evidence.verification.candidate_id);
  assert.match(first.candidate_id, new RegExp(`^commit:${w.sha}:`));
  const pinned = fs.readFileSync(path.join(p.dir, ...first.evidence.split('/')), 'utf8');
  assert.match(pinned, new RegExp(`git diff [0-9a-f]{40} ${w.sha}`));
  assert.match(pinned, /\+R/);
  // the worker cannot review its own work
  assert.match(p.refused(['review', 'R-001', '--stdin', '--agent-id', 'worker-agent-1'], { input: H.review('R-001', { reviewer: 'opus-reviewer' }) }), /agent worker-agent-1 is the worker that produced this result/);
  // an independent review needs the host's agent id
  assert.match(p.refused(['review', 'R-001', '--stdin'], { input: H.review('R-001', { reviewer: 'opus-reviewer', reviewId: first.review_id }) }), /needs --agent-id/);
  // the reviewer is lost: abandon and replace
  p.ok(['review-abandon', 'R-001', '--review', first.review_id, '--reason', 'the reviewer agent was never launched']);
  assert.match(p.refused(['review', 'R-001', '--stdin', '--agent-id', 'late-reviewer'], { input: H.review('R-001', { reviewer: 'opus-reviewer', reviewId: first.review_id }) }), new RegExp(`review ${first.review_id} was abandoned at .*a late report of an abandoned review is never applied`));
  assert.match(p.refused(['review', 'R-001', '--stdin', '--agent-id', 'x'], { input: H.review('R-001', { reviewer: 'opus-reviewer', reviewId: 'R-001-r9-000000' }) }), /review R-001-r9-000000 was never issued for R-001/);
  p.ok(['review-package', 'R-001']);
  p.ok(['review', 'R-001', '--stdin'], { input: H.review('R-001', { reviewer: 'opus-reviewer' }) });
  const second = p.task('R-001').review_dispatches[1];
  assert.equal(second.status, 'recorded');
  assert.equal(second.agent_id, 'sim-reviewer-2');
  assert.match(p.refused(['review', 'R-001', '--stdin', '--agent-id', 'again'], { input: H.review('R-001', { reviewer: 'opus-reviewer', reviewId: second.review_id }) }), /was already recorded/);
  const hist = p.task('R-001').review_dispatches.map((d) => d.status);
  assert.deepEqual(hist, ['abandoned', 'recorded'], 'the history of both dispatches is kept');
  assert.match(approve(p, 'R-001'), /APPROVED: R-001 -> APPROVED/);
});

test('simulated-agent: verification commands run without credential-like environment variables', () => {
  const p = H.project({ env: { GH_TOKEN: 'ghp_simulatedsimulatedsimulated0000', MY_API_KEY: 'k', NORMAL_SETTING: 'stays' } });
  p.ok(['init', 'Environment']);
  const check = 'node -e "process.exit(process.env.GH_TOKEN || process.env.MY_API_KEY || process.env.NORMAL_SETTING !== \'stays\' ? 1 : 0)"';
  p.plan([H.spec('A-001', { verification_commands: [H.existsCmd('a-001.txt'), check] })]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  const out = p.ok(['verify', 'A-001']);
  assert.match(out, /VERIFICATION PASSED: A-001/);
  const v = p.task('A-001').evidence.verification;
  assert.ok(v.env_removed.includes('GH_TOKEN') && v.env_removed.includes('MY_API_KEY'));
  assert.ok(!v.env_removed.includes('NORMAL_SETTING'));
  const ev = fs.readFileSync(path.join(p.dir, v.evidence_file), 'utf8');
  assert.match(ev, /Removed from the command environment \(credential-like names\): .*GH_TOKEN/);
  assert.doesNotMatch(ev, /ghp_simulated/, 'names only, never values');
});
