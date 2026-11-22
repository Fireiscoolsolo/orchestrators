'use strict';
// Fault injection for tests: preloaded with `node -r tests/faults/git-faults.cjs scripts/oo.cjs ...`.
// It replaces child_process.spawnSync before oo loads its modules, and changes the outcome of
// selected git invocations only. Production code has no test hooks; this file is never loaded
// outside the tests (and is not a test file itself: no .test.cjs suffix).
//   OO_TEST_FAULT=status-denied     `git status` in OO_TEST_FAULT_DIR exits 128 (permission denied)
//   OO_TEST_FAULT=status-malformed  `git status` in OO_TEST_FAULT_DIR prints output without NUL separators
//   OO_TEST_FAULT=crash-after-ff    the process exits (code 9) right after a successful `git merge --ff-only`
const cp = require('node:child_process');
const path = require('node:path');

const fault = process.env.OO_TEST_FAULT || '';
const dir = process.env.OO_TEST_FAULT_DIR ? path.resolve(process.env.OO_TEST_FAULT_DIR).toLowerCase() : null;
const real = cp.spawnSync;

function inDir(opts) {
  if (!dir) return true;
  const cwd = opts && opts.cwd ? path.resolve(String(opts.cwd)).toLowerCase() : '';
  return cwd === dir;
}

cp.spawnSync = function faultySpawnSync(cmd, args, opts) {
  if (cmd === 'git' && Array.isArray(args)) {
    if (fault === 'status-denied' && args[0] === 'status' && inDir(opts)) {
      return { status: 128, stdout: '', stderr: 'fatal: cannot open .git/index: Permission denied\n', signal: null, pid: 0, output: [] };
    }
    if (fault === 'status-malformed' && args[0] === 'status' && inDir(opts)) {
      return { status: 0, stdout: 'M  half-written entry without separators', stderr: '', signal: null, pid: 0, output: [] };
    }
    const r = real.call(cp, cmd, args, opts);
    if (fault === 'crash-after-ff' && args[0] === 'merge' && args[1] === '--ff-only' && r.status === 0) process.exit(9);
    return r;
  }
  return real.call(cp, cmd, args, opts);
};
