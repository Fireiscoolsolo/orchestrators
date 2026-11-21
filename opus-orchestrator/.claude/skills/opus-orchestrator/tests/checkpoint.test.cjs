'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../scripts/lib/store.cjs');
const cp = require('../scripts/lib/checkpoint.cjs');

const NOW = '2026-11-15T10:00:00.000Z';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oo-ckpt-'));
  const paths = store.resolvePaths({ projectDir: root });
  store.ensureState(paths);
  return { root, paths, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function task(id, status, extra) {
  return Object.assign({
    task_id: id,
    title: `Task ${id}`,
    status,
    dependencies: [],
    spec_revision: 1,
    review_round: 0,
    attempts: 0,
    retries: 0,
    routing: { role: 'implementation-worker', agent: 'opus-implementer', model: 'haiku', independent_review: false },
    history: [],
    evidence: { self_check: null, verification: null, reviews: [], integration: null },
    result: null,
    correction: null,
    corrections: [],
    failure: null,
    block: null,
  }, extra || {});
}

function sampleRun() {
  return {
    run_id: '20261115-100000-abcd',
    objective: 'Add a greeting function\nwith tests',
    options: { mode: 'balanced', max_workers: 5, max_review_rounds: 3, max_retries: 2, plan_only: false },
    phase: 'executing',
    decisions: [{ ts: NOW, text: 'Use shared workspace' }, { ts: NOW, text: 'Prefer haiku' }],
    usage: { agent_calls: 4, tokens: { total: 1200 }, tokens_measured: true },
  };
}

function sampleTasks() {
  return [
    task('DEMO-001', 'COMPLETED', { result: { files_changed: ['src/b.js', 'src/a.js'] } }),
    task('DEMO-002', 'RUNNING', {
      dependencies: ['DEMO-001'],
      spec_revision: 2,
      history: [{ ts: '2026-11-15T09:00:00.000Z', from: 'READY', to: 'DISPATCHED' }],
    }),
    task('DEMO-003', 'CORRECTION_REQUIRED', {
      review_round: 1,
      correction: { failure: 'test fails', required_change: 'handle empty name' },
      evidence: { verification: { passed: false, commands: [{ command: 'npm test', exit_code: 1 }] }, reviews: [] },
    }),
    task('DEMO-004', 'FAILED', { failure: { kind: 'timeout', reason: 'worker exceeded the timeout', ts: NOW } }),
    task('DEMO-005', 'PENDING', { dependencies: ['DEMO-002'] }),
  ];
}

const KEYS = ['run_id', 'written_at', 'objective', 'options', 'phase', 'spec_revisions', 'task_graph', 'task_statuses',
  'active_agents', 'decisions', 'modified_files', 'verification_evidence', 'known_failures', 'pending_corrections',
  'next_actions', 'usage'];

test('buildCheckpoint returns every documented key with the right content', () => {
  const c = cp.buildCheckpoint(sampleRun(), sampleTasks(), NOW);
  for (const k of KEYS) assert.ok(k in c, `missing key ${k}`);
  assert.deepEqual(Object.keys(c).sort(), KEYS.slice().sort());
  assert.equal(c.run_id, '20261115-100000-abcd');
  assert.equal(c.written_at, NOW);
  assert.equal(c.phase, 'executing');
  assert.deepEqual(c.decisions, ['Use shared workspace', 'Prefer haiku']);
  assert.equal(c.spec_revisions['DEMO-002'], 2);
  assert.deepEqual(c.task_graph['DEMO-002'], ['DEMO-001']);
  assert.equal(c.task_statuses['DEMO-004'], 'FAILED');
  assert.deepEqual(c.modified_files, ['src/a.js', 'src/b.js']);
  assert.deepEqual(c.active_agents, [{
    task_id: 'DEMO-002', role: 'implementation-worker', agent: 'opus-implementer', model: 'haiku',
    since: '2026-11-15T09:00:00.000Z',
  }]);
  assert.deepEqual(c.verification_evidence['DEMO-003'], { passed: false, commands: 1 });
  assert.deepEqual(c.known_failures, [{ task_id: 'DEMO-004', kind: 'timeout', reason: 'worker exceeded the timeout' }]);
  assert.deepEqual(c.pending_corrections, [{
    task_id: 'DEMO-003', round: 2, failure: 'test fails', required_change: 'handle empty name',
  }]);
  assert.deepEqual(c.usage, { agent_calls: 4, tokens_total: 1200, tokens_measured: true });
  assert.ok(c.next_actions.length >= 2);
});

test('buildCheckpoint tolerates a bare run and no tasks', () => {
  const c = cp.buildCheckpoint({ run_id: '20261115-100000-abcd', objective: 'x' }, [], NOW);
  assert.deepEqual(c.usage, { agent_calls: 0, tokens_total: 0, tokens_measured: false });
  assert.deepEqual(c.task_statuses, {});
  assert.deepEqual(c.next_actions, []);
});

test('writeCheckpoint then readCheckpoint returns an equal object', () => {
  const s = setup();
  try {
    const c = cp.buildCheckpoint(sampleRun(), sampleTasks(), NOW);
    const file = cp.writeCheckpoint(s.paths, c.run_id, c);
    assert.ok(fs.existsSync(file));
    assert.equal(path.basename(file), 'checkpoint.yaml');
    assert.deepEqual(cp.readCheckpoint(s.paths, c.run_id), c);
    // overwriting keeps a readable result
    const c2 = Object.assign({}, c, { phase: 'verifying' });
    cp.writeCheckpoint(s.paths, c.run_id, c2);
    assert.deepEqual(cp.readCheckpoint(s.paths, c.run_id), c2);
  } finally {
    s.done();
  }
});

test('readCheckpoint reports MISSING and recovers from the backup', () => {
  const s = setup();
  try {
    assert.throws(() => cp.readCheckpoint(s.paths, '20261115-100000-abcd'), (e) => e.code === 'MISSING');
    assert.throws(() => cp.readCheckpoint(s.paths, '../evil'), (e) => e.code === 'NO_RUN');
    const c = cp.buildCheckpoint(sampleRun(), sampleTasks(), NOW);
    const c2 = Object.assign({}, c, { phase: 'verifying' });
    const file = cp.writeCheckpoint(s.paths, c.run_id, c);
    cp.writeCheckpoint(s.paths, c.run_id, c2);
    fs.writeFileSync(file, 'a: [unterminated\n  - : :');
    assert.deepEqual(cp.readCheckpoint(s.paths, c.run_id), c);
    fs.writeFileSync(`${file}.bak`, '{{{');
    assert.throws(() => cp.readCheckpoint(s.paths, c.run_id), (e) => e.code === 'CORRUPT');
  } finally {
    s.done();
  }
});

test('nextActions: one imperative line per task awaiting the orchestrator', () => {
  const t = [
    task('A-001', 'RUNNING'),
    task('A-002', 'IMPLEMENTED'),
    task('A-003', 'REVIEWING'),
    task('A-004', 'REVIEWING', { routing: { independent_review: true } }),
    task('A-005', 'CORRECTION_REQUIRED', { review_round: 1 }),
    task('A-006', 'APPROVED'),
    task('A-007', 'BLOCKED', { block: { kind: 'merge_conflict', reason: 'conflict in x', ts: NOW } }),
    task('A-008', 'READY'),
    task('A-009', 'PENDING', { dependencies: ['A-010'] }),
    task('A-010', 'COMPLETED'),
    task('A-011', 'PENDING', { dependencies: ['A-012'] }),
    task('A-012', 'FAILED', { failure: { kind: 'crash', reason: 'x', ts: NOW } }),
  ];
  const a = cp.nextActions({}, t);
  const has = (re) => a.some((l) => re.test(l));
  assert.ok(has(/^oo result A-001 --stdin/));
  assert.ok(has(/^oo verify A-002/));
  assert.ok(has(/^oo review A-003 --stdin \(awaiting Opus quality gate\)/));
  assert.ok(has(/^oo review-package A-004/));
  assert.ok(has(/^oo correct A-005 --stdin.*round 2/));
  assert.ok(has(/^oo integrate A-006/));
  assert.ok(has(/A-007.*merge_conflict/));
  const dispatch = a.find((l) => l.startsWith('oo next'));
  assert.ok(dispatch);
  assert.match(dispatch, /A-008/);
  assert.match(dispatch, /A-009/); // its dependency is completed
  assert.doesNotMatch(dispatch, /A-011/);
  assert.ok(has(/Resolve A-011.*A-012/));
  for (const l of a) assert.equal(l.includes('\n'), false);
});

test('nextActions: independent review already approved goes to the Opus gate', () => {
  const t = [task('A-001', 'REVIEWING', {
    routing: { independent_review: true },
    evidence: { reviews: [{ reviewer: 'opus-reviewer', independent: true, verdict: 'approve' }] },
  })];
  assert.match(cp.nextActions({}, t)[0], /^oo review A-001 --stdin/);
});

test('nextActions is empty when every task is terminal', () => {
  const t = [task('A-001', 'COMPLETED'), task('A-002', 'FAILED'), task('A-003', 'CANCELLED')];
  assert.deepEqual(cp.nextActions({}, t), []);
});

test('renderResume includes every required section and collapses completed tasks', () => {
  const c = cp.buildCheckpoint(sampleRun(), sampleTasks(), NOW);
  const text = cp.renderResume(c, { maxLines: 120 });
  assert.match(text, /20261115-100000-abcd/);
  assert.match(text, /Add a greeting function with tests/); // objective on one line
  assert.match(text, /mode=balanced/);
  assert.match(text, /Use shared workspace/);
  assert.match(text, /Prefer haiku/);
  for (const id of ['DEMO-002', 'DEMO-003', 'DEMO-004', 'DEMO-005']) assert.match(text, new RegExp(`- ${id} `));
  assert.match(text, /Completed tasks \(1\): DEMO-001/);
  assert.doesNotMatch(text, /- DEMO-001 /);
  assert.match(text, /worker exceeded the timeout/);
  assert.match(text, /handle empty name/);
  assert.match(text, /oo result DEMO-002 --stdin/);
  assert.match(text, /authoritative/);
});

test('renderResume never exceeds maxLines, even with 200 tasks', () => {
  const tasks = [];
  for (let i = 1; i <= 200; i++) {
    const id = `BIG-${String(i).padStart(3, '0')}`;
    let status = 'COMPLETED';
    if (i % 5 === 0) status = 'PENDING';
    if (i % 17 === 0) status = 'RUNNING';
    if (i % 23 === 0) status = 'FAILED';
    tasks.push(task(id, status, status === 'FAILED' ? { failure: { kind: 'crash', reason: `r${i}`, ts: NOW } } : {}));
  }
  const run = sampleRun();
  run.decisions = Array.from({ length: 60 }, (_, i) => ({ ts: NOW, text: `decision ${i}` }));
  const c = cp.buildCheckpoint(run, tasks, NOW);
  for (const maxLines of [1, 5, 8, 12, 20, 40, 120]) {
    const text = cp.renderResume(c, { maxLines });
    const n = text.split('\n').length;
    assert.ok(n <= maxLines, `maxLines ${maxLines}: got ${n} lines`);
  }
  const text = cp.renderResume(c, { maxLines: 40 });
  assert.match(text, /Completed tasks \(\d+\): BIG-001, BIG-002/);
  assert.match(text, /not shown/);
  assert.match(text, /Next actions:/);
  // default limit
  assert.ok(cp.renderResume(c).split('\n').length <= 120);
});

test('readUtilization: fresh, missing, stale and invalid context.json', () => {
  const s = setup();
  try {
    const now = '2026-11-15T10:00:00.000Z';
    let r = cp.readUtilization(s.paths, { now, maxAgeSeconds: 600 });
    assert.deepEqual(r, { utilization: null, source: 'none', age_seconds: null });

    store.writeJson(s.paths.contextFile, { used_percentage: 42, context_window_size: 200000, ts: '2026-11-15T09:58:00.000Z' });
    r = cp.readUtilization(s.paths, { now, maxAgeSeconds: 600 });
    assert.equal(r.source, 'statusline');
    assert.equal(r.utilization, 0.42);
    assert.equal(r.used_percentage, 42);
    assert.equal(r.age_seconds, 120);

    r = cp.readUtilization(s.paths, { now, maxAgeSeconds: 60 });
    assert.equal(r.utilization, null);
    assert.equal(r.source, 'stale');
    assert.equal(r.age_seconds, 120);

    store.writeJson(s.paths.contextFile, { used_percentage: 'lots', ts: now });
    assert.equal(cp.readUtilization(s.paths, { now, maxAgeSeconds: 600 }).source, 'none');
    store.writeJson(s.paths.contextFile, { used_percentage: 10 });
    assert.equal(cp.readUtilization(s.paths, { now, maxAgeSeconds: 600 }).source, 'stale');
  } finally {
    s.done();
  }
});

test('contextAdvice: unknown, ok and over_target never claim compaction was triggered', () => {
  const u = cp.contextAdvice(null, 0.6);
  assert.equal(u.level, 'unknown');
  assert.equal(cp.contextAdvice(undefined, 0.6).level, 'unknown');
  const ok = cp.contextAdvice(0.4, 0.6);
  assert.equal(ok.level, 'ok');
  assert.match(ok.message, /40%/);
  assert.equal(cp.contextAdvice(0.6, 0.6).level, 'ok');
  const over = cp.contextAdvice(0.75, 0.6);
  assert.equal(over.level, 'over_target');
  assert.match(over.message, /75%/);
  assert.match(over.message, /cannot/);
  for (const a of [u, ok, over]) {
    assert.doesNotMatch(a.message, /trigger|was compacted|has been compacted|compacting now|compacted the/i);
    assert.equal(typeof a.message, 'string');
  }
});
