'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const verify = require('../scripts/lib/verify.cjs');

// These tests run real commands through the detected shell (Git Bash on this
// Windows machine, bash or /bin/sh elsewhere). Commands use only `node`, which
// is on PATH because the tests themselves run under node.

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-verify-'));
  try {
    return fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (_) {
      // a killed process may hold the directory for a moment on Windows
    }
  }
}

function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[name] = old;
    else delete process.env[name];
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// findShell
// ---------------------------------------------------------------------------

test('findShell honours OPUS_ORCH_SHELL', () => {
  withEnv('OPUS_ORCH_SHELL', '/opt/custom/bash', () => {
    const s = verify.findShell();
    assert.equal(s.shell, '/opt/custom/bash');
    assert.deepEqual(s.args, ['-c']);
  });
  withEnv('OPUS_ORCH_SHELL', 'C:\\Windows\\System32\\cmd.exe', () => {
    assert.deepEqual(verify.findShell().args, ['/d', '/s', '/c']);
  });
});

test('findShell finds bash (PATH or Git for Windows) and otherwise the platform shell', () => {
  withEnv('OPUS_ORCH_SHELL', undefined, () => {
    const s = verify.findShell();
    assert.equal(typeof s.shell, 'string');
    assert.ok(Array.isArray(s.args) && s.args.length > 0);
    const gitBash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].some((p) => fs.existsSync(p));
    if (process.platform !== 'win32' || gitBash) {
      assert.match(s.shell, /bash(\.exe)?$|\/sh$/i);
      assert.deepEqual(s.args, ['-c']);
    }
    if (process.platform === 'win32' && gitBash) {
      assert.doesNotMatch(s.shell.replace(/\\/g, '/'), /\/windows\/system32\//i, 'the WSL launcher must not be chosen');
    }
  });
});

test('findShell falls back to the platform default shell when no bash exists', () => {
  withEnv('OPUS_ORCH_SHELL', undefined, () =>
    withEnv('PATH', '', () =>
      withEnv('Path', '', () =>
        withEnv('ProgramFiles', 'Z:/nonexistent', () =>
          withEnv('ProgramW6432', 'Z:/nonexistent', () =>
            withEnv('LOCALAPPDATA', 'Z:/nonexistent', () => {
              const s = verify.findShell();
              if (process.platform === 'win32') {
                // Only verifiable when Git is not installed at the fixed standard locations.
                const gitBash = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].some((p) => fs.existsSync(p));
                if (!gitBash) {
                  assert.match(s.shell, /cmd(\.exe)?$/i);
                  assert.equal(s.source, 'platform-default');
                } else {
                  assert.equal(s.source, 'git-for-windows');
                }
              } else {
                assert.equal(s.shell, '/bin/sh');
                assert.equal(s.source, 'platform-default');
              }
            })
          )
        )
      )
    )
  );
});

// ---------------------------------------------------------------------------
// runCommands
// ---------------------------------------------------------------------------

test('runCommands with an empty list gives passed null', () => {
  assert.deepEqual(verify.runCommands([], {}).passed, null);
  assert.deepEqual(verify.runCommands([], {}).commands, []);
  assert.equal(verify.runCommands(undefined, {}).passed, null);
});

test('runCommands runs commands in the given directory and records exit code, duration and output', () => {
  withTmp((dir) => {
    fs.writeFileSync(path.join(dir, 'here.txt'), 'present');
    const r = verify.runCommands(
      [
        'node -e "console.log(require(\'fs\').readFileSync(\'here.txt\', \'utf8\'))"',
        'node -e "console.log(\'to stdout\'); console.error(\'to stderr\')"',
        'echo from-the-shell && node -e "process.exit(0)"',
      ],
      { cwd: dir, timeout_ms: 30000 }
    );
    assert.equal(r.passed, true, JSON.stringify(r, null, 2));
    assert.equal(r.commands.length, 3);
    for (const c of r.commands) {
      assert.equal(c.exit_code, 0);
      assert.equal(c.timed_out, false);
      assert.equal(c.refused, false);
      assert.equal(typeof c.duration_ms, 'number');
      assert.ok(c.duration_ms >= 0);
    }
    assert.equal(r.commands[0].output_tail, 'present');
    assert.match(r.commands[1].output_tail, /to stdout/);
    assert.match(r.commands[1].output_tail, /to stderr/);
    assert.equal(r.commands[2].output_tail, 'from-the-shell');
  });
});

test('runCommands records a failing command and makes passed false', () => {
  withTmp((dir) => {
    const r = verify.runCommands(['node -e "process.exit(0)"', 'node -e "console.error(\'boom\'); process.exit(3)"'], { cwd: dir, timeout_ms: 30000 });
    assert.equal(r.passed, false);
    assert.equal(r.commands[0].exit_code, 0);
    assert.equal(r.commands[1].exit_code, 3);
    assert.equal(r.commands[1].timed_out, false);
    assert.equal(r.commands[1].refused, false);
    assert.match(r.commands[1].output_tail, /boom/);
  });
});

test('runCommands keeps only the last 40 lines of output', () => {
  withTmp((dir) => {
    const r = verify.runCommands(['node -e "for (let i = 1; i <= 100; i++) console.log(\'line\' + i)"'], { cwd: dir, timeout_ms: 30000 });
    assert.equal(r.passed, true);
    const lines = r.commands[0].output_tail.split('\n');
    assert.equal(lines.length, 40);
    assert.equal(lines[0], 'line61');
    assert.equal(lines[39], 'line100');
  });
});

test('runCommands does not execute an unsafe command, records it as refused and reports passed false', () => {
  withTmp((dir) => {
    const marker = path.join(dir, 'marker.txt');
    const unsafe = 'node -e "require(\'fs\').writeFileSync(\'marker.txt\', \'ran\')" && git push origin main';
    const r = verify.runCommands(['node -e "process.exit(0)"', unsafe], { cwd: dir, timeout_ms: 30000 });
    assert.equal(fs.existsSync(marker), false, 'the unsafe command must not run');
    assert.equal(r.passed, false);
    assert.equal(r.commands[0].exit_code, 0);
    const c = r.commands[1];
    assert.equal(c.refused, true);
    assert.equal(c.exit_code, null);
    assert.equal(c.timed_out, false);
    assert.match(c.reason, /git push/);
  });
});

test('runCommands refuses commands matching configured extra unsafe patterns', () => {
  withTmp((dir) => {
    const marker = path.join(dir, 'deployed.txt');
    const r = verify.runCommands(['node -e "require(\'fs\').writeFileSync(\'deployed.txt\', \'x\')" # deploy-prod'], {
      cwd: dir,
      timeout_ms: 30000,
      extraUnsafe: ['deploy-prod'],
    });
    assert.equal(fs.existsSync(marker), false);
    assert.equal(r.passed, false);
    assert.equal(r.commands[0].refused, true);
    assert.match(r.commands[0].reason, /configured unsafe pattern/);
  });
});

test('runCommands terminates a command that exceeds timeout_ms (including the process it started)', () => {
  withTmp((dir) => {
    const t0 = Date.now();
    const r = verify.runCommands(
      ['node -e "require(\'fs\').writeFileSync(\'pid.txt\', String(process.pid)); setTimeout(() => {}, 10000)"'],
      { cwd: dir, timeout_ms: 1500 }
    );
    const elapsed = Date.now() - t0;
    assert.equal(r.passed, false);
    const c = r.commands[0];
    assert.equal(c.timed_out, true);
    assert.equal(c.refused, false);
    assert.notEqual(c.exit_code, 0);
    assert.match(c.reason, /timed out after 1500 ms/);
    assert.ok(elapsed < 9000, `took ${elapsed} ms; the command was not terminated early`);
    const pidFile = path.join(dir, 'pid.txt');
    assert.ok(fs.existsSync(pidFile), 'the command should have started before the timeout');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(isAlive(pid), false, `process ${pid} started by the command is still running`);
  });
});

test('runCommands redacts secrets in output_tail and in the recorded command', () => {
  withTmp((dir) => {
    const r = verify.runCommands(
      [
        'node -e "console.log(\'API_KEY=abcdef123456secret\'); console.log(\'Authorization: Bearer abcDEF1234567890xyz\'); console.error(\'sk-ant-AbCdEfGhIjKlMnOpQrStUv123456\')"',
      ],
      { cwd: dir, timeout_ms: 30000 }
    );
    assert.equal(r.passed, true, JSON.stringify(r));
    const c = r.commands[0];
    for (const s of ['abcdef123456secret', 'abcDEF1234567890xyz', 'sk-ant-AbCdEfGhIjKlMnOpQrStUv123456']) {
      assert.ok(!c.output_tail.includes(s), `secret ${s} in output_tail: ${c.output_tail}`);
      assert.ok(!c.command.includes(s), `secret ${s} in command: ${c.command}`);
    }
    assert.match(c.output_tail, /API_KEY=\[REDACTED\]/);
    assert.match(c.output_tail, /Bearer \[REDACTED\]/);
  });
});

test('runCommands reports a missing working directory as a failure without running anything', () => {
  const r = verify.runCommands(['node -e "process.exit(0)"'], { cwd: path.join(os.tmpdir(), 'oo-verify-does-not-exist-' + process.pid), timeout_ms: 30000 });
  assert.equal(r.passed, false);
  assert.equal(r.commands[0].exit_code, null);
  assert.match(r.commands[0].reason, /working directory does not exist/);
});

// ---------------------------------------------------------------------------
// checkScope and verdict
// ---------------------------------------------------------------------------

test('checkScope lists files outside the authorized files', () => {
  assert.deepEqual(verify.checkScope(['src/auth/a.js', 'tests/auth/a.test.js'], ['src/auth/', 'tests/auth/']), { ok: true, violations: [] });
  assert.deepEqual(verify.checkScope(['src/auth/a.js', 'src/billing/b.js', 'README.md'], ['src/auth/']), {
    ok: false,
    violations: ['src/billing/b.js', 'README.md'],
  });
  assert.deepEqual(verify.checkScope(['.\\src\\auth\\a.js'], ['src/auth/']), { ok: true, violations: [] });
  assert.deepEqual(verify.checkScope(['src/x.js'], []), { ok: false, violations: ['src/x.js'] });
  assert.deepEqual(verify.checkScope([], []), { ok: true, violations: [] });
});

const PASS = { passed: true, commands: [{ command: 'npm test', exit_code: 0, timed_out: false, refused: false }] };
const SCOPE_OK = { ok: true, violations: [] };

test('verdict passes when commands pass, no manual check failed and scope is ok', () => {
  const v = verify.verdict({ commandsResult: PASS, checks: [], scope: SCOPE_OK });
  assert.equal(v.passed, true);
  assert.ok(v.reasons.length > 0);
  assert.equal(verify.verdict({ commandsResult: { passed: null, commands: [] }, checks: [{ name: 'ui', result: 'pass', note: 'looked' }], scope: SCOPE_OK }).passed, true);
});

test('verdict fails on a failed, timed-out or refused command', () => {
  const failed = { passed: false, commands: [{ command: 'npm test', exit_code: 1, timed_out: false, refused: false }] };
  let v = verify.verdict({ commandsResult: failed, checks: [], scope: SCOPE_OK });
  assert.equal(v.passed, false);
  assert.ok(v.reasons.some((r) => /command failed \(exit 1\): npm test/.test(r)));

  const timedOut = { passed: false, commands: [{ command: 'slow', exit_code: null, timed_out: true, refused: false }] };
  v = verify.verdict({ commandsResult: timedOut, checks: [], scope: SCOPE_OK });
  assert.equal(v.passed, false);
  assert.ok(v.reasons.some((r) => /timed out/.test(r)));

  const refused = { passed: false, commands: [{ command: 'git push', exit_code: null, timed_out: false, refused: true, reason: 'refused: git push' }] };
  v = verify.verdict({ commandsResult: refused, checks: [{ name: 'manual', result: 'pass' }], scope: SCOPE_OK });
  assert.equal(v.passed, false);
  assert.ok(v.reasons.some((r) => /command refused/.test(r)));
});

test('verdict fails on a failed manual check', () => {
  const v = verify.verdict({ commandsResult: PASS, checks: [{ name: 'layout', result: 'fail', note: 'button overlaps' }], scope: SCOPE_OK });
  assert.equal(v.passed, false);
  assert.ok(v.reasons.some((r) => /manual check failed: layout \(button overlaps\)/.test(r)));
});

test('verdict fails when the scope is not ok or was not checked', () => {
  let v = verify.verdict({ commandsResult: PASS, checks: [], scope: { ok: false, violations: ['README.md'] } });
  assert.equal(v.passed, false);
  assert.ok(v.reasons.some((r) => /outside the authorized scope: README\.md/.test(r)));
  v = verify.verdict({ commandsResult: PASS, checks: [] });
  assert.equal(v.passed, false);
  assert.ok(v.reasons.some((r) => /scope was not checked/.test(r)));
});

test('verdict fails when there is no command and no manual check', () => {
  const v = verify.verdict({ commandsResult: { passed: null, commands: [] }, checks: [], scope: SCOPE_OK });
  assert.equal(v.passed, false);
  assert.ok(v.reasons.some((r) => /no verification command and no manual check/.test(r)));
  assert.equal(verify.verdict({ commandsResult: null, checks: null, scope: SCOPE_OK }).passed, false);
});

test('verdict works end to end with runCommands and checkScope', () => {
  withTmp((dir) => {
    const commandsResult = verify.runCommands(['node -e "process.exit(0)"'], { cwd: dir, timeout_ms: 30000 });
    const scope = verify.checkScope(['src/auth/a.js'], ['src/auth/']);
    assert.equal(verify.verdict({ commandsResult, checks: [], scope }).passed, true);
    const bad = verify.checkScope(['src/other.js'], ['src/auth/']);
    assert.equal(verify.verdict({ commandsResult, checks: [], scope: bad }).passed, false);
  });
});
