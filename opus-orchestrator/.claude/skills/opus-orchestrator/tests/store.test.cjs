'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../scripts/lib/store.cjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oo-store-'));
}
function setup() {
  const root = tmp();
  const paths = store.resolvePaths({ projectDir: root });
  store.ensureState(paths);
  return { root, paths, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function throwsCode(fn, code) {
  assert.throws(fn, (e) => e instanceof store.StoreError && e.code === code);
}

test('resolvePaths: explicit args, env overrides, defaults', () => {
  const a = tmp();
  const b = tmp();
  const saved = { p: process.env.OPUS_ORCH_PROJECT_DIR, s: process.env.OPUS_ORCH_STATE_DIR };
  try {
    delete process.env.OPUS_ORCH_PROJECT_DIR;
    delete process.env.OPUS_ORCH_STATE_DIR;
    let p = store.resolvePaths({ projectDir: a });
    assert.equal(p.projectDir, path.resolve(a));
    assert.equal(p.stateRoot, path.join(path.resolve(a), '.claude', 'opus-orchestrator'));
    assert.equal(p.runsDir, path.join(p.stateRoot, 'runs'));
    assert.equal(p.inboxDir, path.join(path.resolve(a), '.opus-inbox'));
    process.env.OPUS_ORCH_PROJECT_DIR = a;
    p = store.resolvePaths();
    assert.equal(p.projectDir, path.resolve(a));
    process.env.OPUS_ORCH_STATE_DIR = b;
    p = store.resolvePaths();
    assert.equal(p.stateRoot, path.resolve(b));
    p = store.resolvePaths({ projectDir: b, stateDir: a });
    assert.equal(p.projectDir, path.resolve(b));
    assert.equal(p.stateRoot, path.resolve(a));
  } finally {
    if (saved.p === undefined) delete process.env.OPUS_ORCH_PROJECT_DIR; else process.env.OPUS_ORCH_PROJECT_DIR = saved.p;
    if (saved.s === undefined) delete process.env.OPUS_ORCH_STATE_DIR; else process.env.OPUS_ORCH_STATE_DIR = saved.s;
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('ensureState creates directories and .gitignore files', () => {
  const { paths, done } = setup();
  try {
    for (const d of [paths.stateRoot, paths.runsDir, paths.proposalsDir, paths.inboxDir]) {
      assert.ok(fs.statSync(d).isDirectory());
    }
    for (const d of [paths.stateRoot, paths.inboxDir]) {
      assert.match(fs.readFileSync(path.join(d, '.gitignore'), 'utf8'), /^\*$/m);
    }
    store.ensureState(paths);
  } finally { done(); }
});

test('writeJson/readJson round trip, no temp file, backup kept', () => {
  const { root, done } = setup();
  try {
    const f = path.join(root, 'x', 'a.json');
    store.writeJson(f, { v: 1 });
    assert.deepEqual(store.readJson(f), { value: { v: 1 }, recovered: false });
    store.writeJson(f, { v: 2 });
    assert.deepEqual(store.readJson(f).value, { v: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')), { v: 1 });
    assert.ok(fs.readFileSync(f, 'utf8').endsWith('}\n'));
    assert.deepEqual(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-')), []);
  } finally { done(); }
});

test('readJson recovers from backup, CORRUPT and MISSING errors', () => {
  const { root, done } = setup();
  try {
    const f = path.join(root, 'a.json');
    throwsCode(() => store.readJson(f), 'MISSING');
    store.writeJson(f, { v: 1 });
    store.writeJson(f, { v: 2 });
    fs.writeFileSync(f, '{"v": 2, "tr');
    assert.deepEqual(store.readJson(f), { value: { v: 1 }, recovered: true });
    fs.writeFileSync(f + '.bak', 'garbage');
    throwsCode(() => store.readJson(f), 'CORRUPT');
    fs.unlinkSync(f);
    throwsCode(() => store.readJson(f), 'CORRUPT');
    fs.writeFileSync(f + '.bak', '{"v":9}');
    assert.deepEqual(store.readJson(f), { value: { v: 9 }, recovered: true });
  } finally { done(); }
});

test('newRunId format', () => {
  assert.match(store.newRunId(), /^\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.match(store.newRunId(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), /^20260102-030405-[0-9a-f]{4}$/);
});

test('run lifecycle: create, load, save, list, setCurrent, NO_RUN', () => {
  const { paths, done } = setup();
  try {
    throwsCode(() => store.loadRun(paths), 'NO_RUN');
    throwsCode(() => store.loadRun(paths, '20260101-000000-abcd'), 'NO_RUN');
    const run = store.createRun(paths, {
      objective: 'do it', options: { mode: 'auto' }, config: { a: 1 }, workspace: { strategy: 'shared' },
    });
    assert.match(run.run_id, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.equal(run.objective, 'do it');
    assert.equal(fs.readFileSync(paths.currentFile, 'utf8').trim(), run.run_id);
    assert.ok(fs.existsSync(path.join(paths.runsDir, run.run_id, 'request.md')));
    assert.deepEqual(store.loadRun(paths), run);
    const before = run.updated_at;
    run.phase = 'executing';
    store.saveRun(paths, run);
    assert.equal(store.loadRun(paths, run.run_id).phase, 'executing');
    assert.ok(store.loadRun(paths).updated_at >= before);
    const run2 = store.createRun(paths, { objective: 'two' });
    assert.equal(store.loadRun(paths).run_id, run2.run_id);
    store.setCurrent(paths, run.run_id);
    assert.equal(store.loadRun(paths).run_id, run.run_id);
    assert.deepEqual(store.listRuns(paths), [run.run_id, run2.run_id].sort());
  } finally { done(); }
});

test('tasks round-trip sorted, NO_TASK, spec text', () => {
  const { paths, done } = setup();
  try {
    const run = store.createRun(paths, { objective: 'o' });
    const id = run.run_id;
    assert.deepEqual(store.listTasks(paths, id), []);
    store.saveTask(paths, id, { task_id: 'B-2', status: 'queued' });
    store.saveTask(paths, id, { task_id: 'A-1', status: 'queued', extra: [1] });
    assert.deepEqual(store.listTasks(paths, id).map((t) => t.task_id), ['A-1', 'B-2']);
    assert.deepEqual(store.loadTask(paths, id, 'A-1'), { task_id: 'A-1', status: 'queued', extra: [1] });
    throwsCode(() => store.loadTask(paths, id, 'ZZ-9'), 'NO_TASK');
    store.saveSpecText(paths, id, 'A-1', 'task_id: A-1\n');
    assert.equal(fs.readFileSync(path.join(paths.runsDir, id, 'specs', 'A-1.yaml'), 'utf8'), 'task_id: A-1\n');
  } finally { done(); }
});

test('events: append adds ts, read skips bad lines', () => {
  const { paths, done } = setup();
  try {
    const { run_id: id } = store.createRun(paths, { objective: 'o' });
    assert.deepEqual(store.readEvents(paths, id), []);
    store.appendEvent(paths, id, { type: 'a', task_id: 'T' });
    const file = path.join(paths.runsDir, id, 'events.jsonl');
    fs.appendFileSync(file, 'not json {\n');
    store.appendEvent(paths, id, { type: 'b' });
    const ev = store.readEvents(paths, id);
    assert.equal(ev.length, 2);
    assert.equal(ev[0].type, 'a');
    assert.equal(ev[0].task_id, 'T');
    assert.ok(!Number.isNaN(Date.parse(ev[0].ts)));
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3);
  } finally { done(); }
});

test('writeEvidence returns relative forward-slash path', () => {
  const { root, paths, done } = setup();
  try {
    const { run_id: id } = store.createRun(paths, { objective: 'o' });
    const rel = store.writeEvidence(paths, id, 'T-1.txt', 'hello');
    assert.ok(!rel.includes('\\'));
    assert.ok(rel.endsWith(`runs/${id}/evidence/T-1.txt`));
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), 'hello');
    assert.throws(() => store.writeEvidence(paths, id, '../evil', 'x'), (e) => e instanceof store.StoreError);
  } finally { done(); }
});

test('withLock: exclusive, returns value, releases on throw', () => {
  const { paths, done } = setup();
  try {
    const lock = path.join(paths.stateRoot, '.lock');
    assert.equal(store.withLock(paths, () => {
      assert.ok(fs.existsSync(lock));
      const info = JSON.parse(fs.readFileSync(lock, 'utf8'));
      assert.equal(info.pid, process.pid);
      return 42;
    }), 42);
    assert.ok(!fs.existsSync(lock));
    assert.throws(() => store.withLock(paths, () => { throw new Error('boom'); }), /boom/);
    assert.ok(!fs.existsSync(lock));
    // nested attempt from same process cannot enter while held (times out)
  } finally { done(); }
});

test('withLock keeps an old lock of a live owner and takes over the lock of a dead owner', () => {
  const { paths, done } = setup();
  try {
    const lock = path.join(paths.stateRoot, '.lock');
    const live = { token: '00000000-0000-4000-8000-000000000001', pid: process.pid, host: os.hostname(), acquired_at: new Date(Date.now() - 31000).toISOString() };
    fs.writeFileSync(lock, JSON.stringify(live));
    throwsCode(() => store.withLock(paths, () => 'old', { waitMs: 200 }), 'LOCK_TIMEOUT');
    assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), live, 'age alone never frees a lock');
    // a process id above every platform's pid range (a just-exited child's id may be reused under load)
    let gone = 2147470000;
    for (;; gone++) { try { process.kill(gone, 0); } catch (e) { if (e.code === 'ESRCH') break; } }
    fs.writeFileSync(lock, JSON.stringify(Object.assign({}, live, { token: '00000000-0000-4000-8000-000000000002', pid: gone })));
    assert.equal(store.withLock(paths, () => 'dead'), 'dead');
    assert.ok(!fs.existsSync(lock));
  } finally { done(); }
});

test('withLock waits for a live lock then fails with LOCK_TIMEOUT', { timeout: 20000 }, () => {
  const { paths, done } = setup();
  try {
    const lock = path.join(paths.stateRoot, '.lock');
    fs.writeFileSync(lock, JSON.stringify({ token: '00000000-0000-4000-8000-000000000003', pid: process.pid, host: os.hostname(), acquired_at: new Date().toISOString() }));
    const t0 = Date.now();
    throwsCode(() => store.withLock(paths, () => 1, { waitMs: 1500 }), 'LOCK_TIMEOUT');
    assert.ok(Date.now() - t0 >= 1400);
    assert.ok(fs.existsSync(lock), 'live lock must not be removed');
  } finally { done(); }
});

test('checkIntegrity: healthy, recovered, unrecoverable', () => {
  const { paths, done } = setup();
  try {
    const { run_id: id } = store.createRun(paths, { objective: 'o' });
    store.saveTask(paths, id, { task_id: 'A-1', status: 'queued' });
    store.saveTask(paths, id, { task_id: 'B-1', status: 'queued' });
    assert.deepEqual(store.checkIntegrity(paths, id), { ok: true, problems: [], recovered: [] });

    store.saveTask(paths, id, { task_id: 'A-1', status: 'running' }); // creates .bak
    const fa = path.join(paths.runsDir, id, 'tasks', 'A-1.json');
    fs.writeFileSync(fa, '{"task_id": "A-1", "sta');
    const r = store.checkIntegrity(paths, id);
    assert.equal(r.ok, true);
    assert.deepEqual(r.recovered, ['tasks/A-1.json']);
    assert.equal(JSON.parse(fs.readFileSync(fa, 'utf8')).task_id, 'A-1');
    assert.deepEqual(store.checkIntegrity(paths, id).recovered, []);

    const fb = path.join(paths.runsDir, id, 'tasks', 'B-1.json');
    fs.writeFileSync(fb, 'garbage');
    const r2 = store.checkIntegrity(paths, id);
    assert.equal(r2.ok, false);
    assert.equal(r2.problems.length, 1);
    assert.match(r2.problems[0], /B-1\.json/);

    fs.writeFileSync(fb, JSON.stringify({ task_id: 'B-1' }));
    fs.rmSync(fb + '.bak', { force: true });
    assert.equal(store.checkIntegrity(paths, id).ok, false);
  } finally { done(); }
});
