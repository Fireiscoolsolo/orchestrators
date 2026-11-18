'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ops = require('../gitops.cjs');

test('Git version parsing accepts supported Windows, Apple and Linux versions', () => {
  for (const value of ['git version 2.36.0', 'git version 2.56.0.windows.4', 'git version 2.39.5 (Apple Git-154)', 'git version 3.0.0']) {
    assert.ok(ops.requireWorktreeSupport('.', () => ({ code: 0, out: value })));
  }
});

test('Git version check rejects old, missing and malformed versions without worktree commands', () => {
  for (const result of [{ code: 0, out: 'git version 2.35.9' }, { code: -1, out: '' }, { code: 0, out: 'unknown' }, { code: 0, out: 'git version 2.36oops' }, { code: 0, out: 'git version 2.36.0oops' }]) {
    const calls = [];
    assert.throws(() => ops.requireWorktreeSupport('.', (cwd, args) => { calls.push(args); return result; }), /Git 2\.36.*Upgrade Git.*shared/);
    assert.deepEqual(calls, [['--version']]);
  }
});

function initWithGit(t, shared, present) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-git-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (shared) {
    fs.mkdirSync(path.join(dir, '.claude', 'fable-orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'fable-orchestrator', 'config.yaml'), 'isolation:\n  strategy: shared\n');
  }
  const script = `const ops = require(${JSON.stringify(require.resolve('../gitops.cjs'))});
    ops.available = () => ${present};
    ops.inspect = () => ({ enabled: true, base_sha: 'a'.repeat(40), base_branch: 'main', dirty: [] });
    ops.requireWorktreeSupport = () => { throw new Error('Git 2.36 or newer is required'); };`;
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, script);
  return { dir, result: spawnSync(process.execPath, ['-r', preload, require.resolve('../fo.cjs'), 'init', 'Version check'], { cwd: dir, encoding: 'utf8' }) };
}

test('unsupported Git fails init before writing run state or starting worktrees', (t) => {
  const { dir, result } = initWithGit(t, false, true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Git 2\.36/);
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'fable-orchestrator', 'runs')), false);
});

test('explicit shared mode does not require worktree compatibility', (t) => {
  const { result } = initWithGit(t, true, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shared/);
});

test('missing Git retains the documented shared workspace fallback', (t) => {
  const { result } = initWithGit(t, false, false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /shared/);
});
