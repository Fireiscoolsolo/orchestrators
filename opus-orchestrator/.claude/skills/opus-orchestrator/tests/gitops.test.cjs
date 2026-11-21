'use strict';
// Tests for gitops.cjs. Every repository is a real temporary repository under os.tmpdir();
// nothing here touches the project this file lives in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const G = require('../scripts/lib/gitops.cjs');

const roots = [];

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

test.after(() => {
  for (const r of roots) {
    try {
      removeDir(r);
    } catch (_) {
      // a locked directory in the OS temp folder is not a test failure
    }
  }
});

function tmpRoot() {
  const r = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oo-git-')));
  roots.push(r);
  return r;
}

// Raw git for fixtures (independent of the module under test).
function g(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('fixture git ' + args.join(' ') + ' failed: ' + r.stderr);
  return r.stdout.trim();
}

function write(dir, rel, text) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

function configure(dir) {
  g(dir, 'config', 'user.name', 'Test User');
  g(dir, 'config', 'user.email', 'test@example.invalid');
  g(dir, 'config', 'commit.gpgsign', 'false');
  g(dir, 'config', 'core.autocrlf', 'false');
}

// Returns {root, repo}; repo has one commit (a.txt) on branch main.
function makeRepo({ commit = true } = {}) {
  const root = tmpRoot();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  configure(repo);
  if (commit) {
    write(repo, 'a.txt', 'one\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-q', '-m', 'init');
  }
  return { root, repo };
}

function commitFile(dir, rel, text, msg) {
  write(dir, rel, text);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', msg || 'change ' + rel);
  return g(dir, 'rev-parse', 'HEAD');
}

// 1 ------------------------------------------------------------------------
test('git() refuses forbidden commands without spawning git', () => {
  const missing = path.join(os.tmpdir(), 'oo-git-does-not-exist-' + process.pid);
  const forbidden = [
    ['push'],
    ['push', 'origin', 'main'],
    ['clean', '-n'],
    ['reset', '--hard'],
    ['reset', '--hard', 'HEAD~1'],
    ['checkout', '--', 'a.txt'],
    ['branch', '-D', 'x'],
    ['branch', '-Df', 'x'],
    ['worktree', 'remove', '--force', 'x'],
    ['merge', '-f', 'x'],
    ['commit', '--force'],
    ['fetch', '--force-with-lease'],
    ['-C', '.', 'push'],
  ];
  for (const args of forbidden) {
    assert.throws(
      () => G.git(args, { cwd: missing }),
      (e) => e instanceof G.GitError && e.code === 'FORBIDDEN',
      'expected FORBIDDEN for git ' + args.join(' ')
    );
  }
});

test('git() allows safe commands and free-text commit messages', () => {
  const { repo } = makeRepo();
  assert.equal(G.git(['status', '--porcelain'], { cwd: repo }).code, 0);
  write(repo, 'b.txt', 'x');
  G.git(['add', '-A'], { cwd: repo });
  const r = G.git(['commit', '-q', '-m', 'push the clean reset --hard -f'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(G.git(['branch', '-d', 'nonexistent'], { cwd: repo }).code !== 0, true);
  const res = G.git(['rev-parse', 'HEAD'], { cwd: repo });
  assert.match(res.stdout.trim(), /^[0-9a-f]{40}$/);
});

test('git() reports non-zero exit codes and stderr without throwing', () => {
  const { repo } = makeRepo();
  const r = G.git(['rev-parse', '--verify', 'no-such-ref'], { cwd: repo });
  assert.notEqual(r.code, 0);
  assert.equal(typeof r.stderr, 'string');
});

// 2 ------------------------------------------------------------------------
test('inspect: plain directory is not a repo', () => {
  const root = tmpRoot();
  const info = G.inspect(root);
  assert.equal(info.is_repo, false);
  assert.equal(info.has_commits, false);
  assert.equal(info.branch, null);
  assert.equal(info.head, null);
  assert.deepEqual(info.dirty, []);
});

test('inspect: empty repository has no commits', () => {
  const { repo } = makeRepo({ commit: false });
  const info = G.inspect(repo);
  assert.equal(info.is_repo, true);
  assert.equal(info.has_commits, false);
  assert.equal(info.head, null);
  assert.equal(info.branch, 'main');
});

test('inspect: branch, head and dirty files', () => {
  const { repo } = makeRepo();
  const head = g(repo, 'rev-parse', 'HEAD');
  write(repo, 'a.txt', 'changed\n');
  write(repo, 'new dir/new file.txt', 'n');
  const info = G.inspect(repo);
  assert.equal(info.is_repo, true);
  assert.equal(info.has_commits, true);
  assert.equal(info.branch, 'main');
  assert.equal(info.head, head);
  assert.deepEqual(info.dirty.slice().sort(), ['a.txt', 'new dir/new file.txt']);
});

test('inspect: clean repository has an empty dirty list; missing directory is not a repo', () => {
  const { repo, root } = makeRepo();
  assert.deepEqual(G.inspect(repo).dirty, []);
  assert.equal(G.inspect(path.join(root, 'nope')).is_repo, false);
});

// 3 ------------------------------------------------------------------------
test('chooseStrategy', () => {
  const ok = { is_repo: true, has_commits: true };
  assert.equal(G.chooseStrategy(ok, 'auto'), 'worktree');
  assert.equal(G.chooseStrategy(ok, 'worktree'), 'worktree');
  assert.equal(G.chooseStrategy(ok, 'shared'), 'shared');
  assert.equal(G.chooseStrategy({ is_repo: true, has_commits: false }, 'auto'), 'shared');
  assert.equal(G.chooseStrategy({ is_repo: false, has_commits: false }, 'worktree'), 'shared');
});

// 4 ------------------------------------------------------------------------
test('ensureIntegration creates the branch in a new worktree and leaves the main checkout alone', () => {
  const { root, repo } = makeRepo();
  write(repo, 'a.txt', 'uncommitted edit\n');
  write(repo, 'untracked.txt', 'u');
  const head = g(repo, 'rev-parse', 'HEAD');
  const wt = path.join(root, 'integration-wt');

  const res = G.ensureIntegration(repo, 'run1', wt);
  assert.equal(res.branch, 'opus-orch/run1/integration');
  assert.equal(res.worktree, wt);
  assert.equal(res.base, head);
  assert.ok(fs.existsSync(path.join(wt, 'a.txt')));
  assert.equal(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(g(wt, 'symbolic-ref', '--short', 'HEAD'), 'opus-orch/run1/integration');

  // main checkout untouched
  assert.equal(g(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(g(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'uncommitted edit\n');
  assert.ok(fs.existsSync(path.join(repo, 'untracked.txt')));
});

test('ensureIntegration is idempotent, also after the integration branch has moved', () => {
  const { root, repo } = makeRepo();
  const head = g(repo, 'rev-parse', 'HEAD');
  const wt = path.join(root, 'integration-wt');
  const first = G.ensureIntegration(repo, 'run2', wt);
  commitFile(wt, 'integrated.txt', 'i');
  commitFile(repo, 'user.txt', 'u'); // the user's branch moves on too
  const second = G.ensureIntegration(repo, 'run2', wt);
  assert.deepEqual(second, first);
  assert.equal(second.base, head);
  assert.equal(g(repo, 'branch', '--list', 'opus-orch/run2/integration').includes('opus-orch/run2/integration'), true);
});

test('ensureIntegration re-attaches an existing branch whose worktree was removed', () => {
  const { root, repo } = makeRepo();
  const wt = path.join(root, 'wt-a');
  G.ensureIntegration(repo, 'run3', wt);
  commitFile(wt, 'x.txt', 'x');
  const tip = g(wt, 'rev-parse', 'HEAD');
  assert.equal(G.removeWorktree(repo, wt).ok, true);
  const wt2 = path.join(root, 'wt-b');
  const res = G.ensureIntegration(repo, 'run3', wt2);
  assert.equal(g(wt2, 'rev-parse', 'HEAD'), tip);
  assert.equal(res.branch, 'opus-orch/run3/integration');
});

test('ensureIntegration rejects an unsafe run id', () => {
  const { root, repo } = makeRepo();
  assert.throws(
    () => G.ensureIntegration(repo, 'bad id; x', path.join(root, 'w')),
    (e) => e instanceof G.GitError && e.code === 'BAD_ARGS'
  );
});

// 5 ------------------------------------------------------------------------
function integrationSetup() {
  const { root, repo } = makeRepo();
  write(repo, 'shared.txt', 'base\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'add shared');
  const wt = path.join(root, 'int');
  G.ensureIntegration(repo, 'm', wt);
  return { root, repo, wt };
}

test('mergeNoCommit then commitMerge merges a task commit into the integration worktree', () => {
  const { repo, wt } = integrationSetup();
  // the task works in its own branch from the same base
  g(repo, 'checkout', '-q', '-b', 'task-1');
  const taskSha = commitFile(repo, 'feature.txt', 'feature\n', 'task work');
  g(repo, 'checkout', '-q', 'main');
  const before = g(wt, 'rev-parse', 'HEAD');

  const m = G.mergeNoCommit(wt, taskSha);
  assert.deepEqual(m, { ok: true, conflict: false, files: [] });
  assert.equal(g(wt, 'rev-parse', 'HEAD'), before, 'no commit yet');
  const sha = G.commitMerge(wt, 'merge task-1');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(g(wt, 'rev-parse', 'HEAD'), sha);
  assert.notEqual(sha, before);
  assert.equal(g(wt, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'a real merge commit');
  assert.equal(fs.readFileSync(path.join(wt, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(g(wt, 'log', '-1', '--format=%s'), 'merge task-1');
});

test('a conflicting commit reports the files; abortMerge restores a clean integration worktree', () => {
  const { repo, wt } = integrationSetup();
  commitFile(wt, 'shared.txt', 'integration side\n', 'integration edit');
  const before = g(wt, 'rev-parse', 'HEAD');

  g(repo, 'checkout', '-q', '-b', 'task-2', 'main');
  const taskSha = commitFile(repo, 'shared.txt', 'task side\n', 'task edit');
  g(repo, 'checkout', '-q', 'main');

  const m = G.mergeNoCommit(wt, taskSha);
  assert.equal(m.ok, false);
  assert.equal(m.conflict, true);
  assert.deepEqual(m.files, ['shared.txt']);
  assert.notEqual(g(wt, 'status', '--porcelain'), '');

  assert.equal(G.abortMerge(wt), true);
  assert.equal(g(wt, 'rev-parse', 'HEAD'), before);
  assert.equal(g(wt, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(path.join(wt, 'shared.txt'), 'utf8'), 'integration side\n');
  assert.equal(G.abortMerge(wt), false, 'nothing left to abort');
});

test('mergeNoCommit of an unknown commit throws COMMAND_FAILED', () => {
  const { wt } = integrationSetup();
  assert.throws(
    () => G.mergeNoCommit(wt, '0123456789012345678901234567890123456789'),
    (e) => e instanceof G.GitError && e.code === 'COMMAND_FAILED'
  );
});

test('commitMerge returns HEAD when the commit was already contained', () => {
  const { wt } = integrationSetup();
  const head = g(wt, 'rev-parse', 'HEAD');
  const m = G.mergeNoCommit(wt, head);
  assert.equal(m.ok, true);
  assert.equal(G.commitMerge(wt, 'nothing'), head);
});

// 6 ------------------------------------------------------------------------
test('fastForward advances the user branch when possible', () => {
  const { repo, wt } = integrationSetup();
  const tip = commitFile(wt, 'delivered.txt', 'd\n', 'integration work');
  const r = G.fastForward(repo, 'opus-orch/m/integration');
  assert.equal(r.ok, true, r.reason);
  assert.equal(g(repo, 'rev-parse', 'HEAD'), tip);
  assert.equal(fs.readFileSync(path.join(repo, 'delivered.txt'), 'utf8'), 'd\n');
  // already up to date is still ok
  assert.equal(G.fastForward(repo, 'opus-orch/m/integration').ok, true);
});

test('fastForward on diverged branches returns ok false with a reason and changes nothing', () => {
  const { repo, wt } = integrationSetup();
  commitFile(wt, 'int.txt', 'i\n', 'integration work');
  const userTip = commitFile(repo, 'user.txt', 'u\n', 'user work');
  const r = G.fastForward(repo, 'opus-orch/m/integration');
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, 'string');
  assert.ok(r.reason.length > 0);
  assert.equal(g(repo, 'rev-parse', 'HEAD'), userTip);
  assert.equal(g(repo, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(path.join(repo, 'int.txt')), false);
});

test('fastForward with a missing branch returns ok false', () => {
  const { repo } = makeRepo();
  const r = G.fastForward(repo, 'no/such/branch');
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not exist/);
});

// 7 ------------------------------------------------------------------------
test('commitAll returns a sha when there are changes and null otherwise', () => {
  const { repo } = makeRepo();
  assert.equal(G.commitAll(repo, 'nothing'), null);
  write(repo, 'sub/new.txt', 'n');
  write(repo, 'a.txt', 'edited\n');
  const sha = G.commitAll(repo, 'save work: push "quoted" message');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(g(repo, 'rev-parse', 'HEAD'), sha);
  assert.equal(g(repo, 'log', '-1', '--format=%s'), 'save work: push "quoted" message');
  assert.equal(g(repo, 'status', '--porcelain'), '');
  assert.equal(G.commitAll(repo, 'again'), null);
});

test('changedFiles lists files changed between two refs', () => {
  const { repo } = makeRepo();
  const base = g(repo, 'rev-parse', 'HEAD');
  write(repo, 'a.txt', 'two\n');
  write(repo, 'dir/b.txt', 'b');
  G.commitAll(repo, 'c1');
  fs.rmSync(path.join(repo, 'a.txt'));
  write(repo, 'c.txt', 'c');
  G.commitAll(repo, 'c2');
  assert.deepEqual(G.changedFiles(repo, base), ['a.txt', 'c.txt', 'dir/b.txt']);
  assert.deepEqual(G.changedFiles(repo, 'HEAD~1', 'HEAD'), ['a.txt', 'c.txt']);
  assert.deepEqual(G.changedFiles(repo, 'HEAD'), []);
});

// 8 ------------------------------------------------------------------------
test('removeWorktree refuses a dirty worktree and removes a clean one', () => {
  const { root, repo } = makeRepo();
  const wt = path.join(root, 'w1');
  G.ensureIntegration(repo, 'rw', wt);
  write(wt, 'dirty.txt', 'd');
  const refused = G.removeWorktree(repo, wt);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /uncommitted/);
  assert.ok(fs.existsSync(path.join(wt, 'dirty.txt')), 'dirty file preserved');

  G.commitAll(wt, 'clean it');
  const done = G.removeWorktree(repo, wt);
  assert.equal(done.ok, true, done.reason);
  assert.equal(fs.existsSync(wt), false);
  assert.equal(g(repo, 'worktree', 'list', '--porcelain').includes('w1'), false);
});

test('removeWorktree refuses a directory that is not a worktree of the repository', () => {
  const { root, repo } = makeRepo();
  const other = path.join(root, 'plain');
  fs.mkdirSync(other);
  const r = G.removeWorktree(repo, other);
  assert.equal(r.ok, false);
  assert.ok(fs.existsSync(other));
});

test('deleteMergedBranch refuses an unmerged branch and deletes a merged one', () => {
  const { root, repo } = makeRepo();
  const wt = path.join(root, 'w2');
  G.ensureIntegration(repo, 'db', wt);
  const br = 'opus-orch/db/integration';
  commitFile(wt, 'work.txt', 'w');
  assert.equal(G.removeWorktree(repo, wt).ok, true);

  const refused = G.deleteMergedBranch(repo, br);
  assert.equal(refused.ok, false);
  assert.equal(typeof refused.reason, 'string');
  assert.equal(g(repo, 'branch', '--list', br).includes(br), true, 'branch still exists');

  assert.equal(G.fastForward(repo, br).ok, true);
  const done = G.deleteMergedBranch(repo, br);
  assert.equal(done.ok, true, done.reason);
  assert.equal(g(repo, 'branch', '--list', br), '');
});

// 9 ------------------------------------------------------------------------
test('snapshot and diffSnapshot detect added, changed and removed files without git', () => {
  const dir = tmpRoot();
  write(dir, 'keep.txt', 'keep');
  write(dir, 'change.txt', 'old');
  write(dir, 'gone.txt', 'gone');
  write(dir, 'sub/inner.txt', 'inner');
  const before = G.snapshot(dir);
  assert.deepEqual(Object.keys(before).sort(), ['change.txt', 'gone.txt', 'keep.txt', 'sub/inner.txt']);
  assert.match(before['keep.txt'], /^\d+:[\d.]+$/);

  write(dir, 'change.txt', 'a longer replacement');
  fs.rmSync(path.join(dir, 'gone.txt'));
  write(dir, 'added.txt', 'new');
  write(dir, 'sub/deeper/added2.txt', 'new');
  const after = G.snapshot(dir);
  assert.deepEqual(G.diffSnapshot(before, after), ['added.txt', 'change.txt', 'gone.txt', 'sub/deeper/added2.txt']);
  assert.deepEqual(G.diffSnapshot(after, after), []);
});

test('snapshot skips the default ignored directories and honours a custom ignore list', () => {
  const dir = tmpRoot();
  write(dir, 'src/a.js', 'a');
  write(dir, '.git/HEAD', 'ref');
  write(dir, 'node_modules/pkg/index.js', 'x');
  write(dir, 'src/node_modules/pkg/index.js', 'x');
  write(dir, '.claude/opus-orchestrator/runs/r/run.json', '{}');
  write(dir, '.claude/settings.json', '{}');
  write(dir, '.opus-inbox/msg.md', 'm');
  const snap = G.snapshot(dir);
  assert.deepEqual(Object.keys(snap).sort(), ['.claude/settings.json', 'src/a.js']);

  const custom = G.snapshot(dir, { ignore: ['src'] });
  assert.equal('src/a.js' in custom, false);
  assert.equal('.git/HEAD' in custom, true);

  // changes inside ignored directories do not show up in a diff
  const before = G.snapshot(dir);
  write(dir, '.git/index', 'z');
  write(dir, 'node_modules/new.js', 'z');
  assert.deepEqual(G.diffSnapshot(before, G.snapshot(dir)), []);
});

test('snapshot of a missing directory is empty', () => {
  assert.deepEqual(G.snapshot(path.join(tmpRoot(), 'nope')), {});
});
