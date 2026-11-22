'use strict';
// Regressions for the findings of the independent review of the 1.0.0 audit repairs: a reused
// process id must not make a lock or an operation unrecoverable, a changed shared candidate at
// integration goes to correction, a hook planted by candidate code stops the fast-forward,
// protected files stay out of the pinned review evidence, and clean checkouts with only
// generated artifacts do not pile up.
// SIMULATED AGENTS: workers and reviewers are test code. Real oo processes, git repositories and
// worktrees; a long-running child process stands in for an unrelated program with a reused pid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const H = require('./oo-harness.cjs');
const store = require('../scripts/lib/store.cjs');

const MANAGE = path.resolve(__dirname, '..', 'scripts', 'manage_state.cjs');
const children = [];
test.after(() => {
  for (const c of children) { try { c.kill(); } catch (_) { /* gone */ } }
  H.cleanup();
});

/** A live process that is not oo: its pid plays a pid the operating system reused. */
function unrelatedProcess() {
  const c = spawn(process.execPath, ['-e', 'setTimeout(function () {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  children.push(c);
  return c;
}

function worker(p, id, files) {
  const wt = path.join(p.root, `wt-${id}-${p.task(id).attempts}`);
  H.g(p.dir, 'worktree', 'add', '-q', '-b', `agent-${id.toLowerCase()}`, wt, 'HEAD');
  H.g(wt, 'merge', '--no-edit', '-q', p.task(id).dispatch.integration_head);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), text);
  }
  H.g(wt, 'add', '-A');
  H.g(wt, 'commit', '-q', '-m', `${id}: simulated worker change`);
  return { wt, sha: H.g(wt, 'rev-parse', 'HEAD') };
}

test('a lock whose pid now belongs to an unrelated program is broken only with --pid-reused', () => {
  const p = H.project();
  p.ok(['init', 'Reused pid lock']);
  const other = unrelatedProcess();
  const lock = path.join(p.paths.stateRoot, '.lock');
  const rec = { token: crypto.randomUUID(), pid: other.pid, host: os.hostname(), acquired_at: new Date(Date.now() - 3600000).toISOString(), kind: 'oo' };
  fs.writeFileSync(lock, JSON.stringify(rec));
  const run = (...args) => spawnSync(process.execPath, [MANAGE, ...args], { encoding: 'utf8', env: p.env, windowsHide: true });
  let r = run('lock', '--break', '--token', rec.token, '--confirm-owner-stopped');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LOCK_OWNER_ALIVE[\s\S]*add --pid-reused/);
  assert.ok(fs.existsSync(lock));
  r = run('lock', '--break', '--token', rec.token, '--confirm-owner-stopped', '--pid-reused');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.existsSync(lock), false);
  p.ok(['decision', 'the lock is usable again']);
});

test('an operation whose pid now belongs to an unrelated program is taken over with --takeover <op id>', () => {
  const p = H.project();
  p.ok(['init', 'Reused pid operation']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  const other = unrelatedProcess();
  const t = p.task('A-001');
  t.status = 'VERIFYING';
  t.pending_op = Object.assign(store.newOwner('verify'), { id: crypto.randomUUID(), pid: other.pid });
  store.saveTask(p.paths, p.runId(), t);
  let out = p.refused(['verify', 'A-001']);
  assert.match(out, new RegExp(`verify ${t.pending_op.id} is already running in process ${other.pid}`));
  assert.match(out, new RegExp(`repeat with --takeover ${t.pending_op.id}`));
  out = p.ok(['verify', 'A-001', '--takeover', t.pending_op.id]);
  assert.match(out, /VERIFICATION PASSED: A-001/);
  assert.ok(p.task('A-001').history.some((h) => h.reason && h.reason.includes(`took over the interrupted verify ${t.pending_op.id}`)));
});

test('regression: a shared candidate changed after approval goes to correction at integration (no invalid transition)', () => {
  const p = H.project();
  p.ok(['init', 'Changed after approval']);
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  p.write('a-001.txt', 'A\n');
  p.ok(['result', 'A-001', '--stdin', '--verify'], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['review', 'A-001', '--stdin'], { input: H.review('A-001') });
  assert.equal(p.status('A-001'), 'APPROVED');
  p.write('a-001.txt', 'changed after the approval\n');
  const out = p.refused(['integrate', 'A-001']);
  assert.match(out, /CANDIDATE CHANGED: A-001 -> CORRECTION_REQUIRED; nothing was integrated/);
  assert.match(out, /changed since verification: a-001\.txt/);
  assert.equal(p.status('A-001'), 'CORRECTION_REQUIRED');
  assert.deepEqual(p.task('A-001').history.slice(-2).map((h) => h.to), ['INTEGRATING', 'CORRECTION_REQUIRED']);
});

test('regression: a hook planted by integration commands stops the fast-forward of the integration branch', () => {
  const p = H.project({ git: true });
  p.ok(['init', 'Planted hook']);
  const plant = 'node -e "const d=require(\'child_process\').execSync(\'git rev-parse --git-common-dir\').toString().trim(); require(\'fs\').writeFileSync(d+\'/hooks/post-merge\', \'#!/bin/sh\\necho owned\\n\')"';
  p.plan([H.spec('A-001')]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  p.ok(['verify', 'A-001']);
  p.ok(['review', 'A-001', '--stdin'], { input: H.review('A-001') });
  // the task's integration commands now include candidate code that plants a hook
  const t = p.task('A-001');
  t.verification_commands = t.verification_commands.concat([plant]);
  store.saveTask(p.paths, p.runId(), t);
  const before = p.runRecord().workspace.integration_head;
  const out = p.refused(['integrate', 'A-001']);
  assert.match(out, /MERGE FAILED: A-001 -> BLOCKED \(kind merge_failed\): the repository configuration, hooks or info files changed while the integration commands ran; the integration branch was not moved/);
  assert.equal(p.git('rev-parse', p.runRecord().workspace.integration_branch), before);
  assert.ok(fs.existsSync(path.join(p.dir, '.git', 'hooks', 'post-merge')), 'the planted hook is left for inspection');
});

test('regression: protected files are listed without content in the pinned diff of a commit candidate', () => {
  const p = H.project({ git: true });
  p.ok(['init', 'Protected diff']);
  p.plan([H.spec('S-001', { security_sensitive: true, authorized_files: ['app.txt', '.env.local'], verification_commands: [H.existsCmd('app.txt')] })]);
  p.ok(['next']);
  const w = worker(p, 'S-001', { 'app.txt': 'visible change\n', '.env.local': 'API_TOKEN=supersecretvalue123\n' });
  p.ok(['result', 'S-001', '--stdin', '--worktree', w.wt], { input: H.report('S-001', { files: ['app.txt', '.env.local'] }) });
  p.ok(['verify', 'S-001']);
  p.ok(['review-package', 'S-001']);
  const d = p.task('S-001').review_dispatches[0];
  const pinned = fs.readFileSync(path.join(p.dir, ...d.evidence.split('/')), 'utf8');
  assert.match(pinned, /=== \.env\.local\n\(protected path: content not included\)/);
  assert.match(pinned, /\+visible change/);
  assert.doesNotMatch(pinned, /supersecretvalue123/);
});

test('a clean checkout whose only changes are generated artifacts is removed, not leaked', () => {
  const p = H.project({ git: true });
  p.ok(['init', 'Generated only']);
  const cov = 'node -e "require(\'fs\').mkdirSync(\'coverage\', {recursive: true}); require(\'fs\').writeFileSync(\'coverage/lcov.info\', \'1\')"';
  p.plan([H.spec('A-001', { verification_commands: [H.existsCmd('a-001.txt'), cov] })]);
  p.ok(['next']);
  const a = worker(p, 'A-001', { 'a-001.txt': 'A\n' });
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt], { input: H.report('A-001', { files: ['a-001.txt'] }) });
  const out = p.ok(['verify', 'A-001']);
  assert.match(out, /clean checkout .*verify-A-001-[0-9a-f]{6}: removed \(only generated artifacts were in it\)/);
  const left = fs.readdirSync(path.join(p.runDir(), 'worktrees')).filter((n) => n.startsWith('verify-'));
  assert.deepEqual(left, []);
  assert.equal(H.g(p.dir, 'worktree', 'list').includes('verify-A-001'), false, 'the registration was pruned');
});
