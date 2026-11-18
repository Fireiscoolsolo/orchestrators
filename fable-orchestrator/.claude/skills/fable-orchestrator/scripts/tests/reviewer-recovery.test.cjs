'use strict';
// Deterministic CLI integration tests. Git repositories and worktrees are real;
// worker and reviewer reports are test data, not live model execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const yaml = require('../miniyaml.cjs');
const sm = require('../state_manager.cjs');
const FO = path.resolve(__dirname, '..', 'fo.cjs');
const ID = 'REVIEW-001';
const AUTHOR = 'implementation-host-agent';

function fo(repo, args, input = '') {
  const r = spawnSync(process.execPath, [FO, ...args], { cwd: repo, encoding: 'utf8', input, windowsHide: true });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout}\n${r.stderr}` };
}
function ok(repo, args, input) {
  const r = fo(repo, args, input);
  assert.equal(r.code, 0, `${args.join(' ')}:\n${r.all}`);
  return r.out;
}
function rejected(repo, args, pattern, input) {
  const r = fo(repo, args, input);
  assert.notEqual(r.code, 0, `${args.join(' ')} should have been rejected`);
  assert.match(r.err, pattern);
  return r;
}
function concurrent(repo, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FO, ...args], { cwd: repo, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}
function git(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}:\n${r.stderr}`);
  return r.stdout.trim();
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function fixture(t, extraContract = {}) {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'fo-review-recovery-'));
  t.after(() => {
    assert.equal(path.dirname(scratch), temporaryRoot);
    assert.ok(path.basename(scratch).startsWith('fo-review-recovery-'));
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  });
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Orchestrator Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(path.join(repo, 'value.cjs'), 'module.exports = 1;\n');
  write(path.join(repo, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2);\n");
  git(repo, 'add', '--', 'value.cjs', 'check.cjs');
  git(repo, 'commit', '-m', 'test fixture');
  const request = path.join(scratch, 'request.txt');
  write(request, '--mode maximum Set the exported value to 2 and verify it.');
  const output = ok(repo, ['init', '--request-file', request]);
  const runDir = /run_dir: (.+)/.exec(output)[1].trim();
  const store = new sm.Store(runDir);
  const state = () => store.read();
  const task = () => state().tasks[ID];
  ok(repo, ['plan', '--stdin'], yaml.dump({
    task_id: ID, title: 'Update value', objective: 'Export exactly 2', priority: 'medium',
    dependencies: [], complexity_score: 2, risk_level: 'low', file_scope: ['value.cjs'],
    acceptance_criteria: ['The value is 2'], verification: ['Run the value check'],
    verification_commands: ['node check.cjs'], ...extraContract,
  }));
  const spec = JSON.parse(ok(repo, ['next', '--json'])).specs[0];
  const worker = path.join(scratch, 'worker');
  const branch = 'review-fixture-worker';
  git(repo, 'worktree', 'add', '-b', branch, worker, 'main');
  for (const [, sha] of spec.prompt.matchAll(/git merge --no-edit ([0-9a-f]{40})/g)) git(worker, 'merge', '--no-edit', sha);
  ok(repo, ['bind-worktree', ID, '--attempt-id', spec.attempt_id, '--worktree', worker, '--branch', branch, '--agent-id', AUTHOR]);
  write(path.join(worker, 'value.cjs'), 'module.exports = 2;\n');
  git(worker, 'add', '--', 'value.cjs');
  git(worker, 'commit', '-m', 'implement value');
  ok(repo, ['report', ID, '--stdin', '--verify'], yaml.dump({
    task_id: ID, attempt_id: spec.attempt_id, status: 'implemented', summary: 'Set the value to 2',
    files_changed: ['value.cjs'], verification: { tests_run: true, tests_passed: true, build_passed: null },
    known_issues: [], commit: git(worker, 'rev-parse', 'HEAD'), branch, worktree_path: worker,
  }));
  assert.equal(task().state, 'REVIEWING');
  return { repo, worker, runDir, store, state, task };
}
function dispatch(f, perspective = 'correctness') {
  const text = ok(f.repo, ['review-package', ID, '--perspective', perspective]);
  return { text, ...f.task().review_dispatches.at(-1) };
}
function report(d, verdict = 'approve', overrides = {}) {
  return yaml.dump({
    task_id: ID, reviewer: 'review-worker', perspective: d.perspective, verdict,
    attempt_id: d.attempt, review_dispatch_id: d.id, candidate_commit: d.candidate,
    candidate_tree: d.candidate_tree, criteria: [{ met: verdict === 'approve', evidence: 'Pinned candidate diff and recorded value check inspected' }],
    findings: verdict === 'reject' ? ['A correction is required for this criterion'] : [], ...overrides,
  });
}
const recoveryArgs = (d, liveness, extra = []) => ['reconcile', ID, '--review-dispatch-id', d.id,
  '--liveness', liveness, ...extra, '--reason', 'Operator inspected host status for this exact dispatch'];
function orchestratorReview(f) {
  return ok(f.repo, ['review', ID, '--stdin'], yaml.dump({
    task_id: ID, reviewer: 'orchestrator', candidate_commit: f.task().verified_candidate.commit, verdict: 'approve',
    criteria: [{ met: true, evidence: 'Pinned commit and recorded verification inspected' }], findings: [],
  }));
}

test('review completes normally with authoritative host identity, candidate, and persisted evidence', (t) => {
  const f = fixture(t), d = dispatch(f);
  assert.equal(d.status, 'unknown');
  assert.equal(d.task_id, ID);
  assert.equal(d.candidate_tree, git(f.repo, 'rev-parse', `${d.candidate}^{tree}`));
  assert.match(d.text, new RegExp(`Verified commit: ${d.candidate}`));
  assert.match(d.text, new RegExp(`Verified tree: ${d.candidate_tree}`));
  assert.match(d.text, /--agent-id <host ID>/);
  ok(f.repo, recoveryArgs(d, 'active', ['--agent-id', 'reviewer-1']));
  ok(f.repo, ['review', ID, '--agent-id', 'reviewer-1', '--stdin'], report(d));
  const completed = f.task().review_dispatches[0];
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.history.map((e) => e.status), ['unknown', 'active', 'completed']);
  assert.equal(completed.agent_id, 'reviewer-1');
  assert.equal(completed.verdict, 'approve');
  assert.equal(f.task().reviews[0].candidate_tree, d.candidate_tree);
  const evidence = fs.readFileSync(path.join(f.runDir, 'reviews', `${ID}-c1-1.yaml`), 'utf8');
  assert.match(evidence, new RegExp(d.id));
  assert.match(evidence, new RegExp(d.attempt));
  rejected(f.repo, ['review', ID, '--agent-id', 'reviewer-1', '--stdin'], /INVALID_REVIEW_DISPATCH/, report(d));
  rejected(f.repo, recoveryArgs(d, 'failed', ['--abandon']), /REVIEW_TERMINAL/);
  assert.match(orchestratorReview(f), /APPROVED/);
});

test('lost reviewer survives resume, requires explicit abandonment, and is replaced without accepting late reports', (t) => {
  const f = fixture(t), old = dispatch(f);
  assert.match(ok(f.repo, ['resume']), /retained without replacement/);
  assert.equal(JSON.parse(ok(f.repo, ['next', '--json'])).specs.length, 0);
  rejected(f.repo, ['review-package', ID], /REVIEW_ALREADY_DISPATCHED/);
  ok(f.repo, recoveryArgs(old, 'unknown'));
  assert.equal(f.task().review_dispatches[0].status, 'unknown');
  rejected(f.repo, ['review-package', ID], /REVIEW_ALREADY_DISPATCHED/);
  const abandon = recoveryArgs(old, 'unknown', ['--abandon']);
  assert.match(ok(f.repo, abandon), /Late reports.*rejected/);
  const retired = f.task().review_dispatches[0];
  assert.equal(retired.status, 'abandoned');
  assert.match(ok(f.repo, ['resume']), /review-package/);
  ok(f.repo, abandon);
  assert.deepEqual(f.task().review_dispatches[0], retired, 'duplicate abandonment preserves dispatch history');
  rejected(f.repo, ['review', ID, '--agent-id', 'late-reviewer', '--stdin'], /INVALID_REVIEW_DISPATCH/, report(old));
  const replacement = dispatch(f);
  assert.notEqual(replacement.id, old.id);
  assert.equal(replacement.candidate, old.candidate);
  assert.equal(replacement.candidate_tree, old.candidate_tree);
  assert.equal(f.task().review_dispatches[0].status, 'superseded');
  assert.equal(f.task().review_dispatches[0].resolution, 'abandoned');
  assert.equal(f.task().review_dispatches[0].superseded_by, replacement.id);
  assert.deepEqual(f.task().review_dispatches[0].history.map((e) => e.status), ['unknown', 'abandoned', 'superseded']);
  const superseded = f.task().review_dispatches[0];
  ok(f.repo, abandon);
  assert.deepEqual(f.task().review_dispatches[0], superseded);
  assert.match(ok(f.repo, ['resume']), new RegExp(replacement.id));
  rejected(f.repo, ['review-package', ID], /REVIEW_ALREADY_DISPATCHED/);
  rejected(f.repo, ['review', ID, '--agent-id', 'late-reviewer', '--stdin'], /INVALID_REVIEW_DISPATCH/, report(old));
  assert.equal(f.task().reviews.length, 0);
  ok(f.repo, ['review', ID, '--agent-id', 'replacement-reviewer', '--stdin'], report(replacement));
  assert.match(orchestratorReview(f), /APPROVED/);
  assert.equal(f.state().budget.agent_calls, 3, 'original and replacement reviewers each consume a call');
});

test('failed reviewer permits a replacement whose rejection enters the normal correction workflow', (t) => {
  const f = fixture(t), old = dispatch(f);
  ok(f.repo, recoveryArgs(old, 'failed', ['--agent-id', 'failed-reviewer']));
  assert.equal(f.task().review_dispatches[0].status, 'failed');
  rejected(f.repo, recoveryArgs(old, 'active', ['--agent-id', 'failed-reviewer']), /REVIEW_TERMINAL/);
  const replacement = dispatch(f);
  assert.equal(f.task().review_dispatches[0].resolution, 'failed');
  rejected(f.repo, ['review', ID, '--agent-id', 'failed-reviewer', '--stdin'], /INVALID_REVIEW_DISPATCH/, report(old));
  rejected(f.repo, ['review', ID, '--agent-id', 'failed-reviewer', '--stdin'], /INVALID_REVIEW_DISPATCH/, report(replacement));
  assert.match(ok(f.repo, ['review', ID, '--agent-id', 'replacement-reviewer', '--stdin'], report(replacement, 'reject')), /CORRECTION_REQUIRED/);
  assert.equal(f.task().review_dispatches[1].verdict, 'reject');
  assert.equal(f.task().state, 'CORRECTION_REQUIRED');
});

test('confirmed active reviewer cannot be silently downgraded or abandoned before a failed host observation', (t) => {
  const f = fixture(t), d = dispatch(f);
  rejected(f.repo, recoveryArgs(d, 'active'), /BAD_ARGUMENTS/);
  ok(f.repo, recoveryArgs(d, 'active', ['--agent-id', 'active-reviewer']));
  const active = f.task().review_dispatches[0];
  rejected(f.repo, recoveryArgs(d, 'active', ['--abandon']), /REVIEW_ACTIVE/);
  rejected(f.repo, recoveryArgs(d, 'unknown', ['--abandon']), /REVIEW_ACTIVE/);
  rejected(f.repo, recoveryArgs(d, 'unknown'), /REVIEW_ACTIVE/);
  rejected(f.repo, recoveryArgs(d, 'failed', ['--agent-id', 'different-reviewer']), /INVALID_REVIEW_DISPATCH/);
  rejected(f.repo, ['review-package', ID], /REVIEW_ALREADY_DISPATCHED/);
  assert.deepEqual(f.task().review_dispatches[0], active);
  ok(f.repo, recoveryArgs(d, 'failed'));
  ok(f.repo, recoveryArgs(d, 'failed', ['--abandon']));
  assert.deepEqual(f.task().review_dispatches[0].history.map((e) => e.status), ['unknown', 'active', 'failed', 'abandoned']);
  assert.notEqual(dispatch(f).id, d.id);
});

test('review recovery validates task, dispatch, attempt, perspective, candidate, and reviewer independence', (t) => {
  const f = fixture(t, { risk_level: 'high' });
  const correctness = dispatch(f), security = dispatch(f, 'security');
  rejected(f.repo, ['reconcile', ID, '--liveness', 'failed', '--abandon', '--reason', 'test'], /BAD_ARGUMENTS/);
  rejected(f.repo, recoveryArgs({ id: 'not-a-dispatch' }, 'failed'), /INVALID_REVIEW_DISPATCH/);
  rejected(f.repo, recoveryArgs(correctness, 'stopped'), /BAD_ARGUMENTS/);
  rejected(f.repo, ['reconcile', ID, '--review-dispatch-id', correctness.id, '--liveness', 'unknown', '--abandon'], /BAD_ARGUMENTS/);
  rejected(f.repo, recoveryArgs(correctness, 'active', ['--agent-id', AUTHOR]), /INVALID_REVIEW_DISPATCH/);
  rejected(f.repo, ['review', ID, '--agent-id', AUTHOR, '--stdin'], /INVALID_REVIEW_DISPATCH/, report(correctness));
  for (const overrides of [{ attempt_id: 'old-attempt' }, { perspective: 'security' }, { review_dispatch_id: security.id }]) {
    rejected(f.repo, ['review', ID, '--agent-id', 'reviewer-a', '--stdin'], /INVALID_REVIEW_DISPATCH/, report(correctness, 'approve', overrides));
  }
  rejected(f.repo, ['review', ID, '--agent-id', 'reviewer-a', '--stdin'], /INVALID_REVIEW/, report(correctness, 'approve', { task_id: 'OTHER-001' }));
  rejected(f.repo, ['review', ID, '--agent-id', 'reviewer-a', '--stdin'], /STALE_EVIDENCE/, report(correctness, 'approve', { candidate_tree: '0'.repeat(40) }));
  ok(f.repo, ['review', ID, '--agent-id', 'reviewer-a', '--stdin'], report(correctness));
  rejected(f.repo, ['review', ID, '--agent-id', 'reviewer-a', '--stdin'], /INVALID_REVIEW_DISPATCH/, report(security));
  rejected(f.repo, recoveryArgs(security, 'active', ['--agent-id', 'reviewer-a']), /INVALID_REVIEW_DISPATCH/);
  ok(f.repo, ['review', ID, '--agent-id', 'reviewer-b', '--stdin'], report(security));
  assert.equal(f.task().state, 'REVIEWING', 'both perspectives still require the orchestrator review');
  assert.match(orchestratorReview(f), /APPROVED/);
});

test('concurrent reconcilers and replacement requests preserve one retirement and one replacement', async (t) => {
  const f = fixture(t), old = dispatch(f);
  const results = await Promise.all([concurrent(f.repo, recoveryArgs(old, 'unknown', ['--abandon'])), concurrent(f.repo, recoveryArgs(old, 'unknown', ['--abandon']))]);
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  assert.equal(f.task().review_dispatches[0].history.filter((e) => e.status === 'abandoned').length, 1);
  const events = fs.readFileSync(path.join(f.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((e) => e.type === 'review_reconciled' && e.dispatch === old.id).length, 1);
  const replacements = await Promise.all([concurrent(f.repo, ['review-package', ID]), concurrent(f.repo, ['review-package', ID])]);
  assert.equal(replacements.filter((r) => r.code === 0).length, 1, JSON.stringify(replacements));
  assert.match(replacements.find((r) => r.code !== 0).err, /REVIEW_ALREADY_DISPATCHED/);
  assert.equal(f.task().review_dispatches.length, 2);
  const replacement = f.task().review_dispatches[1];
  const race = await Promise.all([
    concurrent(f.repo, ['review', ID, '--agent-id', 'replacement-reviewer', '--stdin'], report(replacement)),
    concurrent(f.repo, recoveryArgs(replacement, 'unknown', ['--abandon'])),
  ]);
  assert.equal(race.filter((r) => r.code === 0).length, 1, JSON.stringify(race));
  const terminal = f.task().review_dispatches[1].status;
  assert.ok(['completed', 'abandoned'].includes(terminal));
  assert.equal(f.task().reviews.length, terminal === 'completed' ? 1 : 0, 'an abandoned dispatch never approves');
});

test('replacement refuses changed verification identity and stays pinned when only the worker branch advances', (t) => {
  const f = fixture(t), old = dispatch(f);
  ok(f.repo, recoveryArgs(old, 'unknown', ['--abandon']));
  write(path.join(f.worker, 'value.cjs'), 'module.exports = 3;\n');
  git(f.worker, 'add', '--', 'value.cjs');
  git(f.worker, 'commit', '-m', 'unverified later change');
  const later = git(f.worker, 'rev-parse', 'HEAD');
  // Fault injection represents a changed persisted attempt, not an approved CLI transition.
  f.store.transact((state) => { sm.lastAttempt(state.tasks[ID]).commit = later; });
  rejected(f.repo, ['review-package', ID], /STALE_EVIDENCE/);
  assert.equal(f.task().review_dispatches.length, 1);
  f.store.transact((state) => { sm.lastAttempt(state.tasks[ID]).commit = old.candidate; state.tasks[ID].verified_candidate.tree = '0'.repeat(40); });
  rejected(f.repo, ['review-package', ID], /STALE_EVIDENCE/);
  f.store.transact((state) => { state.tasks[ID].verified_candidate.tree = old.candidate_tree; });
  const replacement = dispatch(f);
  assert.equal(replacement.candidate, old.candidate);
  assert.notEqual(replacement.candidate, later);
  rejected(f.repo, ['review', ID, '--agent-id', 'replacement-reviewer', '--stdin'], /STALE_EVIDENCE/, report(replacement, 'approve', { candidate_commit: later }));
  ok(f.repo, ['review', ID, '--agent-id', 'replacement-reviewer', '--stdin'], report(replacement));
});

test('legacy pending reviewer records can be reconciled without inferring completion from a bound identity', (t) => {
  const f = fixture(t), d = dispatch(f);
  f.store.transact((state) => {
    const legacy = state.tasks[ID].review_dispatches[0];
    for (const key of ['status', 'history', 'task_id', 'candidate_tree', 'dispatched_at']) delete legacy[key];
  });
  ok(f.repo, recoveryArgs(d, 'active', ['--agent-id', 'legacy-reviewer']));
  assert.equal(f.task().review_dispatches[0].status, 'active');
  assert.deepEqual(f.task().review_dispatches[0].history.map((e) => e.status), ['unknown', 'active']);
  ok(f.repo, ['review', ID, '--agent-id', 'legacy-reviewer', '--stdin'], report(d));
  assert.equal(f.task().review_dispatches[0].status, 'completed');
});

test('replacement reviews remain subject to the agent-call budget', (t) => {
  const f = fixture(t), d = dispatch(f);
  ok(f.repo, recoveryArgs(d, 'unknown', ['--abandon']));
  f.store.transact((state) => { state.config.budget.agent_call_limit = state.budget.agent_calls; });
  rejected(f.repo, ['review-package', ID], /BUDGET_LIMIT/);
  assert.equal(f.task().review_dispatches[0].status, 'abandoned');
  assert.equal(f.task().review_dispatches.length, 1);
});
