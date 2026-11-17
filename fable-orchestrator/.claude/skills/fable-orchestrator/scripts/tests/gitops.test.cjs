'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gitops = require('../gitops.cjs');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-gitops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Git scope records exact paths and both sides of a rename', (t) => {
  const dir = scratch(t);
  const first = process.platform === 'win32' ? 'sp ace-é.txt' : 'sp ace-é\n.txt';
  const second = ' other-字.txt';
  const git = (args) => gitops.must(dir, args);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, first), 'content\n');
  assert.deepEqual(gitops.dirtyFiles(dir), [first]);
  git(['add', '--', first]);
  git(['commit', '-m', 'Original filename']);
  const base = git(['rev-parse', 'HEAD']);
  git(['mv', '--', first, second]);
  assert.deepEqual(new Set(gitops.dirtyFiles(dir)), new Set([first, second]));
  git(['commit', '-m', 'Renamed']);
  assert.deepEqual(new Set(gitops.changedFiles(dir, base, 'HEAD')), new Set([first, second]));
});

test('command runner filters the environment and refuses common prohibited commands', (t) => {
  const dir = scratch(t);
  process.env.FO_PRIVACY_TEST_SECRET = 'synthetic';
  t.after(() => delete process.env.FO_PRIVACY_TEST_SECRET);
  const env = gitops.runCommand('node -e "process.exit(process.env.FO_PRIVACY_TEST_SECRET ? 1 : 0)"', dir, 10000);
  assert.equal(env.exit_code, 0, env.error || env.stderr);
  assert.match(gitops.runCommand('git push', dir, 10000).error, /command refused/);
  assert.match(gitops.runCommand('bad\0command', dir, 10000).error, /NUL/);
});
