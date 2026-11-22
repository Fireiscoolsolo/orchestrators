'use strict';
// State lock: ownership tokens, owner-aware release, liveness-based takeover, recovery guards.
// Real child processes play the other lock holders; nothing is mocked inside store.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const store = require('../scripts/lib/store.cjs');
const H = require('./oo-harness.cjs');

const STORE = path.resolve(__dirname, '..', 'scripts', 'lib', 'store.cjs');
const MANAGE = path.resolve(__dirname, '..', 'scripts', 'manage_state.cjs');
const roots = [];
test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  H.cleanup();
});

function setup() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'oo-lock-')));
  roots.push(root);
  const paths = store.resolvePaths({ projectDir: root });
  store.ensureState(paths);
  return { root, paths, lock: path.join(paths.stateRoot, '.lock') };
}

function code(fn) {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
}

/**
 * A process id that belongs to no process. A just-exited child's id is not used: under load the
 * operating system may hand it to a new process at once, and the lock (correctly) treats that
 * owner as alive. Ids near 2^31 are above every platform's pid range; each is confirmed absent.
 */
let nextDead = 2147480000;
function deadPid() {
  for (;;) {
    const pid = nextDead++;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return pid;
    }
  }
}

function record(extra) {
  return Object.assign({ token: crypto.randomUUID(), pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString(), kind: 'oo' }, extra);
}

/** Runs a script in a child process with STORE and the state paths available. */
function child(paths, body, { wait = true } = {}) {
  const script = `const store = require(${JSON.stringify(STORE)}); const paths = store.resolvePaths({ projectDir: ${JSON.stringify(paths.projectDir)} });\n${body}`;
  if (wait) return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('withLock publishes a complete owner record with a unique token and releases it', () => {
  const { paths, lock } = setup();
  let seen;
  assert.equal(store.withLock(paths, () => {
    seen = JSON.parse(fs.readFileSync(lock, 'utf8'));
    store.assertLockHeld(paths);
    return 42;
  }), 42);
  assert.match(seen.token, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.host, os.hostname());
  assert.ok(!Number.isNaN(Date.parse(seen.acquired_at)));
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => store.withLock(paths, () => { throw new Error('boom'); }), /boom/);
  assert.equal(fs.existsSync(lock), false, 'released after a throw');
  let second;
  store.withLock(paths, () => { second = JSON.parse(fs.readFileSync(lock, 'utf8')).token; });
  assert.notEqual(second, seen.token, 'every acquisition has its own token');
  assert.deepEqual(fs.readdirSync(paths.stateRoot).filter((n) => n.includes('.claim-')), [], 'no claim file is left');
});

test('regression: a live owner keeps its lock however old the record is (age never establishes death)', () => {
  const { paths, lock } = setup();
  const old = record({ acquired_at: new Date(Date.now() - 3600 * 1000).toISOString(), ts: Date.now() - 3600 * 1000 });
  fs.writeFileSync(lock, JSON.stringify(old));
  const t0 = Date.now();
  const e = (() => { try { store.withLock(paths, () => 1, { waitMs: 400 }); } catch (x) { return x; } return null; })();
  assert.equal(e && e.code, 'LOCK_TIMEOUT');
  assert.ok(Date.now() - t0 >= 400);
  assert.match(e.message, /owner alive/);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), old, 'the live lock is untouched');
});

test('a lock whose owner process is dead on this host is taken over and kept as evidence', () => {
  const { paths, lock } = setup();
  const dead = record({ pid: deadPid() });
  fs.writeFileSync(lock, JSON.stringify(dead));
  assert.equal(store.ownerState(dead), 'dead');
  assert.equal(store.withLock(paths, () => 'mine'), 'mine');
  const evidence = path.join(paths.stateRoot, `.lock.reaped-${dead.token}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(evidence, 'utf8')), dead);
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(paths.stateRoot).filter((n) => n.includes('.reap-')), [], 'the reaper guard was removed by its owner');
});

test('a lock from another host, a legacy record or an unreadable record is never taken over automatically', () => {
  const { paths, lock } = setup();
  const foreign = record({ host: `${os.hostname()}-elsewhere`, pid: deadPid() });
  fs.writeFileSync(lock, JSON.stringify(foreign));
  assert.equal(store.ownerState(foreign), 'unknown');
  assert.equal(code(() => store.withLock(paths, () => 1, { waitMs: 200 })), 'LOCK_TIMEOUT');
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), foreign);

  const legacy = { pid: deadPid(), ts: Date.now() - 3600 * 1000 };
  fs.writeFileSync(lock, JSON.stringify(legacy));
  assert.equal(code(() => store.withLock(paths, () => 1, { waitMs: 200 })), 'LOCK_TIMEOUT');
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), legacy);

  fs.writeFileSync(lock, '{"token": "trunc');
  assert.equal(code(() => store.withLock(paths, () => 1, { waitMs: 200 })), 'LOCK_TIMEOUT');
  assert.equal(fs.readFileSync(lock, 'utf8'), '{"token": "trunc');
});

test('wrong-owner release leaves the lock alone; a lost lock is reported, never silently overwritten', () => {
  const { paths, lock } = setup();
  const other = record({ pid: process.pid });
  fs.writeFileSync(lock, JSON.stringify(other));
  assert.equal(store.releaseLock(paths, crypto.randomUUID()), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), other);
  fs.unlinkSync(lock);

  // The lock is replaced underneath a holder (only a manual break can do that).
  const intruder = record({ pid: process.pid });
  const e = (() => {
    try {
      store.withLock(paths, () => {
        fs.writeFileSync(lock, JSON.stringify(intruder));
        assert.equal(code(() => store.assertLockHeld(paths)), 'LOCK_LOST', 'writes are refused once the lock is lost');
        return 1;
      });
    } catch (x) { return x; }
    return null;
  })();
  assert.equal(e && e.code, 'LOCK_LOST');
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), intruder, 'the other owner\'s lock was not removed by the release');
});

test('nested acquisition in one process is refused instead of deadlocking', () => {
  const { paths } = setup();
  store.withLock(paths, () => {
    assert.equal(code(() => store.withLock(paths, () => 1)), 'LOCK_REENTRANT');
  });
});

test('crash: a process that dies holding the lock is recovered by the next command', () => {
  const { paths, lock } = setup();
  const r = child(paths, 'store.acquireLock(paths); process.exit(7);');
  assert.equal(r.status, 7, r.stderr);
  const left = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(left.pid, r.pid);
  assert.equal(store.withLock(paths, () => 'recovered'), 'recovered');
  assert.ok(fs.existsSync(path.join(paths.stateRoot, `.lock.reaped-${left.token}`)));
});

test('interrupted recovery: an abandoned reaper guard is followed, not deleted, and a live reaper is waited for', () => {
  const { paths, lock } = setup();
  const dead = record({ pid: deadPid() });
  fs.writeFileSync(lock, JSON.stringify(dead));
  // A reaper that died after publishing its guard.
  const guardOwner = record({ pid: deadPid(), kind: 'lock-reaper', lock_token: dead.token, predecessor_token: null });
  const guard = path.join(paths.stateRoot, `.lock.reap-${dead.token}`);
  fs.writeFileSync(guard, JSON.stringify(guardOwner));
  assert.equal(store.withLock(paths, () => 'after-chain'), 'after-chain');
  assert.deepEqual(JSON.parse(fs.readFileSync(guard, 'utf8')), guardOwner, 'the abandoned guard stays as a recovery record');
  assert.equal(fs.existsSync(`${guard}-${guardOwner.token}`), false, 'the successor guard was removed by its owner');

  // A reaper that is alive (this process stands in for it): nobody else may reap meanwhile.
  const dead2 = record({ pid: deadPid() });
  fs.writeFileSync(lock, JSON.stringify(dead2));
  const liveGuard = path.join(paths.stateRoot, `.lock.reap-${dead2.token}`);
  fs.writeFileSync(liveGuard, JSON.stringify(record({ kind: 'lock-reaper', lock_token: dead2.token, predecessor_token: null })));
  assert.equal(code(() => store.withLock(paths, () => 1, { waitMs: 200 })), 'LOCK_TIMEOUT');
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), dead2, 'the lock stays while a live reaper owns the guard');

  // A guard that does not belong to this lock generation requires reconciliation.
  fs.writeFileSync(liveGuard, JSON.stringify(record({ pid: deadPid(), kind: 'something-else', lock_token: 'x', predecessor_token: null })));
  assert.equal(code(() => store.withLock(paths, () => 1, { waitMs: 200 })), 'LOCK_RECONCILIATION_REQUIRED');
});

test('long operation: a waiting process does not steal the lock of a slow live holder and gets it after release', async () => {
  const { paths, lock } = setup();
  const holder = child(paths, 'store.withLock(paths, () => { process.stdout.write("held\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); });', { wait: false });
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); });
    holder.on('exit', (c) => reject(new Error(`holder exited early ${c}`)));
  });
  const holderToken = JSON.parse(fs.readFileSync(lock, 'utf8')).token;
  assert.equal(code(() => store.withLock(paths, () => 1, { waitMs: 300 })), 'LOCK_TIMEOUT');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, holderToken);
  const t0 = Date.now();
  assert.equal(store.withLock(paths, () => 'later', { waitMs: 20000 }), 'later');
  assert.ok(Date.now() - t0 > 500, 'it waited for the holder');
  await new Promise((resolve) => (holder.exitCode !== null ? resolve() : holder.on('exit', resolve)));
  assert.equal(holder.exitCode, 0);
});

test('concurrent writers: read-modify-write under the lock loses no update', async () => {
  const { paths, root } = setup();
  const counter = path.join(root, 'counter.json');
  fs.writeFileSync(counter, '{"n":0}');
  const body = `const fs = require('fs'); for (let i = 0; i < 20; i++) store.withLock(paths, () => { const v = JSON.parse(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); v.n += 1; store.atomicWrite(${JSON.stringify(counter)}, JSON.stringify(v)); }, { waitMs: 60000 });`;
  const procs = Array.from({ length: 5 }, () => child(paths, body, { wait: false }));
  const codes = await Promise.all(procs.map((p) => new Promise((resolve) => p.on('exit', resolve))));
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  assert.equal(JSON.parse(fs.readFileSync(counter, 'utf8')).n, 100);
});

test('manage_state lock shows the owner and breaks only a matching, non-live lock after confirmation', () => {
  const { paths, lock, root } = setup();
  const env = Object.assign({}, process.env, { OPUS_ORCH_PROJECT_DIR: root });
  delete env.OPUS_ORCH_STATE_DIR;
  const run = (...args) => spawnSync(process.execPath, [MANAGE, ...args], { encoding: 'utf8', env, windowsHide: true });
  let r = run('lock');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not held/);

  const foreign = record({ host: 'another-host', pid: 4242 });
  fs.writeFileSync(lock, JSON.stringify(foreign));
  r = run('lock');
  assert.match(r.stdout, /process 4242 on host another-host/);
  assert.match(r.stdout, new RegExp(`--break --token ${foreign.token} --confirm-owner-stopped`));
  r = run('lock', '--break', '--token', foreign.token);
  assert.equal(r.status, 2, 'confirmation is required');
  r = run('lock', '--break', '--token', crypto.randomUUID(), '--confirm-owner-stopped');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LOCK_MISMATCH/);
  assert.ok(fs.existsSync(lock));
  r = run('lock', '--break', '--token', foreign.token, '--confirm-owner-stopped');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.readdirSync(paths.stateRoot).filter((n) => n.startsWith(`.lock.broken-${foreign.token}`)).length, 1);

  fs.writeFileSync(lock, JSON.stringify(record({ pid: process.pid })));
  const tok = JSON.parse(fs.readFileSync(lock, 'utf8')).token;
  r = run('lock', '--break', '--token', tok, '--confirm-owner-stopped');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LOCK_OWNER_ALIVE/);
});

test('oo names the live owner instead of taking its lock', () => {
  const p = H.project({ env: { OPUS_ORCH_LOCK_WAIT_MS: '1200' } });
  p.ok(['init', 'lock test']);
  const lock = path.join(p.paths.stateRoot, '.lock');
  const live = record({ pid: process.pid, command: 'verify', acquired_at: new Date(Date.now() - 600000).toISOString() });
  fs.writeFileSync(lock, JSON.stringify(live));
  const out = p.refused(['decision', 'x'], {});
  assert.match(out, new RegExp(`held by process ${process.pid} on host .*owner alive`));
  assert.match(out, /a lock is never taken from a live owner/);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), live);
  fs.unlinkSync(lock);
  p.ok(['decision', 'x']);
});
