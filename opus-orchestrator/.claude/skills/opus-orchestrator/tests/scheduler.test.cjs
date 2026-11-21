'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('../scripts/lib/scheduler.cjs');

const CLI = path.join(__dirname, '..', 'scripts', 'schedule_tasks.cjs');

function T(id, o = {}) {
  return {
    task_id: id, status: 'READY', dependencies: [], authorized_files: [`src/${id}/`],
    priority: 'medium', exclusive: false, ...o,
  };
}

test('findCycles, missingDependencies, topoOrder', () => {
  const tasks = [T('A-001', { dependencies: ['A-002'] }), T('A-002', { dependencies: ['A-001'] }),
    T('B-001', { dependencies: ['Z-009'] }), T('C-001')];
  const cycles = S.findCycles(tasks);
  assert.deepEqual(cycles, [['A-001', 'A-002']]);
  assert.deepEqual(S.missingDependencies(tasks), [{ task_id: 'B-001', missing: ['Z-009'] }]);
  assert.throws(() => S.topoOrder(tasks), (e) => e instanceof S.SchedulerError && e.code === 'CYCLE');
  assert.deepEqual(S.findCycles([T('S-001', { dependencies: ['S-001'] })]), [['S-001']]);
  assert.deepEqual(S.topoOrder([T('B-001', { dependencies: ['A-001'] }), T('A-001')]), ['A-001', 'B-001']);
});

test('dependents and criticalPath ignore terminal tasks', () => {
  const tasks = [T('A-001'), T('B-001', { dependencies: ['A-001'] }),
    T('C-001', { dependencies: ['B-001'] }), T('D-001', { dependencies: ['A-001'], status: 'COMPLETED' })];
  assert.deepEqual(S.dependents(tasks)['A-001'], ['B-001', 'D-001']);
  const cp = S.criticalPath(tasks);
  assert.deepEqual(cp['A-001'], { downstream: 2, chain: 2 });
  assert.deepEqual(cp['C-001'], { downstream: 0, chain: 0 });
});

test('promotable needs PENDING with all deps COMPLETED', () => {
  const tasks = [
    T('A-001', { status: 'COMPLETED' }), T('F-001', { status: 'FAILED' }), T('K-001', { status: 'BLOCKED' }),
    T('R-001', { status: 'RUNNING' }),
    T('P-001', { status: 'PENDING', dependencies: ['A-001'] }),
    T('P-002', { status: 'PENDING', dependencies: ['F-001'] }),
    T('P-003', { status: 'PENDING', dependencies: ['K-001'] }),
    T('P-004', { status: 'PENDING', dependencies: ['R-001'] }),
    T('P-005', { status: 'PENDING', dependencies: ['A-001', 'R-001'] }),
    T('P-006', { status: 'PENDING', dependencies: ['NOPE-001'] }),
    T('P-007', { status: 'PENDING' }),
    T('X-001', { status: 'READY' }),
  ];
  assert.deepEqual(S.promotable(tasks), ['P-001', 'P-007']);
});

function indep(n, o = {}) {
  return Array.from({ length: n }, (_, i) => T(`W-${String(i + 1).padStart(3, '0')}`, o));
}

test('selectBatch sizes the batch', () => {
  assert.equal(S.selectBatch(indep(1), { max_workers: 5 }).dispatch.length, 1);
  assert.equal(S.selectBatch(indep(3), { max_workers: 5 }).dispatch.length, 3);
  const r = S.selectBatch(indep(10), { max_workers: 5 });
  assert.equal(r.dispatch.length, 5);
  assert.equal(r.deferred.length, 5);
  assert.ok(r.deferred.every((d) => d.reason === 'no_slot'));
});

test('selectBatch subtracts in-flight tasks and honours call_budget and parallel', () => {
  const tasks = [...indep(6), T('R-001', { status: 'RUNNING', authorized_files: ['other/'] }),
    T('R-002', { status: 'DISPATCHED', authorized_files: ['other2/'] })];
  const r = S.selectBatch(tasks, { max_workers: 4 });
  assert.equal(r.slots_free, 2);
  assert.equal(r.dispatch.length, 2);
  const b = S.selectBatch(indep(6), { max_workers: 5, call_budget: 2 });
  assert.equal(b.dispatch.length, 2);
  assert.ok(b.deferred.every((d) => d.reason === 'budget'));
  assert.equal(S.selectBatch(indep(4), { max_workers: 5, call_budget: 0 }).dispatch.length, 0);
  assert.equal(S.selectBatch(indep(4), { max_workers: 5, parallel: false }).dispatch.length, 1);
});

test('selectBatch skips READY tasks whose dependencies are not completed', () => {
  const tasks = [T('A-001', { status: 'RUNNING' }), T('B-001', { dependencies: ['A-001'], authorized_files: ['x/'] })];
  assert.deepEqual(S.selectBatch(tasks, { max_workers: 5 }).dispatch, []);
});

test('selectBatch defers scope conflicts with owners and chosen tasks', () => {
  const tasks = [
    T('O-001', { status: 'REVIEWING', authorized_files: ['src/auth/'] }),
    T('A-001', { authorized_files: ['src/auth/token.js'] }),
    T('B-001', { authorized_files: ['src/db/'] }),
    T('C-001', { authorized_files: ['src/db/models.js'] }),
  ];
  const r = S.selectBatch(tasks, { max_workers: 5 });
  assert.deepEqual(r.dispatch, ['B-001']);
  assert.deepEqual(r.deferred, [{ task_id: 'A-001', reason: 'scope_conflict' }, { task_id: 'C-001', reason: 'scope_conflict' }]);
});

test('read-only (empty scope) tasks are never deferred for scope', () => {
  const tasks = [T('O-001', { status: 'RUNNING', authorized_files: ['src/'] }),
    T('R-001', { authorized_files: [] }), T('R-002', { authorized_files: [] })];
  const r = S.selectBatch(tasks, { max_workers: 5 });
  assert.deepEqual(r.dispatch, ['R-001', 'R-002']);
});

test('exclusive task runs alone and blocks others', () => {
  const tasks = [T('E-001', { exclusive: true, priority: 'critical' }), T('A-001'), T('B-001')];
  const r = S.selectBatch(tasks, { max_workers: 5 });
  assert.deepEqual(r.dispatch, ['E-001']);
  assert.ok(r.deferred.every((d) => d.reason === 'exclusive'));

  // exclusive ranks below a normal task: it waits
  const t2 = [T('E-001', { exclusive: true, priority: 'low' }), T('A-001', { priority: 'high' })];
  const r2 = S.selectBatch(t2, { max_workers: 5 });
  assert.deepEqual(r2.dispatch, ['A-001']);
  assert.deepEqual(r2.deferred, [{ task_id: 'E-001', reason: 'exclusive' }]);

  // exclusive waits while something is in flight
  const t3 = [T('R-001', { status: 'RUNNING' }), T('E-001', { exclusive: true })];
  assert.deepEqual(S.selectBatch(t3, { max_workers: 5 }).dispatch, []);

  // nothing dispatched while an exclusive task is in flight
  const t4 = [T('E-001', { status: 'RUNNING', exclusive: true }), T('A-001')];
  const r4 = S.selectBatch(t4, { max_workers: 5 });
  assert.deepEqual(r4.dispatch, []);
  assert.deepEqual(r4.deferred, [{ task_id: 'A-001', reason: 'exclusive' }]);
});

test('ordering: priority, then downstream, then chain, then id', () => {
  const tasks = [
    T('LEAF-001'), T('BLK-001'),
    T('D-001', { status: 'PENDING', dependencies: ['BLK-001'] }),
    T('D-002', { status: 'PENDING', dependencies: ['BLK-001'] }),
    T('D-003', { status: 'PENDING', dependencies: ['BLK-001'] }),
  ];
  assert.deepEqual(S.selectBatch(tasks, { max_workers: 1 }).dispatch, ['BLK-001']);

  const pri = [T('A-001', { priority: 'low' }), T('B-001', { priority: 'critical' }), T('C-001', { priority: 'high' })];
  assert.deepEqual(S.selectBatch(pri, { max_workers: 3 }).dispatch, ['B-001', 'C-001', 'A-001']);

  // equal downstream: longer chain first
  const chain = [T('X-001'), T('Y-001'),
    T('X-002', { status: 'PENDING', dependencies: ['X-001'] }),
    T('Y-002', { status: 'PENDING', dependencies: ['Y-001'] }),
    T('Y-003', { status: 'PENDING', dependencies: ['Y-002'] })];
  assert.deepEqual(S.selectBatch(chain, { max_workers: 1 }).dispatch, ['Y-001']);

  // all equal: id ascending
  assert.deepEqual(S.selectBatch([T('B-001'), T('A-001')], { max_workers: 1 }).dispatch, ['A-001']);
});

test('planWaves respects dependencies, scope and max_workers', () => {
  const tasks = [
    T('A-001', { status: 'PENDING' }),
    T('B-001', { status: 'PENDING', dependencies: ['A-001'], authorized_files: ['s/'] }),
    T('C-001', { status: 'PENDING', dependencies: ['A-001'], authorized_files: ['s/f.js'] }),
    T('D-001', { status: 'PENDING', dependencies: ['A-001'], authorized_files: ['d/'] }),
    T('E-001', { status: 'PENDING', dependencies: ['A-001'], authorized_files: ['e/'] }),
  ];
  assert.deepEqual(S.planWaves(tasks, 5), [['A-001'], ['B-001', 'D-001', 'E-001'], ['C-001']]);
  assert.deepEqual(S.planWaves(tasks, 2), [['A-001'], ['B-001', 'D-001'], ['C-001', 'E-001']]);
  assert.deepEqual(S.planWaves(indep(3, { status: 'PENDING', exclusive: false }), 1).length, 3);
  const ex = [T('E-001', { exclusive: true, status: 'PENDING' }), T('A-001', { status: 'PENDING' })];
  assert.deepEqual(S.planWaves(ex, 5), [['A-001'], ['E-001']]);
  assert.throws(() => S.planWaves([T('A-001', { dependencies: ['B-001'] }), T('B-001', { dependencies: ['A-001'] })], 3),
    (e) => e.code === 'CYCLE');
  assert.throws(() => S.planWaves([T('A-001', { dependencies: ['Q-001'] })], 3), (e) => e.code === 'MISSING_DEPENDENCY');
});

test('explainIdle', () => {
  assert.equal(S.explainIdle([T('A-001', { status: 'COMPLETED' }), T('B-001', { status: 'CANCELLED' })]), 'all_done');
  assert.equal(S.explainIdle([T('A-001', { status: 'REVIEWING' }), T('B-001', { status: 'PENDING', dependencies: ['A-001'] })]),
    'waiting_on_running');
  assert.equal(S.explainIdle([T('A-001', { status: 'BLOCKED' }), T('B-001', { status: 'FAILED' }),
    T('C-001', { status: 'PENDING', dependencies: ['A-001'] })]), 'blocked: A-001, B-001');
  assert.equal(S.explainIdle([T('A-001', { status: 'PENDING', dependencies: ['B-001'] }),
    T('B-001', { status: 'PENDING', dependencies: ['A-001'] })]), 'deadlock: A-001, B-001');
});

test('scheduler is pure: no input mutation and no I/O modules', () => {
  const tasks = [T('A-001'), T('B-001', { status: 'PENDING', dependencies: ['A-001'] })];
  const copy = JSON.parse(JSON.stringify(tasks));
  S.selectBatch(tasks, { max_workers: 2 }); S.planWaves(tasks, 2); S.criticalPath(tasks); S.explainIdle(tasks);
  assert.deepEqual(tasks, copy);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'scheduler.cjs'), 'utf8');
  assert.doesNotMatch(src, /require\(['"](node:)?(fs|child_process|os|path|net|http)['"]\)|Date\.now|new Date|process\./);
});

function spec(id, extra = '') {
  return `task_id: ${id}\ntitle: T ${id}\nobjective: Do ${id}\ncomplexity: 3\nauthorized_files: [src/${id}/]\n` +
    `acceptance_criteria:\n  - works\n${extra}`;
}

function runCli(text, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  try {
    const f = path.join(dir, 'specs.yaml');
    fs.writeFileSync(f, text);
    return spawnSync(process.execPath, [CLI, f, ...args], { encoding: 'utf8' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('CLI prints waves for a valid file', () => {
  const r = runCli([spec('AAA-001'), spec('AAA-002', 'dependencies: [AAA-001]\n'), spec('BBB-001')].join('---\n'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\. AAA-001, BBB-001/);
  assert.match(r.stdout, /2\. AAA-002/);
});

test('CLI exits 1 naming the cycle', () => {
  const r = runCli([spec('AAA-001', 'dependencies: [AAA-002]\n'), spec('AAA-002', 'dependencies: [AAA-001]\n')].join('---\n'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cycle: AAA-001 -> AAA-002 -> AAA-001/);
});

test('CLI exits 1 naming the missing dependency', () => {
  const r = runCli(spec('AAA-001', 'dependencies: [ZZZ-999]\n'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ZZZ-999/);
});
