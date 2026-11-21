'use strict';
// Worktree strategy of the oo CLI on a real temporary git repository.
// SIMULATED AGENTS: each "worker" is test code that creates its own worktree and branch (as the
// Agent tool's isolation: worktree would), commits there and feeds a YAML report to oo result.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./oo-harness.cjs');

test.after(H.cleanup);

function contentCmd(file, text) {
  return `node -e "process.exit(require('fs').readFileSync('${file}','utf8').includes('${text}')?0:1)"`;
}

/** Simulated worker: own worktree and branch from the main checkout's HEAD, optional merge of the integration head. */
function worker(p, id, branch, files, { merge }) {
  const wt = path.join(p.root, `wt-${id}`);
  H.g(p.dir, 'worktree', 'add', '-q', '-b', branch, wt, 'HEAD');
  if (merge) H.g(wt, 'merge', '--no-edit', p.task(id).dispatch.integration_head);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(wt, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  H.g(wt, 'add', '-A');
  H.g(wt, 'commit', '-q', '-m', `${id}: simulated worker change`);
  return { wt, sha: H.g(wt, 'rev-parse', 'HEAD') };
}

function finish(p, id, w, branch, files) {
  p.ok(['result', id, '--stdin', '--worktree', w.wt, '--branch', branch], { input: H.report(id, { files, commit: w.sha, branch }) });
  const v = p.ok(['verify', id]);
  assert.match(v, new RegExp(`VERIFICATION PASSED: ${id}`));
  p.ok(['review', id, '--stdin'], { input: H.review(id) });
  return v;
}

test('simulated-agent: worktree strategy verifies in the task worktree, merges into the integration branch, blocks a conflict and fast-forwards on deliver', () => {
  const p = H.project({ git: true });
  p.write('notes.txt', 'user notes\n');
  p.write('shared.txt', 'base line\n');
  p.git('add', '-A');
  p.git('commit', '-q', '-m', 'fixtures');
  const base = p.git('rev-parse', 'HEAD');
  // uncommitted user changes in the main checkout
  p.write('notes.txt', 'user notes\nan uncommitted user edit\n');
  p.write('scratch.txt', 'an untracked user file\n');

  let out = p.ok(['init', 'Worktree run']);
  const run = p.runRecord();
  const intBranch = run.workspace.integration_branch;
  assert.equal(intBranch, `opus-orch/${run.run_id}/integration`);
  assert.match(out, /Workspace strategy: worktree \(integration branch opus-orch\/.*\/integration/);
  assert.match(out, /2 uncommitted file\(s\) in the main checkout \(notes\.txt, scratch\.txt\): they are left untouched/);
  const intHead = () => p.git('rev-parse', intBranch);
  assert.equal(intHead(), base);

  p.plan([
    H.spec('A-001', { authorized_files: ['src/a.txt'], verification_commands: [H.existsCmd('src/a.txt')] }),
    H.spec('C-001', { authorized_files: ['shared.txt'], verification_commands: [contentCmd('shared.txt', 'C version')] }),
    H.spec('D-001', { authorized_files: ['shared.txt'], verification_commands: [H.existsCmd('shared.txt')] }),
  ]);
  out = p.ok(['next']);
  assert.match(out, /=== A-001 [\s\S]*isolation=worktree/);
  assert.match(out, /=== C-001 /);
  assert.match(out, /D-001: scope_conflict/);
  const pkgA = fs.readFileSync(path.join(p.runDir(), 'packages', 'A-001-d1.md'), 'utf8');
  assert.match(pkgA, new RegExp(`Before anything else run: git merge --no-edit ${base}`));
  assert.match(pkgA, /Commit your changes on your branch/);
  p.ok(['started', 'A-001', 'C-001']);

  // A: verified in its own worktree, merged into the integration branch
  const a = worker(p, 'A-001', 'agent-a', { 'src/a.txt': 'A\n' }, { merge: true });
  out = finish(p, 'A-001', a, 'agent-a', ['src/a.txt']);
  assert.match(out, /Changed files: src\/a\.txt\n/);
  const va = p.task('A-001').evidence.verification;
  assert.equal(path.resolve(va.workspace), path.resolve(a.wt), 'verification ran in the task worktree');
  assert.equal(p.task('A-001').result.commit, a.sha);
  out = p.ok(['integrate', 'A-001']);
  assert.match(out, new RegExp(`INTEGRATED: A-001 -> COMPLETED \\(merge commit [0-9a-f]{40} on ${intBranch.replace(/\//g, '\\/')}\\)`));
  assert.notEqual(intHead(), base);
  assert.equal(p.git('show', `${intBranch}:src/a.txt`), 'A');
  assert.equal(p.task('A-001').evidence.integration.merged_commit, intHead());

  // C: also merged
  const c = worker(p, 'C-001', 'agent-c', { 'shared.txt': 'C version\n' }, { merge: true });
  finish(p, 'C-001', c, 'agent-c', ['shared.txt']);
  p.ok(['integrate', 'C-001']);
  assert.equal(p.status('C-001'), 'COMPLETED');
  const headAfterC = intHead();

  // D: dispatched once C no longer owns shared.txt; the simulated worker ignores the merge rule
  out = p.ok(['next']);
  assert.match(out, /=== D-001 /);
  assert.equal(p.task('D-001').dispatch.integration_head, headAfterC);
  p.ok(['started', 'D-001']);
  const d = worker(p, 'D-001', 'agent-d', { 'shared.txt': 'D version\n' }, { merge: false });
  finish(p, 'D-001', d, 'agent-d', ['shared.txt']);
  out = p.refused(['integrate', 'D-001']);
  assert.match(out, /MERGE CONFLICT: D-001 -> BLOCKED \(kind merge_conflict\)/);
  assert.match(out, /Conflicting files: shared\.txt/);
  assert.match(out, /integration branch is unchanged/);
  const dt = p.task('D-001');
  assert.equal(dt.status, 'BLOCKED');
  assert.equal(dt.block.kind, 'merge_conflict');
  assert.equal(intHead(), headAfterC, 'the integration branch is unchanged');
  const intDir = path.join(p.dir, ...run.workspace.integration_worktree.split('/'));
  assert.equal(H.g(intDir, 'status', '--porcelain'), '', 'the aborted merge left the integration worktree clean');

  assert.match(p.refused(['deliver']), /D-001 is BLOCKED/);
  p.ok(['cancel', 'D-001', '--reason', 'the conflicting change is not wanted']);

  // deliver fast-forwards the user's branch; uncommitted user changes survive
  out = p.ok(['deliver']);
  assert.match(out, new RegExp(`DELIVERED: main fast-forwarded to ${headAfterC}`));
  assert.equal(p.git('rev-parse', 'HEAD'), headAfterC);
  assert.equal(p.read('src/a.txt'), 'A\n');
  assert.equal(p.read('shared.txt'), 'C version\n');
  assert.equal(p.read('notes.txt'), 'user notes\nan uncommitted user edit\n');
  assert.equal(p.read('scratch.txt'), 'an untracked user file\n');
  const st = p.git('status', '--porcelain');
  assert.match(st, /^ ?M notes\.txt$/m); // the fixture helper trims the leading space of " M"
  assert.match(st, /^\?\? scratch\.txt$/m);

  out = p.ok(['cleanup']);
  assert.match(out, /worktree .*integration: removed/);
  assert.match(out, new RegExp(`branch ${intBranch.replace(/\//g, '\\/')}: deleted`));
  assert.equal(p.read('notes.txt'), 'user notes\nan uncommitted user edit\n');

  out = p.ok(['final-report']);
  assert.match(out, /Overall status: PARTIAL/);
  assert.match(out, /Delivered: yes/);
});

test('simulated-agent: worktree verification fails for uncommitted work and for files outside the scope', () => {
  const p = H.project({ git: true });
  p.ok(['init', 'Worktree scope']);
  p.plan([H.spec('A-001', { authorized_files: ['src/a.txt'], verification_commands: [H.existsCmd('src/a.txt')] })]);
  p.ok(['next']);
  const a = worker(p, 'A-001', 'agent-a', { 'src/a.txt': 'A\n', 'other.txt': 'outside\n' }, { merge: true });
  fs.writeFileSync(path.join(a.wt, 'left-over.txt'), 'not committed\n');
  p.ok(['result', 'A-001', '--stdin', '--worktree', a.wt, '--branch', 'agent-a'], { input: H.report('A-001', { files: ['src/a.txt', 'other.txt'], commit: a.sha }) });
  const out = p.refused(['verify', 'A-001']);
  assert.match(out, /VERIFICATION FAILED: A-001 -> CORRECTION_REQUIRED/);
  assert.match(out, /manual check failed: work committed \(uncommitted changes in the worktree: left-over\.txt\)/);
  assert.match(out, /Scope violations \(changed outside the authorized files\): other\.txt/);
  assert.match(p.refused(['result', 'A-001', '--stdin'], { input: H.report('A-001') }), /A-001 is CORRECTION_REQUIRED/);
});
