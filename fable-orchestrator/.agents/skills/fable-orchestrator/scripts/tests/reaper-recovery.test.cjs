'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Store } = require('../state_manager.cjs');

const modulePath = require.resolve('../state_manager.cjs');
const prelude = `
  const fs = require('fs');
  const sm = require(process.argv[1]);
  const store = new sm.Store(process.argv[2]);
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-reaper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.create({ schema: 1, run_id: 'reaper-test', tasks: {}, order: [], phase: 'PLANNED', decisions: [], seq: 0, counter: 0 });
  return store;
}

function runChild(store, script, exitCode = 0) {
  const result = spawnSync(process.execPath, ['-e', prelude + script, modulePath, store.runDir], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, exitCode, result.stderr);
}

function abandonLock(store) {
  runChild(store, 'store.lock(); process.exit(23);', 23);
  return JSON.parse(fs.readFileSync(store.lockPath, 'utf8'));
}

// Interrupt the real operation immediately after its guard is published. The
// mkdir interception also reproduces the pre-fix empty-directory failure.
function abandonReaper(store) {
  runChild(store, `
    const mkdir = fs.mkdirSync;
    const link = fs.linkSync;
    const stopAfterGuard = (target) => {
      if (String(target).startsWith(store.lockPath + '.reap-')) process.exit(24);
    };
    fs.mkdirSync = (...args) => { const result = mkdir(...args); stopAfterGuard(args[0]); return result; };
    fs.linkSync = (...args) => { const result = link(...args); stopAfterGuard(args[1]); return result; };
    store.lock(500);
    throw new Error('the reaper crash hook was not reached');
  `, 24);
}

function startChild(t, store, script) {
  const child = spawn(process.execPath, ['-e', prelude + script, modulePath, store.runDir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  const messages = [];
  const waiters = [];
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stderr.on('data', (data) => { stderr += data; });
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code ?? signal}: ${stderr}`));
    });
  });
  done.catch(() => {});
  child.on('message', (message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await done.catch(() => {});
  });
  return {
    child, done,
    message() { return Promise.race([messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve)), done.then(() => { throw new Error('child exited before readiness'); })]); },
  };
}

test('a second reaper recovers a crash immediately after guard creation', (t) => {
  const store = fixture(t);
  const before = fs.readFileSync(store.statePath, 'utf8');
  const oldOwner = abandonLock(store);
  abandonReaper(store);
  store.lock(200);
  try {
    const owner = JSON.parse(fs.readFileSync(store.lockPath, 'utf8'));
    assert.notEqual(owner.token, oldOwner.token);
    assert.equal(owner.pid, process.pid);
    assert.equal(fs.readFileSync(store.statePath, 'utf8'), before);
  } finally {
    assert.equal(store.unlock(), true);
  }
});

test('a crash after deleting the stale lock does not prevent the next owner', (t) => {
  const store = fixture(t);
  abandonLock(store);
  runChild(store, `
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (file) => {
      const result = unlink(file);
      if (file === store.lockPath) process.exit(25);
      return result;
    };
    store.lock();
  `, 25);
  store.lock(200);
  assert.equal(store.unlock(), true);
  assert.equal(store.read().counter, 0);
});

test('a live reaper guard cannot be stolen even when its modification time is old', { timeout: 10000 }, async (t) => {
  const store = fixture(t);
  const oldOwner = abandonLock(store);
  const guard = `${store.lockPath}.reap-${oldOwner.token}`;
  const release = path.join(store.runDir, 'release-reaper');
  const reaper = startChild(t, store, `
    const unlink = fs.unlinkSync;
    fs.unlinkSync = (file) => {
      if (file === store.lockPath) {
        process.send('guarded');
        const until = Date.now() + 5000;
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() > until) throw new Error('release was not signalled');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return unlink(file);
    };
    store.lock();
    store.unlock();
  `);
  assert.equal(await reaper.message(), 'guarded');
  const record = fs.readFileSync(guard, 'utf8');
  const old = new Date(0);
  fs.utimesSync(guard, old, old);
  assert.throws(() => store.lock(100), (e) => e.code === 'LOCK_TIMEOUT');
  assert.equal(fs.readFileSync(guard, 'utf8'), record);
  assert.equal(JSON.parse(fs.readFileSync(store.lockPath, 'utf8')).token, oldOwner.token);
  fs.writeFileSync(release, 'released');
  await reaper.done;
  assert.equal(fs.existsSync(store.lockPath), false);
  assert.equal(fs.existsSync(guard), false);
});

test('concurrent reapers survive repeated interrupted recovery and serialize state writes', { timeout: 20000 }, async (t) => {
  const store = fixture(t);
  const oldOwner = abandonLock(store);
  for (let i = 0; i < 3; i++) abandonReaper(store);
  const guards = fs.readdirSync(store.runDir).filter((name) => name.startsWith(`state.lock.reap-${oldOwner.token}`));
  assert.equal(guards.length, 3);
  for (const name of guards) {
    const record = JSON.parse(fs.readFileSync(path.join(store.runDir, name), 'utf8'));
    assert.equal(record.lock_token, oldOwner.token);
    assert.ok(Number.isInteger(record.pid));
    assert.equal(record.host, os.hostname());
  }
  const start = path.join(store.runDir, 'start-writers');
  const writers = Array.from({ length: 3 }, () => startChild(t, store, `
    process.send('ready');
    const until = Date.now() + 5000;
    while (!fs.existsSync(${JSON.stringify(start)})) {
      if (Date.now() > until) throw new Error('start was not signalled');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    for (let i = 0; i < 6; i++) store.transact((state) => {
      state.counter++;
      sm.emit(state, { type: 'increment', counter: state.counter });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    });
  `));
  assert.deepEqual(await Promise.all(writers.map((worker) => worker.message())), ['ready', 'ready', 'ready']);
  fs.writeFileSync(start, 'start');
  await Promise.all(writers.map((worker) => worker.done));
  assert.equal(store.read().counter, 18);
  const events = fs.readFileSync(store.eventsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter((event) => event.type === 'increment').map((event) => event.counter), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
  assert.equal(fs.existsSync(store.lockPath), false);
});

test('legacy, malformed, or mismatched guards require reconciliation without deletion', (t) => {
  for (const mismatch of ['directory', 'malformed', 'lock_token', 'predecessor_token']) {
    const store = fixture(t);
    const owner = abandonLock(store);
    const guard = `${store.lockPath}.reap-${owner.token}`;
    if (mismatch === 'directory') fs.mkdirSync(guard);
    else if (mismatch === 'malformed') fs.writeFileSync(guard, '{incomplete');
    else {
      abandonReaper(store);
      const record = JSON.parse(fs.readFileSync(guard, 'utf8'));
      record[mismatch] = randomUUID();
      fs.writeFileSync(guard, JSON.stringify(record));
    }
    assert.throws(() => store.lock(0), (e) => e.code === 'LOCK_REAPER_RECONCILIATION_REQUIRED' && /stop all processes/i.test(e.message));
    assert.ok(fs.existsSync(guard));
    assert.equal(JSON.parse(fs.readFileSync(store.lockPath, 'utf8')).token, owner.token);
  }
});

test('a foreign-host guard is not assumed dead', (t) => {
  const store = fixture(t);
  const owner = abandonLock(store);
  abandonReaper(store);
  const guard = `${store.lockPath}.reap-${owner.token}`;
  const record = JSON.parse(fs.readFileSync(guard, 'utf8'));
  record.host = `${os.hostname()}-different`;
  fs.writeFileSync(guard, JSON.stringify(record));
  assert.throws(() => store.lock(0), (e) => e.code === 'LOCK_TIMEOUT');
  assert.deepEqual(JSON.parse(fs.readFileSync(guard, 'utf8')), record);
  assert.equal(JSON.parse(fs.readFileSync(store.lockPath, 'utf8')).token, owner.token);
});

test('guard release preserves a replacement owner record', (t) => {
  const store = fixture(t);
  const owner = abandonLock(store);
  const guard = `${store.lockPath}.reap-${owner.token}`;
  const unlink = fs.unlinkSync;
  let replacement;
  fs.unlinkSync = (file) => {
    if (file === store.lockPath) {
      replacement = { ...JSON.parse(fs.readFileSync(guard, 'utf8')), token: randomUUID() };
      fs.writeFileSync(guard, JSON.stringify(replacement));
    }
    return unlink(file);
  };
  try { assert.equal(store.reap(owner), true); } finally { fs.unlinkSync = unlink; }
  assert.deepEqual(JSON.parse(fs.readFileSync(guard, 'utf8')), replacement);
});

test('reaping checks the original lock identity again after acquiring its guard', (t) => {
  const store = fixture(t);
  const owner = abandonLock(store);
  const replacement = { token: randomUUID(), pid: process.pid, host: os.hostname() };
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    const result = link(from, to);
    if (to.startsWith(store.lockPath + '.reap-')) fs.writeFileSync(store.lockPath, JSON.stringify(replacement));
    return result;
  };
  try { assert.equal(store.reap(owner), false); } finally { fs.linkSync = link; }
  assert.deepEqual(JSON.parse(fs.readFileSync(store.lockPath, 'utf8')), replacement);
});
